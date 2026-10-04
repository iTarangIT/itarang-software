"use client";

import React, { useEffect, useMemo, useState } from "react";
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
  Link2,
  Ban,
  Undo2,
  UserPlus,
  X,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  readJsonBody,
  readJsonData,
  startScanAndWait,
} from "@/lib/drive/scanClient";

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
  /** R-11 — customer GSTIN (normalised) and the CRM dealer it links to. */
  gstin_key: string | null;
  dealer_lead_id: string | null;
  dealer_name: string | null;
  /** E-321 — the dealer account matched, and a hand decision if any. */
  account_id?: string | null;
  link_kind?: string | null;
  match_status?: MatchStatus;
}

type DealerMatch = "" | "linked" | "unlinked";

// Tracker ID 69 / P1-6 — the unmatched-invoices work list. Every invoice not
// credited to a salesperson carries one of these labels and an action.
type MatchStatus = "credited" | "no_owner" | "unknown" | "not_dealer";
type UnmatchedStatus = Exclude<MatchStatus, "credited">;
const UNMATCHED_STATUSES: UnmatchedStatus[] = ["unknown", "no_owner", "not_dealer"];
const MATCH_LABEL: Record<UnmatchedStatus, string> = {
  unknown: "Unknown customer",
  no_owner: "Dealer account with no owner",
  not_dealer: "Not a dealer sale",
};
type View = "all" | "unmatched";

interface AccountOption {
  id: string;
  business_entity_name: string;
  gstin: string | null;
  city: string | null;
}

