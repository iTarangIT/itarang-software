"use client";

import React, { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Receipt,
  Download,
  Search,
  RefreshCw,
  CloudDownload,
  CloudOff,
  AlertTriangle,
  FileText,
  IndianRupee,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS = [
  "draft",
  "sent",
  "overdue",
  "paid",
  "partially_paid",
  "void",
] as const;

// E-280 — one row of the UNION of zoho_invoices and the sales invoices read out
// of Google Drive. `source` says which side it came from; everything else is
// normalised by src/lib/dashboard/revenueSource.ts.
interface InvoiceRow {
  source: "zoho" | "drive";
  id: string;
  invoice_number: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  total: string | null;
  balance: string | null;
  status: string | null;
  payment_reference: string | null;
  /** Zoho PDF passthrough, or the stored copy of the Drive original. */
  document_url: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
}

interface ApiResponse {
  success: boolean;
  data: InvoiceRow[];
  summary: { count: number; total: number; balance: number };
  filters: { from: string; to: string };
  sources: { zoho: boolean; drive: boolean };
}

function startOfMonthISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function formatINR(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function StatusBadge({ status }: { status: string | null }) {
  const s = (status || "").toLowerCase();
  const styles: Record<string, string> = {
    paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
    sent: "bg-blue-50 text-blue-700 border-blue-200",
    overdue: "bg-rose-50 text-rose-700 border-rose-200",
    draft: "bg-gray-50 text-gray-600 border-gray-200",
    partially_paid: "bg-amber-50 text-amber-700 border-amber-200",
    void: "bg-gray-100 text-gray-500 border-gray-300",
  };
  const cls = styles[s] || "bg-gray-50 text-gray-600 border-gray-200";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${cls}`}
    >
      {s || "—"}
    </span>
  );
}

function SourceBadge({ source }: { source: "zoho" | "drive" }) {
  const drive = source === "drive";
  return (
    <span
      data-testid={`source-${source}`}
      title={
        drive
          ? "Read from the Google Drive invoice folder"
          : "Synced from the Zoho Invoice API before the move to Vyapar"
      }
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${
        drive
          ? "bg-indigo-50 text-indigo-700 border-indigo-200"
          : "bg-slate-50 text-slate-600 border-slate-200"
      }`}
    >
      {drive ? "Drive" : "Zoho"}
    </span>
  );
}

