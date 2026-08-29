"use client";

import React, { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Upload,
  Sparkles,
  CheckCircle2,
  Pencil,
  X,
  Check,
  Download,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_EXPENSE_BUCKET,
  EXPENSE_BUCKETS,
  EXPENSE_DEPARTMENTS,
  expenseBucketColor,
  expenseBucketLabel,
  expenseDepartmentLabel,
} from "@/lib/expenses";
import { monthLabel } from "@/lib/expenses/monthRange";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { DriveFoldersPanel } from "./DriveFoldersPanel";
import { NeedsAttentionPanel } from "./NeedsAttentionPanel";

interface ExtractedInvoice {
  vendor: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  description: string | null;
  department: string | null;
  project_tag: string | null;
  department_confidence: number | null;
  invoice_number: string | null;
}

interface RecordedExpense {
  id: string;
  vendor: string | null;
  amount: string;
  description: string | null;
  department: string | null;
  bucket: string | null;
  /** rule | ai | manual | default — shown so a reviewer knows what they are overriding. */
  bucket_source: string | null;
  project_tag: string | null;
  invoice_number: string | null;
  file_name: string | null;
  expense_date: string | null;
  bill_url: string | null;
  created_at: string;
  submitter_name: string | null;
}

interface BulkSummary {
  imported: number;
  importedRows: { file: string; invoice_number: string | null; vendor: string | null; amount: number }[];
  skipped: { file: string; invoice_number: string | null; reason: string }[];
  errors: { file: string; reason: string }[];
  warnings: string[];
}

const inputCls =
  "w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-900 bg-white focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const labelCls =
  "block text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wider";
const monthInputCls =
  "px-2.5 py-2 rounded-xl border border-gray-200 text-xs font-medium text-gray-700 bg-white focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