interface ApiResponse {
  success: boolean;
  data: InvoiceRow[];
  summary: {
    count: number;
    total: number;
    balance: number;
    unlinked_count: number;
    unlinked_total: number;
  };
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

function MatchBadge({ status }: { status: MatchStatus | undefined }) {
  if (!status || status === "credited") return null;
  const styles: Record<UnmatchedStatus, string> = {
    unknown: "bg-rose-50 text-rose-700 border-rose-200",
    no_owner: "bg-amber-50 text-amber-700 border-amber-200",
    not_dealer: "bg-gray-50 text-gray-600 border-gray-200",
  };
  return (
    <span
      data-testid={`match-${status}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-bold whitespace-nowrap ${styles[status]}`}
    >
      {MATCH_LABEL[status]}
    </span>
  );
}

/**
 * "Link to account" — pick the dealer account an invoice belongs to. Linking
 * also records the invoice's GSTIN on the account, so the dealer's next
 * invoices match without coming back here.
 */
function LinkAccountDialog({
  invoice,
  onClose,
  onLinked,
}: {
  invoice: InvoiceRow;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [q, setQ] = useState(invoice.customer_name ?? "");
  const [debounced, setDebounced] = useState(q.trim());
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<AccountOption | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const search = useQuery({
    queryKey: ["ceo-invoices-account-search", debounced],
    queryFn: async () => {
      const r = await fetch(
        `/api/dashboard/ceo/invoices/accounts-search?q=${encodeURIComponent(debounced)}`,
        { cache: "no-store" },
      );
      return readJsonData<AccountOption[]>(r, "Could not search accounts");
    },
  });

  const link = useMutation({
    mutationFn: async (accountId: string) => {
      const r = await fetch(`/api/dashboard/ceo/invoices/${invoice.id}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: invoice.source,
          action: "link",
          account_id: accountId,
          note: note.trim() || null,
        }),
      });
      return readJsonData<{ gstin_added: string | null }>(r, "Could not link the invoice");
    },
    onSuccess: () => onLinked(),
  });

  return (
    <div
      data-testid="link-account-dialog"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-gray-900">Link to account</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {invoice.invoice_number || "—"} · {invoice.customer_name || "—"} ·{" "}
              {formatINR(Number(invoice.total || 0))}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            data-testid="account-search"
            autoFocus
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPicked(null);
            }}
            placeholder="Dealer name, GSTIN or account id"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <div className="max-h-64 overflow-y-auto rounded-xl border border-gray-100 divide-y divide-gray-50">
          {search.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          ) : search.isError ? (
            <p className="text-xs text-rose-600 p-3">{(search.error as Error).message}</p>
          ) : (search.data ?? []).length === 0 ? (
            <p className="text-xs text-gray-400 italic p-3">No dealer account matches.</p>
          ) : (
            (search.data ?? []).map((a) => (
              <button
                key={a.id}
                data-testid="account-option"
                onClick={() => setPicked(a)}
                className={cn(
                  "w-full text-left px-3 py-2 text-xs hover:bg-gray-50",
                  picked?.id === a.id && "bg-brand-50",
                )}
              >
                <div className="font-semibold text-gray-900">{a.business_entity_name}</div>
                <div className="text-[10px] text-gray-500">
                  {a.id}
                  {a.gstin ? ` · ${a.gstin}` : ""}
                  {a.city ? ` · ${a.city}` : ""}
                </div>
              </button>
            ))
          )}
        </div>

        <input
          data-testid="link-note"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm"
        />

        {invoice.gstin_key && (
          <p className="text-[11px] text-gray-500">
            GSTIN <span className="font-mono">{invoice.gstin_key}</span> will be added to the
            account, so this dealer&apos;s future invoices match on their own.
          </p>
        )}

        {link.isError && (
          <p data-testid="link-error" className="text-[11px] font-semibold text-rose-600">
            {(link.error as Error).message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="link-save"
            size="sm"
            disabled={!picked || link.isPending}
            onClick={() => picked && link.mutate(picked.id)}
          >
            {link.isPending
              ? "Linking…"
              : picked
                ? `Link to ${picked.business_entity_name}`
                : "Pick an account"}
          </Button>
        </div>
      </div>
    </div>
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
  const [dealerMatch, setDealerMatch] = useState<DealerMatch>("");
  const [view, setView] = useState<View>("all");
  const [matchFilter, setMatchFilter] = useState<UnmatchedStatus[]>(UNMATCHED_STATUSES);
  const [linking, setLinking] = useState<InvoiceRow | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("from", from);
    p.set("to", to);
    if (selectedStatuses.length > 0) p.set("status", selectedStatuses.join(","));
    if (customer.trim()) p.set("customer", customer.trim());
    if (dealerMatch) p.set("dealer_match", dealerMatch);
    if (view === "unmatched") p.set("match_status", matchFilter.join(","));
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(page * PAGE_SIZE));
    return p.toString();
  }, [from, to, selectedStatuses, customer, dealerMatch, view, matchFilter, page]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["ceo-invoices", queryString],
    queryFn: async () => {
      const r = await fetch(`/api/dashboard/ceo/invoices?${queryString}`, {
        cache: "no-store",
      });
      return readJsonBody<ApiResponse>(r, "Failed to load invoices");
    },
  });

  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/zoho/sync", { method: "POST" });
      return readJsonBody<{ upserted: number }>(r, "Sync failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ceo-invoices"] });
    },
  });

  // E-280 — pull anything newly filed in Drive. Deliberately separate from the
  // Zoho refresh above: they read different systems and either can be stale on
  // its own.
  //
  // The scan runs in the background and this follows it by polling. A real scan
  // takes minutes, and a browser holding a multi-minute connection open gets
  // nginx's HTML error page the moment the app restarts under it — which on
  // sandbox is every deploy. The counters, and the run's own reason for
  // stopping, come back the same either way. See src/lib/drive/scanClient.ts.
  const scanDrive = useMutation({
    mutationFn: () =>
      startScanAndWait({
        scanEndpoint: "/api/admin/sales-invoices/drive/scan",
        statusEndpoint: "/api/admin/sales-invoices/drive/scan",
      }),
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
      return readJsonData(r, "Could not record the payment");
    },
    onSuccess: () => {
      setPayingId(null);
      setPayAmount("");
      setPayRef("");
      queryClient.invalidateQueries({ queryKey: ["ceo-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
    },
  });

  // Tracker ID 69 — "Not a dealer sale" and "Undo" on the work list. Linking
  // goes through LinkAccountDialog.
  const decide = useMutation({
    mutationFn: async (args: { row: InvoiceRow; action: "not_dealer" | "clear" }) => {
      const r = await fetch(`/api/dashboard/ceo/invoices/${args.row.id}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: args.row.source, action: args.action }),
      });
      return readJsonData(r, "Could not save the decision");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ceo-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
    },
  });

  const rows = data?.data || [];
  const summary = data?.summary;
  const unmatchedView = view === "unmatched";
  const colCount = unmatchedView ? 10 : 9;
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
    if (view === "unmatched") p.set("match_status", matchFilter.join(","));
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

      {/* Tracker ID 69 — the unmatched-invoices work list is a preset over the
          same table: every invoice not credited to a salesperson. */}
      <div className="flex items-center gap-1 rounded-xl bg-gray-100 p-1 w-fit">
        {(
          [
            ["all", "All invoices"],
            ["unmatched", "Unmatched"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            data-testid={`view-${v}`}
            data-active={view === v ? "true" : "false"}
            onClick={() => {
              setView(v);
              setPage(0);
            }}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors",
              view === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800",
            )}
          >
            {label}
          </button>
        ))}
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

      {/* A scan is minutes of work now that it actually reads invoices, so say
          so — and say that walking away does not cancel it, because the scan
          runs in the server process and only the following of it stops. */}
      {scanDrive.isPending && (
        <div
          data-testid="scan-running"
          className="flex items-start gap-2 p-4 rounded-2xl bg-indigo-50/50 border border-indigo-100 text-sm text-indigo-900"
        >
          <CloudDownload className="w-4 h-4 mt-0.5 shrink-0 animate-pulse" />
          <span>
            Scanning Drive — every new invoice is read by the extractor, so a first
            scan of a full folder takes a few minutes. Leaving this page does not
            stop it; the invoices appear here once it finishes.
          </span>
        </div>
      )}

      {/* E-280 — the scan's own counters, not a bare "done". A scan that saw 135
          files and imported 0 is either "nothing new" or "everything is broken",
          and only the breakdown says which. */}
      {scanResult && !scanDrive.isPending && (
        <div
          data-testid="scan-summary"
          data-status={scanResult.status}
          className={cn(
            "p-4 rounded-2xl border text-sm space-y-1.5",
            scanResult.status === "failed"
              ? "bg-red-50 border-red-200 text-red-900"
              : "bg-indigo-50/50 border-indigo-100 text-indigo-900",
          )}
        >
          {scanResult.status === "skipped" ? (
            <span>Drive scan skipped — {scanResult.skipped_reason}</span>
          ) : (
            <span className="flex items-start gap-2">
              {scanResult.status === "failed" && (
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-600" />
              )}
              <span>
                Drive scan: saw <b>{scanResult.files_seen}</b> file(s), processed{" "}
                <b>{scanResult.files_new}</b> new, imported <b>{scanResult.imported}</b>,{" "}
                <b>{scanResult.skipped_duplicate}</b> already recorded,{" "}
                <b>{scanResult.needs_attention}</b> need attention,{" "}
                <b>{scanResult.failed}</b> failed.
              </span>
            </span>
          )}

          {/* The counters alone cannot distinguish "nothing new" from "the
              extractor is down", so the run's own reason is printed verbatim.
              The admin panel has always shown this; only this page dropped it. */}
          {scanResult.error && (
            <p data-testid="scan-error" className="text-xs text-red-800 pl-6">
              {scanResult.error}
            </p>
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

      {/* R-11 reconciliation. An invoice links to a salesperson only through a
          CRM dealer with the same GSTIN; anything else is company revenue that
          no SPOC gets credit for. Said out loud so it gets fixed, not hidden. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-white px-5 py-3 shadow-sm">
        <p className="text-sm text-gray-700">
          {summary && summary.unlinked_count > 0 ? (
            <>
              <span className="font-semibold text-amber-800">
                {summary.unlinked_count.toLocaleString("en-IN")} invoice
                {summary.unlinked_count === 1 ? "" : "s"} ({formatINR(summary.unlinked_total)})
              </span>{" "}
              in this view aren&apos;t linked to a CRM dealer, so no salesperson gets credit for them.
              Linking needs the same GSTIN on the invoice and on the dealer&apos;s lead.
            </>
          ) : summary ? (
            <span className="text-emerald-700">Every invoice in this view is linked to a CRM dealer.</span>
          ) : null}
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor="dealer-match" className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Dealer link
          </label>
          <select
            id="dealer-match"
            data-testid="filter-dealer-match"
            value={dealerMatch}
            onChange={(e) => {
              setDealerMatch(e.target.value as DealerMatch);
              setPage(0);
            }}
            className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm"
          >
            <option value="">All invoices</option>
            <option value="unlinked">Not linked (to reconcile)</option>
            <option value="linked">Linked to a dealer</option>
          </select>
        </div>
      </div>

      {unmatchedView && (
        <div
          data-testid="unmatched-panel"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-100 bg-amber-50/40 px-5 py-3"
        >
          <p className="text-sm text-gray-700">
            {summary ? (
              <>
                <span data-testid="unmatched-count" className="font-semibold text-amber-900">
                  {summary.count.toLocaleString("en-IN")} unmatched invoice
                  {summary.count === 1 ? "" : "s"} ({formatINR(summary.total)})
                </span>{" "}
                in this view. Link each to its dealer account, assign the account an
                owner, or mark it as not a dealer sale.
              </>
            ) : null}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {UNMATCHED_STATUSES.map((st) => {
              const active = matchFilter.includes(st);
              return (
                <button
                  key={st}
                  data-testid={`match-chip-${st}`}
                  data-active={active ? "true" : "false"}
                  onClick={() => {
                    setMatchFilter((prev) => {
                      const next = prev.includes(st) ? prev.filter((x) => x !== st) : [...prev, st];
                      // Never send an empty set: the API reads that as "everything".
                      return next.length > 0 ? next : UNMATCHED_STATUSES;
                    });
                    setPage(0);
                  }}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition-colors ${
                    active
                      ? "bg-amber-600 text-white border-amber-600"
                      : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {MATCH_LABEL[st]}
                </button>
              );
            })}
          </div>
          {decide.isError && (
            <p data-testid="decide-error" className="w-full text-[11px] font-semibold text-rose-600">
              {(decide.error as Error).message}
            </p>
          )}
        </div>
      )}

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
            {unmatchedView
              ? "Every invoice in this view is credited to a salesperson."
              : "No invoices match these filters."}
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
                    {unmatchedView && <th className="py-2 font-semibold">Match</th>}
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
                        <td className="py-3 text-xs text-gray-900 max-w-xs">
                          <div className="truncate">{r.customer_name || "—"}</div>
                          <div
                            data-testid="invoice-dealer-link"
                            className={`truncate text-[10px] ${r.dealer_lead_id || r.account_id ? "text-emerald-700" : "text-amber-700"}`}
                            title={r.gstin_key ?? undefined}
                          >
                            {r.dealer_lead_id || r.account_id
                              ? `→ ${r.dealer_name || r.account_id || r.dealer_lead_id}`
                              : r.link_kind === "not_dealer"
                                ? "Marked: not a dealer sale"
                              : r.gstin_key
                                ? `Not linked · GSTIN ${r.gstin_key} not on any CRM lead`
                                : "Not linked · no GSTIN on this invoice"}
                          </div>
                        </td>
                        <td className="py-3">
                          <StatusBadge status={r.status} />
                        </td>
                        {unmatchedView && (
                          <td className="py-3">
                            <div className="flex flex-col items-start gap-1.5">
                              <MatchBadge status={r.match_status} />
                              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                {r.match_status === "no_owner" && r.account_id && (
                                  <Link
                                    data-testid="assign-owner"
                                    href={`/admin/accounts/${encodeURIComponent(r.account_id)}`}
                                    className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-700 hover:underline whitespace-nowrap"
                                  >
                                    <UserPlus className="w-3 h-3" />
                                    Assign owner
                                  </Link>
                                )}
                                {r.link_kind !== "linked" && (
                                  <button
                                    data-testid="link-account"
                                    onClick={() => setLinking(r)}
                                    className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-brand-700 hover:underline whitespace-nowrap"
                                  >
                                    <Link2 className="w-3 h-3" />
                                    Link to account
                                  </button>
                                )}
                                {r.link_kind !== "not_dealer" && (
                                  <button
                                    data-testid="mark-not-dealer"
                                    disabled={decide.isPending}
                                    onClick={() => decide.mutate({ row: r, action: "not_dealer" })}
                                    className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gray-600 hover:underline whitespace-nowrap disabled:opacity-50"
                                  >
                                    <Ban className="w-3 h-3" />
                                    Not a dealer sale
                                  </button>
                                )}
                                {r.link_kind && (
                                  <button
                                    data-testid="clear-link"
                                    disabled={decide.isPending}
                                    onClick={() => decide.mutate({ row: r, action: "clear" })}
                                    className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gray-500 hover:underline whitespace-nowrap disabled:opacity-50"
                                  >
                                    <Undo2 className="w-3 h-3" />
                                    Undo
                                  </button>
                                )}
                              </div>
                            </div>
                          </td>
                        )}
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
                          <td colSpan={colCount} className="py-3 px-2">
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

      {linking && (
        <LinkAccountDialog
          invoice={linking}
          onClose={() => setLinking(null)}
          onLinked={() => {
            setLinking(null);
            queryClient.invalidateQueries({ queryKey: ["ceo-invoices"] });
            queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] });
          }}
        />
      )}
    </div>
  );
}
