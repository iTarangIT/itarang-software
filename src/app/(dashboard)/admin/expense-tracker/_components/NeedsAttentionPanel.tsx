"use client";

/**
 * E-214 — the needs-attention queue.
 *
 * This pipeline has no approval step, so nothing is held back waiting for a
 * human. That makes this panel the only place a doubtful import is visible,
 * and it shows two distinct populations:
 *
 *  - IMPORTED, FLAGGED (expense rows): the amount was read, so the row counts
 *    on the CEO's card right now. What is missing is a vendor, a date, an
 *    invoice number, or a confident department. Correcting one of those clears
 *    the flag automatically (the PATCH route does it).
 *
 *  - NOT IMPORTED (file rows): no amount could be read, so there is no expense
 *    row at all and this spend is currently missing from the dashboard. These
 *    are the ones that actually cost money to ignore, so they sort first.
 *
 * The distinction is spelled out in the UI rather than merged into one list,
 * because "wrong" and "absent" need different responses from the person
 * reading it.
 */

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ExternalLink, FileWarning, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EXPENSE_DEPARTMENTS } from "@/lib/expenses";

interface FlaggedExpense {
  id: string;
  vendor: string | null;
  amount: string;
  expense_date: string | null;
  department: string | null;
  invoice_number: string | null;
  file_name: string | null;
  bill_url: string | null;
  attention_reason: string | null;
}

interface AttentionFile {
  id: string;
  drive_file_name: string | null;
  mime_type: string | null;
  status: string;
  reason: string | null;
  created_at: string;
}

const inputCls =
  "w-full px-2.5 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

export function NeedsAttentionPanel() {
  const qc = useQueryClient();

  const { data: expenses, isLoading: loadingExpenses } = useQuery({
    queryKey: ["ai-expenses", "attention"],
    queryFn: async () => {
      const r = await fetch("/api/admin/ai-expenses?needs_attention=1", {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Failed to load");
      return (j.data || []) as FlaggedExpense[];
    },
  });

  const { data: files, isLoading: loadingFiles } = useQuery({
    queryKey: ["drive-attention"],
    queryFn: async () => {
      const r = await fetch("/api/admin/ai-expenses/drive/runs?view=attention", {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Failed to load");
      return (j.data?.files || []) as AttentionFile[];
    },
  });

  const flagged = expenses ?? [];
  const unreadable = files ?? [];
  const total = flagged.length + unreadable.length;

  if (loadingExpenses || loadingFiles) {
    return (
      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
        <p className="text-xs text-gray-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking for problems…
        </p>
      </div>
    );
  }

  if (total === 0) return null; // nothing to say — don't take up the screen

  return (
    <div
      className="p-6 rounded-2xl bg-white border border-amber-200 shadow-sm space-y-5"
      data-testid="needs-attention-panel"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-600" />
        <h2 className="text-sm font-semibold text-gray-900">
          Needs attention ({total})
        </h2>
      </div>

      {/* Not imported — these are missing from the dashboard entirely. */}
      {unreadable.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
            Could not be imported ({unreadable.length})
          </p>
          <p className="text-xs text-gray-500">
            No amount could be read from these files, so no expense was recorded — this
            spend is not on the dashboard. Fix the file in Drive (a clearer scan, or the
            original PDF) and it will be picked up on the next scan.
          </p>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {unreadable.map((f) => (
              <li key={f.id} className="px-4 py-3 flex items-start gap-3">
                <FileWarning className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {f.drive_file_name || "(unnamed file)"}
                  </p>
                  <p className="text-xs text-gray-600">{f.reason || "Unknown problem."}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Imported but flagged — already counting, just incomplete. */}
      {flagged.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
            Imported, but incomplete ({flagged.length})
          </p>
          <p className="text-xs text-gray-500">
            These already count towards the dashboard totals. Filling in what is missing
            clears the flag.
          </p>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {flagged.map((row) => (
              <FlaggedRow key={row.id} row={row} onSaved={() => invalidate(qc)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FlaggedRow({ row, onSaved }: { row: FlaggedExpense; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [vendor, setVendor] = useState(row.vendor ?? "");
  const [expenseDate, setExpenseDate] = useState(row.expense_date ?? "");
  const [department, setDepartment] = useState(row.department ?? "ops");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { department };
      if (vendor.trim()) body.vendor = vendor.trim();
      if (expenseDate) body.expense_date = expenseDate;
      const r = await fetch(`/api/admin/ai-expenses/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Save failed");
    },
    onSuccess: () => {
      setEditing(false);
      setError(null);
      onSaved();
    },
    onError: (e: Error) => setError(e.message),
  });

  // "The extraction was right, the flag was just cautious" — e.g. a genuine
  // cash receipt that really has no invoice number.
  const dismiss = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/admin/ai-expenses/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ needs_attention: false }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Failed");
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <li className="px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[220px]">
          <p className="text-sm font-medium text-gray-900">
            {row.vendor || "(no vendor)"} ·{" "}
            {Number(row.amount).toLocaleString("en-IN", {
              style: "currency",
              currency: "INR",
              maximumFractionDigits: 0,
            })}
          </p>
          <p className="text-xs text-gray-600">{row.attention_reason}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {row.file_name || "—"}
            {row.invoice_number ? ` · ${row.invoice_number}` : ""}
            {row.expense_date ? ` · ${row.expense_date}` : " · no date"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {row.bill_url && (
            <a
              href={row.bill_url}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded-lg text-gray-400 hover:text-brand-600 hover:bg-brand-50"
              title="Open the original document"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
          {!editing && (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                Fix
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => dismiss.mutate()}
                disabled={dismiss.isPending}
                title="The data is correct — just clear the flag"
              >
                {dismiss.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="flex flex-wrap items-end gap-3 pt-1">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[11px] font-semibold text-gray-600 mb-1">Vendor</label>
            <input
              className={inputCls}
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="Vendor name"
            />
          </div>
          <div className="min-w-[150px]">
            <label className="block text-[11px] font-semibold text-gray-600 mb-1">
              Invoice date
            </label>
            <input
              type="date"
              className={inputCls}
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
            />
          </div>
          <div className="min-w-[150px]">
            <label className="block text-[11px] font-semibold text-gray-600 mb-1">
              Department
            </label>
            <select
              className={inputCls}
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
          <Button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white"
            size="sm"
          >
            {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-red-700">{error}</p>}
    </li>
  );
}

/** Every surface that reads expense_submissions. */
function invalidate(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    ["ai-expenses"],
    ["drive-attention"],
    ["drive-runs"],
    ["dashboard-metrics", "ceo"],
    ["ceo-expenses-summary"],
    ["ceo-snapshot-summary"],
  ]) {
    qc.invalidateQueries({ queryKey: key });
  }
}