const BATCH_SIZE = 5;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function ExpenseTrackerView() {
  const qc = useQueryClient();

  // Upload / extract state
  const [files, setFiles] = useState<File[]>([]);
  const [billUrl, setBillUrl] = useState<string | null>(null);
  const [billPath, setBillPath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [aiRaw, setAiRaw] = useState<ExtractedInvoice | null>(null);

  // Review form state (single-file flow)
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState<string>(EXPENSE_DEPARTMENTS[0].value);
  const [projectTag, setProjectTag] = useState("");
  const [lowConfidence, setLowConfidence] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Bulk import state
  const [bulkSummary, setBulkSummary] = useState<BulkSummary | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  // Month range. Drives the table AND the download, so what you export is
  // always what you are looking at. Either end may be left blank — "from" only
  // reads as onwards, "to" only as up to, neither as all time.
  const [fromMonth, setFromMonth] = useState<string>("");
  const [toMonth, setToMonth] = useState<string>("");

  const singleFile = files.length === 1 ? files[0] : null;

  // Project tags for the selected department (datalist suggestions)
  const { data: tags = [] } = useQuery({
    queryKey: ["ai-expense-tags", department],
    queryFn: async () => {
      const r = await fetch(
        `/api/admin/ai-expenses/project-tags?department=${encodeURIComponent(department)}`,
        { cache: "no-store" },
      );
      if (!r.ok) return [] as string[];
      const j = await r.json();
      return (j.data || []) as string[];
    },
  });

  const rangeQs = useMemo(() => {
    const p = new URLSearchParams();
    if (fromMonth) p.set("from", fromMonth);
    if (toMonth) p.set("to", toMonth);
    return p.toString();
  }, [fromMonth, toMonth]);

  const hasRange = Boolean(fromMonth || toMonth);

  const rangeLabel = useMemo(() => {
    if (fromMonth && toMonth) {
      return fromMonth === toMonth
        ? monthLabel(fromMonth)
        : `${monthLabel(fromMonth)} – ${monthLabel(toMonth)}`;
    }
    if (fromMonth) return `${monthLabel(fromMonth)} onwards`;
    if (toMonth) return `up to ${monthLabel(toMonth)}`;
    return "all time";
  }, [fromMonth, toMonth]);

  // Recorded AI expenses table. The range is part of the key, so the server
  // does the filtering — the list is capped by recency, and filtering these
  // rows in the browser would report an older month as empty just because its
  // rows fell off the end.
  const {
    data: listing,
    isLoading: recordedLoading,
    isFetching: recordedFetching,
  } = useQuery({
    queryKey: ["ai-expenses", "list", rangeQs],
    queryFn: async () => {
      const r = await fetch(
        `/api/admin/ai-expenses${rangeQs ? `?${rangeQs}` : ""}`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Failed to load expenses");
      return {
        rows: (j.data || []) as RecordedExpense[],
        capped: Boolean(j.meta?.capped),
        limit: Number(j.meta?.limit ?? 0),
      };
    },
    // Keep the old rows on screen while a new range loads, so changing the
    // filter never flashes an empty table.
    placeholderData: (prev) => prev,
  });

  const recorded = useMemo(() => listing?.rows ?? [], [listing]);

  const rangeTotal = useMemo(
    () => recorded.reduce((sum, r) => sum + Number(r.amount || 0), 0),
    [recorded],
  );

  // Downloading zips every bill in the range, so it stays off until there is
  // both a range and something in it.
  const canDownload = hasRange && recorded.length > 0;

  const extractMutation = useMutation({
    mutationFn: async () => {
      if (!singleFile) throw new Error("Choose an invoice file first.");
      const fd = new FormData();
      fd.set("file", singleFile);
      const r = await fetch("/api/admin/ai-expenses/extract", {
        method: "POST",
        body: fd,
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Extraction failed");
      return j.data as {
        bill_url: string;
        bill_storage_path: string;
        file_name: string;
        extracted: ExtractedInvoice;
      };
    },
    onMutate: () => {
      setError(null);
      setSuccess(null);
    },
    onSuccess: (data) => {
      const ex = data.extracted;
      setBillUrl(data.bill_url);
      setBillPath(data.bill_storage_path);
      setFileName(data.file_name);
      setAiRaw(ex);
      setVendor(ex.vendor ?? "");
      setAmount(ex.amount != null ? String(ex.amount) : "");
      setInvoiceNumber(ex.invoice_number ?? "");
      setExpenseDate(ex.date ?? "");
      setDescription(ex.description ?? "");
      if (ex.department) setDepartment(ex.department);
      setProjectTag(ex.project_tag ?? "");
      setLowConfidence(
        ex.department_confidence != null && ex.department_confidence < 0.5,
      );
      setHasDraft(true);
    },
    onError: (e: Error) => setError(e.message),
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!amount) throw new Error("Amount is required.");
      const r = await fetch("/api/admin/ai-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor: vendor || null,
          amount,
          invoice_number: invoiceNumber || null,
          file_name: fileName,
          expense_date: expenseDate || null,
          description: description || null,
          department,
          project_tag: projectTag || null,
          bill_url: billUrl,
          bill_storage_path: billPath,
          ai_raw: aiRaw,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) {
        if (r.status === 409) throw new Error(j?.error?.message || "This invoice is already recorded.");
        const detail = j?.error?.details?.[0]?.message;
        throw new Error(detail || j?.error?.message || "Submit failed");
      }
      return j as { department_note?: string | null };
    },
    onSuccess: (j) => {
      // E-229 — a vendor rule may have overridden the department on the way in
      // (a Trontek invoice is Operations spend however the form was filled).
      // Say so here; the alternative is the reviewer meeting the change on the
      // CEO dashboard with no idea what moved it.
      setSuccess(
        [
          "Expense recorded — reflected on the CEO dashboard.",
          j?.department_note,
        ]
          .filter(Boolean)
          .join(" "),
      );
      resetForm();
      qc.invalidateQueries({ queryKey: ["ai-expenses"] });
      qc.invalidateQueries({ queryKey: ["ai-expense-tags"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const bulkMutation = useMutation({
    mutationFn: async () => {
      const batches = chunk(files, BATCH_SIZE);
      const agg: BulkSummary = {
        imported: 0,
        importedRows: [],
        skipped: [],
        errors: [],
        warnings: [],
      };
      setBulkProgress({ done: 0, total: files.length });
      let done = 0;
      for (const batch of batches) {
        const fd = new FormData();
        for (const f of batch) fd.append("files", f);
        const r = await fetch("/api/admin/ai-expenses/bulk", { method: "POST", body: fd });
        const j = await r.json();
        if (!r.ok || !j.success) {
          agg.errors.push(...batch.map((f) => ({ file: f.name, reason: j?.error?.message || "Batch failed" })));
        } else {
          const d = j.data as BulkSummary;
          agg.imported += d.imported;
          agg.importedRows.push(...d.importedRows);
          agg.skipped.push(...d.skipped);
          agg.errors.push(...d.errors);
          agg.warnings.push(...d.warnings);
        }
        done += batch.length;
        setBulkProgress({ done, total: files.length });
      }
      return agg;
    },
    onMutate: () => {
      setError(null);
      setSuccess(null);
      setBulkSummary(null);
    },
    onSuccess: (agg) => {
      setBulkSummary(agg);
      setFiles([]);
      setBulkProgress(null);
      qc.invalidateQueries({ queryKey: ["ai-expenses"] });
      qc.invalidateQueries({ queryKey: ["ai-expense-tags"] });
    },
    onError: (e: Error) => {
      setError(e.message);
      setBulkProgress(null);
    },
  });

  function resetForm() {
    setFiles([]);
    setBillUrl(null);
    setBillPath(null);
    setFileName(null);
    setAiRaw(null);
    setVendor("");
    setAmount("");
    setInvoiceNumber("");
    setExpenseDate("");
    setDescription("");
    setProjectTag("");
    setLowConfidence(false);
    setHasDraft(false);
  }

  function downloadRange() {
    if (!canDownload) return;
    window.location.href = `/api/admin/ai-expenses/export?${rangeQs}`;
  }

  const isBulk = files.length > 1;

  return (
    <div className="space-y-8">
      {/* E-216 — automated Drive ingestion. Above the manual uploader because
          it is now the main way invoices arrive; the uploader is the exception
          for a bill that never made it into a folder. */}
      <DriveFoldersPanel />

      {/* E-216 — anything imported that a human still needs to look at. Renders
          nothing at all when the queue is empty. */}
      <NeedsAttentionPanel />

      {/* Upload + extract */}
      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-gray-300 bg-gray-50 hover:bg-gray-100 text-sm font-medium text-gray-700">
            <Upload className="w-4 h-4" />
            {files.length === 0
              ? "Choose invoice(s) — PDF or image"
              : files.length === 1
                ? files[0].name
                : `${files.length} files selected`}
            <input
              type="file"
              className="hidden"
              multiple
              accept="application/pdf,image/*"
              onChange={(e) => {
                setFiles(Array.from(e.target.files ?? []));
                setHasDraft(false);
                setBulkSummary(null);
              }}
            />
          </label>

          {!isBulk && (
            <Button
              type="button"
              onClick={() => extractMutation.mutate()}
              disabled={!singleFile || extractMutation.isPending}
              className="bg-brand-600 hover:bg-brand-700 text-white"
            >
              {extractMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 mr-2" />
              )}
              Extract with AI
            </Button>
          )}

          {isBulk && (
            <Button
              type="button"
              onClick={() => bulkMutation.mutate()}
              disabled={bulkMutation.isPending}
              className="bg-brand-600 hover:bg-brand-700 text-white"
            >
              {bulkMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Layers className="w-4 h-4 mr-2" />
              )}
              Bulk import {files.length} invoices
            </Button>
          )}
        </div>

        {bulkProgress && (
          <p className="text-xs font-medium text-gray-500 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Processing {bulkProgress.done}/{bulkProgress.total} invoices…
          </p>
        )}

        {bulkSummary && <BulkSummaryPanel summary={bulkSummary} />}

        {hasDraft && !isBulk && (
          <form
            className="space-y-5 pt-2 border-t border-gray-100"
            onSubmit={(e) => {
              e.preventDefault();
              submitMutation.mutate();
            }}
          >
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-700 uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" /> AI-filled draft — review before submitting
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className={labelCls}>Invoice #</label>
                <input
                  className={inputCls}
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="e.g. INV-2026-0042"
                />
              </div>
              <div>
                <label className={labelCls}>Vendor</label>
                <input className={inputCls} value={vendor} onChange={(e) => setVendor(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Amount (₹)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className={inputCls}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className={labelCls}>Date</label>
                <input
                  type="date"
                  className={inputCls}
                  value={expenseDate}
                  onChange={(e) => setExpenseDate(e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>
                  Department
                  {lowConfidence && (
                    <span className="ml-2 normal-case text-amber-600">· low AI confidence, please check</span>
                  )}
                </label>
                <select
                  className={`${inputCls} ${lowConfidence ? "border-amber-300 ring-2 ring-amber-100" : ""}`}
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                >
                  {EXPENSE_DEPARTMENTS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Project Tag</label>
                <input
                  className={inputCls}
                  value={projectTag}
                  list="ai-expense-tag-options"
                  placeholder="e.g. AI Caller"
                  onChange={(e) => setProjectTag(e.target.value)}
                />
                <datalist id="ai-expense-tag-options">
                  {tags.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
              <div className="md:col-span-2">
                <label className={labelCls}>Description</label>
                <input
                  className={inputCls}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              {billUrl ? (
                <a
                  href={billUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-brand-600 hover:underline"
                >
                  View uploaded bill{fileName ? ` · ${fileName}` : ""}
                </a>
              ) : (
                <span />
              )}
              <Button
                type="submit"
                disabled={submitMutation.isPending}
                className="bg-brand-600 hover:bg-brand-700 text-white px-6"
              >
                {submitMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Submit Expense
              </Button>
            </div>
          </form>
        )}

        {error && (
          <div className="p-3 rounded-xl bg-rose-50 border border-rose-100 text-xs font-medium text-rose-700">
            {error}
          </div>
        )}
        {success && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-100 text-xs font-medium text-emerald-700 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" />
            {success}
          </div>
        )}
      </div>

      {/* Recorded expenses */}
      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            Recorded AI Expenses
            {!recordedLoading && (
              <span className="text-[11px] font-medium text-gray-400">
                {recorded.length} {recorded.length === 1 ? "invoice" : "invoices"}
                {recorded.length > 0 && (
                  <span title={formatINRExact(rangeTotal)}> · {formatINRCompact(rangeTotal)}</span>
                )}
                {hasRange && ` · ${rangeLabel}`}
              </span>
            )}
            {recordedFetching && !recordedLoading && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-300" />
            )}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <input
                type="month"
                aria-label="From month"
                className={monthInputCls}
                value={fromMonth}
                // Keeps the picker from offering an end before the start; the
                // server swaps them anyway, this just avoids the dead state.
                max={toMonth || undefined}
                onChange={(e) => setFromMonth(e.target.value)}
              />
              <span className="text-[11px] font-medium text-gray-400">to</span>
              <input
                type="month"
                aria-label="To month"
                className={monthInputCls}
                value={toMonth}
                min={fromMonth || undefined}
                onChange={(e) => setToMonth(e.target.value)}
              />
            </div>
            {hasRange && (
              <button
                type="button"
                onClick={() => {
                  setFromMonth("");
                  setToMonth("");
                }}
                className="text-[11px] font-semibold text-gray-400 hover:text-gray-600 px-1"
                title="Clear the range and show everything"
              >
                Clear
              </button>
            )}
            <Button
              type="button"
              onClick={downloadRange}
              disabled={!canDownload}
              className="bg-brand-600 hover:bg-brand-700 text-white"
              title={
                canDownload
                  ? `Download Excel + invoice PDFs for ${rangeLabel}`
                  : hasRange
                    ? "No records in this range to download"
                    : "Pick a month or range to download"
              }
            >
              <Download className="w-4 h-4 mr-2" />
              Download
            </Button>
          </div>
        </div>
        {recordedLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
          </div>
        ) : recorded.length === 0 ? (
          <p className="text-xs text-gray-400 italic">
            {hasRange
              ? `No AI expenses in ${rangeLabel}.`
              : "No AI expenses recorded yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                  <th className="py-2 font-semibold">Date</th>
                  <th className="py-2 font-semibold">Invoice #</th>
                  <th className="py-2 font-semibold">Vendor</th>
                  <th className="py-2 font-semibold">Amount</th>
                  <th className="py-2 font-semibold">Department</th>
                  <th className="py-2 font-semibold">Bucket</th>
                  <th className="py-2 font-semibold">Project</th>
                  <th className="py-2 font-semibold">File</th>
                  <th className="py-2 font-semibold">Bill</th>
                  <th className="py-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {recorded.map((row) => (
                  <RecordedRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
            {listing?.capped && (
              // Without this the count and total above read as the whole
              // range, when they are only its most recent slice.
              <p className="mt-3 text-[11px] font-medium text-amber-700">
                Showing the {listing.limit} most recent records
                {hasRange ? ` in ${rangeLabel}` : ""} — narrow the range to see the rest.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BulkSummaryPanel({ summary }: { summary: BulkSummary }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-xs font-semibold">
        <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100">
          Imported {summary.imported}
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-100">
          Skipped {summary.skipped.length} (duplicates)
        </span>
        <span className="px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 border border-rose-100">
          Errors {summary.errors.length}
        </span>
      </div>
      {summary.skipped.length > 0 && (
        <details className="text-[11px] text-gray-600">
          <summary className="cursor-pointer font-semibold text-amber-700">
            Skipped duplicates ({summary.skipped.length})
          </summary>
          <ul className="mt-1 ml-4 list-disc space-y-0.5">
            {summary.skipped.map((s, i) => (
              <li key={i}>
                {s.file}
                {s.invoice_number ? ` · ${s.invoice_number}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.errors.length > 0 && (
        <details className="text-[11px] text-gray-600">
          <summary className="cursor-pointer font-semibold text-rose-700">
            Errors ({summary.errors.length})
          </summary>
          <ul className="mt-1 ml-4 list-disc space-y-0.5">
            {summary.errors.map((e, i) => (
              <li key={i}>
                {e.file} — {e.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.warnings.length > 0 && (
        <details className="text-[11px] text-gray-600">
          <summary className="cursor-pointer font-semibold text-gray-500">
            Notes ({summary.warnings.length})
          </summary>
          <ul className="mt-1 ml-4 list-disc space-y-0.5">
            {summary.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RecordedRow({ row }: { row: RecordedExpense }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [dept, setDept] = useState(row.department ?? EXPENSE_DEPARTMENTS[0].value);
  // E-218 — falls back to the default bucket rather than the first one, so
  // saving without touching the field cannot silently reclassify an
  // unclassified row as "Tech".
  const [bucket, setBucket] = useState(row.bucket ?? DEFAULT_EXPENSE_BUCKET);
  const [tag, setTag] = useState(row.project_tag ?? "");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/ai-expenses/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Sending `bucket` marks it bucket_source='manual' server-side, which
        // is what protects it from the backfill — so only send it when the
        // reviewer actually changed it.
        body: JSON.stringify({
          department: dept,
          project_tag: tag || null,
          ...(bucket !== row.bucket ? { bucket } : {}),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Update failed");
      return j;
    },
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["ai-expenses"] });
    },
  });

  return (
    <tr className="border-b border-gray-50">
      <td className="py-3 text-xs text-gray-600">
        {row.expense_date
          ? new Date(row.expense_date).toLocaleDateString("en-IN")
          : new Date(row.created_at).toLocaleDateString("en-IN")}
      </td>
      <td className="py-3 text-xs font-mono text-gray-700">{row.invoice_number || "—"}</td>
      <td className="py-3 text-xs font-semibold text-gray-900">{row.vendor || "—"}</td>
      <td className="py-3 text-xs font-bold text-gray-900">
        ₹{Number(row.amount).toLocaleString("en-IN")}
      </td>
      <td className="py-3 text-xs">
        {editing ? (
          <select
            className="px-2 py-1 rounded-lg border border-gray-200 text-xs"
            value={dept}
            onChange={(e) => setDept(e.target.value)}
          >
            {EXPENSE_DEPARTMENTS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-medium text-gray-700">{expenseDepartmentLabel(row.department)}</span>
        )}
      </td>
      <td className="py-3 text-xs">
        {editing ? (
          <select
            className="px-2 py-1 rounded-lg border border-gray-200 text-xs"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
          >
            {EXPENSE_BUCKETS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 font-medium text-gray-700"
            title={
              row.bucket_source
                ? `Set by: ${row.bucket_source}`
                : "Not classified yet — run the E-218 backfill"
            }
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: expenseBucketColor(row.bucket) }}
            />
            {expenseBucketLabel(row.bucket)}
            {row.bucket_source === "manual" && (
              <span className="text-[9px] uppercase tracking-wider text-brand-600 font-bold">
                fixed
              </span>
            )}
          </span>
        )}
      </td>
      <td className="py-3 text-xs">
        {editing ? (
          <input
            className="px-2 py-1 rounded-lg border border-gray-200 text-xs w-32"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Project tag"
          />
        ) : (
          <span className="text-gray-700">{row.project_tag || "—"}</span>
        )}
      </td>
      <td className="py-3 text-xs text-gray-500 max-w-[140px] truncate" title={row.file_name || undefined}>
        {row.file_name || "—"}
      </td>
      <td className="py-3 text-xs">
        {row.bill_url ? (
          <a href={row.bill_url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline font-semibold">
            View
          </a>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
      <td className="py-3 text-xs text-right">
        {editing ? (
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="text-emerald-600 hover:text-emerald-700"
              title="Save"
            >
              {saveMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDept(row.department ?? EXPENSE_DEPARTMENTS[0].value);
                setBucket(row.bucket ?? DEFAULT_EXPENSE_BUCKET);
                setTag(row.project_tag ?? "");
              }}
              className="text-gray-400 hover:text-gray-600"
              title="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="text-gray-400 hover:text-brand-600 inline-flex items-center gap-1"
            title="Edit department / bucket / tag"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </td>
    </tr>
  );
}