export default function CEOInvoicesPage() {
  const [from, setFrom] = useState(startOfMonthISO());
  const [to, setTo] = useState(todayISO());
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [customer, setCustomer] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("from", from);
    p.set("to", to);
    if (selectedStatuses.length > 0) p.set("status", selectedStatuses.join(","));
    if (customer.trim()) p.set("customer", customer.trim());
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(page * PAGE_SIZE));
    return p.toString();
  }, [from, to, selectedStatuses, customer, page]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["ceo-invoices", queryString],
    queryFn: async () => {
      const r = await fetch(`/api/dashboard/ceo/invoices?${queryString}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Failed to load invoices");
      return (await r.json()) as ApiResponse;
    },
  });

  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/zoho/sync", { method: "POST" });
      const json = await r.json();
      if (!r.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Sync failed");
      }
      return json as { upserted: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ceo-invoices"] });
    },
  });

  // E-280 — pull anything newly filed in Drive. Deliberately separate from the
  // Zoho refresh above: they read different systems and either can be stale on
  // its own.
  const scanDrive = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/sales-invoices/drive/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await r.json();
      if (!r.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Drive scan failed");
      }
      return json.data as {
        status: string;
        files_seen: number;
        files_new: number;
        imported: number;
        skipped_duplicate: number;
        needs_attention: number;
        failed: number;
        skipped_reason?: string;
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ceo-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
    },
  });

  // Collection is CRM-owned for Drive invoices: the PDF only carries a balance
  // printed at issue time. A Zoho row is refused by the API, so the control is
  // not offered for one.
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payRef, setPayRef] = useState("");

  const recordPayment = useMutation({
    mutationFn: async (args: { id: string; amount: number; reference: string }) => {
      const r = await fetch(`/api/dashboard/ceo/invoices/${args.id}/payment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_paid: args.amount,
          payment_reference: args.reference.trim() || null,
        }),
      });
      const json = await r.json();
      if (!r.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Could not record the payment");
      }
      return json.data;
    },
    onSuccess: () => {
      setPayingId(null);
      setPayAmount("");
      setPayRef("");
      queryClient.invalidateQueries({ queryKey: ["ceo-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
    },
  });

  const rows = data?.data || [];
  const summary = data?.summary;
  const scanResult = scanDrive.data;
  // False when sales_invoices is absent (E-280 not applied on this database).
  // Worth saying out loud: the page otherwise looks like a working Zoho-only
  // view, and "no Drive invoices" reads as "none imported yet" rather than
  // "this environment cannot see them at all".
  const driveUnavailable = data ? data.sources?.drive === false : false;

  const toggleStatus = (s: string) => {
    setSelectedStatuses((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
    setPage(0);
  };

  const exportCsv = () => {
    const p = new URLSearchParams();
    p.set("from", from);
    p.set("to", to);
    if (selectedStatuses.length > 0) p.set("status", selectedStatuses.join(","));
    if (customer.trim()) p.set("customer", customer.trim());
    p.set("format", "csv");
    const a = document.createElement("a");
    a.href = `/api/dashboard/ceo/invoices?${p.toString()}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="space-y-6 pb-12">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
          <Receipt className="w-6 h-6 text-brand-600" />
          Sales Invoices
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Zoho invoices up to the move to Vyapar, and everything filed in Google
          Drive since. One row per invoice — no line-item duplication.
        </p>
      </div>

      {/* Filters */}
      <div className="p-5 rounded-2xl bg-white border border-gray-100 shadow-sm space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
              From
            </label>
            <input
              data-testid="filter-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(0);
              }}
              className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
              To
            </label>
            <input
              data-testid="filter-to"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(0);
              }}
              className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
              Customer search
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                data-testid="filter-customer"
                type="text"
                value={customer}
                onChange={(e) => {
                  setCustomer(e.target.value);
                  setPage(0);
                }}
                placeholder="Filter by customer name"
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mr-1">
              Status:
            </span>
            {STATUS_OPTIONS.map((s) => {
              const active = selectedStatuses.includes(s);
              return (
                <button
                  key={s}
                  data-testid={`status-chip-${s}`}
                  data-active={active ? "true" : "false"}
                  onClick={() => toggleStatus(s)}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-colors ${
                    active
                      ? "bg-brand-600 text-white border-brand-600"
                      : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {s.replace("_", " ")}
                </button>
              );
            })}
            {selectedStatuses.length > 0 && (
              <button
                data-testid="clear-statuses"
                onClick={() => {
                  setSelectedStatuses([]);
                  setPage(0);
                }}
                className="ml-1 text-[10px] font-semibold text-rose-600 hover:underline"
              >
                clear
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {refresh.isError && (
              <span
                data-testid="refresh-error"
                className="text-[11px] font-semibold text-rose-600"
              >
                {(refresh.error as Error).message}
              </span>
            )}
            {scanDrive.isError && (
              <span
                data-testid="scan-error"
                className="text-[11px] font-semibold text-rose-600"
              >
                {(scanDrive.error as Error).message}
              </span>
            )}
            <Button
              data-testid="refresh-zoho"
              variant="outline"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              className="flex items-center gap-2 border-brand-200 text-brand-700 hover:bg-brand-50"
            >
              <RefreshCw
                className={cn("w-4 h-4", refresh.isPending && "animate-spin")}
              />
              {refresh.isPending ? "Refreshing…" : "Refresh from Zoho"}
            </Button>
            <Button
              data-testid="scan-drive"
              variant="outline"
              onClick={() => scanDrive.mutate()}
              disabled={scanDrive.isPending}
              className="flex items-center gap-2 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
            >
              <CloudDownload
                className={cn("w-4 h-4", scanDrive.isPending && "animate-pulse")}
              />
              {scanDrive.isPending ? "Scanning Drive…" : "Scan Drive"}
            </Button>
            <Button
              data-testid="export-csv"
              variant="outline"
              onClick={exportCsv}
              className="flex items-center gap-2 border-brand-200 text-brand-700 hover:bg-brand-50"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </Button>
          </div>
        </div>
      </div>

      {driveUnavailable && (
        <div
          data-testid="drive-unavailable"
          className="flex items-start gap-2 p-4 rounded-2xl bg-amber-50 border border-amber-200 text-sm text-amber-900"
        >
          <CloudOff className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Showing Zoho invoices only — the Drive invoice table does not exist on this
            database yet. Apply{" "}
            <code className="font-mono text-xs">
              drizzle/E-280_drive_sales_invoices.sql
            </code>{" "}
            to include invoices filed since the move to Vyapar.
          </span>
        </div>
      )}

      {/* E-280 — the scan's own counters, not a bare "done". A scan that saw 135
          files and imported 0 is either "nothing new" or "everything is broken",
          and only the breakdown says which. */}
      {scanResult && (
        <div
          data-testid="scan-summary"
          className="p-4 rounded-2xl bg-indigo-50/50 border border-indigo-100 text-sm text-indigo-900"
        >
          {scanResult.status === "skipped" ? (
            <span>Drive scan skipped — {scanResult.skipped_reason}</span>
          ) : (
            <span>
              Drive scan: saw <b>{scanResult.files_seen}</b> file(s), processed{" "}
              <b>{scanResult.files_new}</b> new, imported <b>{scanResult.imported}</b>,{" "}
              <b>{scanResult.skipped_duplicate}</b> already recorded,{" "}
              <b>{scanResult.needs_attention}</b> need attention,{" "}
              <b>{scanResult.failed}</b> failed.
            </span>
          )}
        </div>
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-4">
        <div className="p-4 rounded-2xl bg-white border border-gray-100 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Invoices in view
          </p>
          <p data-testid="summary-count" data-count={summary?.count ?? ""} className="text-2xl font-bold text-gray-900 mt-1">{summary?.count ?? "—"}</p>
        </div>
        <div className="p-4 rounded-2xl bg-emerald-50/40 border border-emerald-100 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700/70">
            Total Invoiced
          </p>
          <p data-testid="summary-total" data-total={summary?.total ?? ""} className="text-2xl font-bold text-emerald-900 mt-1">
            {summary ? formatINR(summary.total) : "—"}
          </p>
        </div>
        <div className="p-4 rounded-2xl bg-amber-50/40 border border-amber-100 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700/70">
            Outstanding Balance
          </p>
          <p data-testid="summary-balance" data-balance={summary?.balance ?? ""} className="text-2xl font-bold text-amber-900 mt-1">
            {summary ? formatINR(summary.balance) : "—"}
          </p>
        </div>
      </div>

      {/* Table */}
      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
        {isLoading ? (
          <div data-testid="loading-state" className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <p data-testid="error-state" className="text-sm text-rose-600 py-6 text-center">
            {(error as Error).message}
          </p>
        ) : rows.length === 0 ? (
          <p data-testid="empty-state" className="text-sm text-gray-400 italic py-6 text-center">
            No invoices match these filters.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table data-testid="invoice-table" className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                    <th className="py-2 font-semibold">Invoice #</th>
                    <th className="py-2 font-semibold">Source</th>
                    <th className="py-2 font-semibold">Date</th>
                    <th className="py-2 font-semibold">Customer</th>
                    <th className="py-2 font-semibold">Status</th>
                    <th className="py-2 font-semibold">Transaction ID</th>
                    <th className="py-2 font-semibold text-right">Total</th>
                    <th className="py-2 font-semibold text-right">Balance</th>
                    <th className="py-2 font-semibold text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <React.Fragment key={`${r.source}:${r.id}`}>
                      <tr
                        data-testid="invoice-row"
                        data-status={r.status ?? ""}
                        data-source={r.source}
                        className="border-b border-gray-50"
                      >
                        <td className="py-3 text-xs font-semibold text-gray-900">
                          <span className="inline-flex items-center gap-1.5">
                            {r.document_url ? (
                              <a
                                href={r.document_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-brand-700 hover:underline inline-flex items-center gap-1"
                              >
                                <FileText className="w-3 h-3" />
                                {r.invoice_number || "—"}
                              </a>
                            ) : (
                              r.invoice_number || "—"
                            )}
                            {r.needs_attention && (
                              <span
                                data-testid="invoice-attention"
                                title={r.attention_reason ?? "Needs checking"}
                                className="inline-flex"
                              >
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="py-3">
                          <SourceBadge source={r.source} />
                        </td>
                        <td className="py-3 text-xs text-gray-600">
                          {r.invoice_date || "—"}
                        </td>
                        <td className="py-3 text-xs text-gray-900 max-w-xs truncate">
                          {r.customer_name || "—"}
                        </td>
                        <td className="py-3">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="py-3 text-xs text-gray-600 font-mono">
                          {r.payment_reference || "—"}
                        </td>
                        <td className="py-3 text-xs font-bold text-gray-900 text-right">
                          {formatINR(Number(r.total || 0))}
                        </td>
                        <td className="py-3 text-xs font-bold text-amber-700 text-right">
                          {formatINR(Number(r.balance || 0))}
                        </td>
                        <td className="py-3 text-right">
                          {/* Drive rows only: a Zoho invoice's payment state is
                              rewritten by the hourly sync, so anything recorded
                              here would silently vanish within the hour. */}
                          {r.source === "drive" && r.status !== "void" && (
                            <button
                              data-testid="record-payment"
                              onClick={() => {
                                const opening = payingId !== r.id;
                                setPayingId(opening ? r.id : null);
                                setPayAmount(opening ? String(Number(r.total || 0)) : "");
                                setPayRef(opening ? (r.payment_reference ?? "") : "");
                                recordPayment.reset();
                              }}
                              className="text-[10px] font-bold uppercase tracking-wider text-brand-700 hover:underline whitespace-nowrap"
                            >
                              {payingId === r.id ? "Cancel" : "Payment"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {payingId === r.id && (
                        <tr data-testid="payment-editor" className="bg-brand-50/40">
                          <td colSpan={9} className="py-3 px-2">
                            <div className="flex flex-wrap items-end gap-3">
                              <div>
                                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                                  Collected so far
                                </label>
                                <div className="relative">
                                  <IndianRupee className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                                  <input
                                    data-testid="payment-amount"
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={payAmount}
                                    onChange={(e) => setPayAmount(e.target.value)}
                                    className="w-40 pl-7 pr-2 py-1.5 rounded-lg border border-gray-200 text-sm"
                                  />
                                </div>
                                <p className="text-[10px] text-gray-500 mt-1">
                                  Running total against {formatINR(Number(r.total || 0))}, not an
                                  added payment.
                                </p>
                              </div>
                              <div>
                                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                                  Reference / UTR
                                </label>
                                <input
                                  data-testid="payment-reference"
                                  type="text"
                                  value={payRef}
                                  onChange={(e) => setPayRef(e.target.value)}
                                  placeholder="Optional"
                                  className="w-56 px-2 py-1.5 rounded-lg border border-gray-200 text-sm"
                                />
                              </div>
                              <Button
                                data-testid="payment-save"
                                size="sm"
                                disabled={recordPayment.isPending || payAmount === ""}
                                onClick={() =>
                                  recordPayment.mutate({
                                    id: r.id,
                                    amount: Number(payAmount),
                                    reference: payRef,
                                  })
                                }
                              >
                                {recordPayment.isPending ? "Saving…" : "Save"}
                              </Button>
                              {recordPayment.isError && (
                                <span
                                  data-testid="payment-error"
                                  className="text-[11px] font-semibold text-rose-600"
                                >
                                  {(recordPayment.error as Error).message}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {summary && summary.count > PAGE_SIZE && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-50">
                <p className="text-xs text-gray-500">
                  Showing {page * PAGE_SIZE + 1}–
                  {Math.min((page + 1) * PAGE_SIZE, summary.count)} of {summary.count}
                </p>
                <div className="flex gap-2">
                  <Button
                    data-testid="pagination-prev"
                    variant="outline"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Prev
                  </Button>
                  <Button
                    data-testid="pagination-next"
                    variant="outline"
                    size="sm"
                    disabled={(page + 1) * PAGE_SIZE >= summary.count}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
