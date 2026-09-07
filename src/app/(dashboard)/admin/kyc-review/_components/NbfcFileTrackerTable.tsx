"use client";

// E-282 — the "NBFC Files" tab of the KYC review queue.
//
// One row per file sitting with a lender, sorted longest-waiting first, with
// the stage it is in, how long it has been there and whose move it is. Expand a
// row for its full action history; export the whole filtered set, a selection,
// or a single file to CSV.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";

import {
  daysElapsed,
  formatDuration,
  WAITING_ON_LABEL,
  type WaitingOn,
} from "@/lib/nbfc/file-tracker";

type TrackerRow = {
  assignmentId: string;
  leadId: string;
  referenceId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  city: string | null;
  state: string | null;
  dealerCode: string | null;
  dealerName: string | null;
  nbfcId: number;
  nbfcShortName: string | null;
  nbfcCode: string | null;
  productName: string | null;
  assignmentStatus: string;
  assignedAt: string | null;
  stageKey: string;
  stageLabel: string;
  waitingOn: WaitingOn;
  stageSince: string | null;
  timeInStageMs: number | null;
  totalAgeMs: number | null;
  openRequests: number;
  slaDueAt: string | null;
  slaOverdue: boolean;
  lastActivityAt: string | null;
};

type ActionEntry = {
  at: string;
  party: "nbfc" | "admin" | "dealer" | "customer" | "system";
  action: string;
  detail: string;
  nbfcShortName: string | null;
};

const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All stages" },
  { value: "with_nbfc", label: "With lender" },
  { value: "docs", label: "Document request open" },
  { value: "verdict", label: "Verdict awaiting forward" },
  { value: "offer", label: "Offer submitted" },
  { value: "rejected", label: "Rejected by lender" },
  { value: "sanctioned", label: "Sanctioned" },
  { value: "disbursed", label: "Disbursed" },
];

const WAITING_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Anyone" },
  { value: "nbfc", label: "Lender" },
  { value: "admin", label: "iTarang" },
  { value: "dealer", label: "Dealer" },
  { value: "customer", label: "Customer" },
];

const PARTY_LABEL: Record<ActionEntry["party"], string> = {
  nbfc: "Lender",
  admin: "iTarang",
  dealer: "Dealer",
  customer: "Customer",
  system: "System",
};

/** Older files read redder. Same thresholds the ageing report uses in spirit. */
function ageClass(ms: number | null): string {
  const days = daysElapsed(ms);
  if (days >= 7) return "text-red-600 font-semibold";
  if (days >= 3) return "text-amber-600 font-medium";
  return "text-ink";
}

function waitingClass(w: WaitingOn): string {
  switch (w) {
    case "admin":
      return "bg-amber-100 text-amber-800";
    case "nbfc":
      return "bg-blue-100 text-blue-800";
    case "dealer":
      return "bg-purple-100 text-purple-800";
    case "customer":
      return "bg-teal-100 text-teal-800";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

const dt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

export default function NbfcFileTrackerTable() {
  const [rows, setRows] = useState<TrackerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [nbfcId, setNbfcId] = useState("");
  const [stage, setStage] = useState("");
  const [waitingOn, setWaitingOn] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, ActionEntry[]>>({});
  const [historyLoading, setHistoryLoading] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    if (nbfcId) p.set("nbfcId", nbfcId);
    if (stage) p.set("stage", stage);
    if (waitingOn) p.set("waitingOn", waitingOn);
    if (overdueOnly) p.set("overdue", "1");
    return p;
  }, [search, nbfcId, stage, waitingOn, overdueOnly]);

  const fetchRows = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`/api/admin/nbfc-file-tracker?${query}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error?.message ?? "Failed to load NBFC files");
        }
        setRows(json.data.rows as TrackerRow[]);
        setTotal(json.data.total as number);
        setTruncated(Boolean(json.data.truncated));
      } catch (err) {
        if (!silent) {
          toast.error(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [query],
  );

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => fetchRows(), 250);
    return () => clearTimeout(t);
  }, [fetchRows]);

  const nbfcOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of rows) {
      if (r.nbfcShortName) seen.set(r.nbfcId, r.nbfcShortName);
    }
    return Array.from(seen.entries());
  }, [rows]);

  async function toggleExpand(row: TrackerRow) {
    if (expanded === row.assignmentId) {
      setExpanded(null);
      return;
    }
    setExpanded(row.assignmentId);
    if (history[row.leadId]) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/admin/nbfc-file-tracker/${encodeURIComponent(row.leadId)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Failed to load history");
      }
      setHistory((h) => ({ ...h, [row.leadId]: json.data.entries as ActionEntry[] }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setHistoryLoading(false);
    }
  }

  function toggleSelect(leadId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  }

  function downloadAll() {
    const p = new URLSearchParams(query);
    p.set("format", "csv");
    window.location.href = `/api/admin/nbfc-file-tracker?${p}`;
  }

  function downloadSelected() {
    if (selected.size === 0) return;
    const p = new URLSearchParams(query);
    p.set("format", "csv");
    p.set("leadIds", Array.from(selected).join(","));
    window.location.href = `/api/admin/nbfc-file-tracker?${p}`;
  }

  function downloadOne(leadId: string) {
    window.location.href = `/api/admin/nbfc-file-tracker/${encodeURIComponent(leadId)}?format=csv`;
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div className="space-y-4">
      {/* ── Filters ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search lead, customer, dealer or phone…"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm"
          />
        </div>

        <select
          value={nbfcId}
          onChange={(e) => setNbfcId(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
        >
          <option value="">All lenders</option>
          {nbfcOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>

        <select
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
        >
          {STAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={waitingOn}
          onChange={(e) => setWaitingOn(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
        >
          {WAITING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.value ? `Waiting on: ${o.label}` : "Waiting on: anyone"}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            className="h-4 w-4"
          />
          Overdue only
        </label>

        <button
          type="button"
          onClick={() => fetchRows()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* ── Export bar ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          {total} file{total === 1 ? "" : "s"} with lenders
          {truncated && ` · showing the ${rows.length} oldest`}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={downloadSelected}
            disabled={selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            Download selected ({selected.size})
          </button>
          <button
            type="button"
            onClick={downloadAll}
            disabled={total === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            Download all
          </button>
        </div>
      </div>

      {/* ── Table ────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading NBFC files…
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-500">
          No files are with a lender right now.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[1180px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(
                        allSelected ? new Set() : new Set(rows.map((r) => r.leadId)),
                      )
                    }
                    className="h-4 w-4"
                  />
                </th>
                <th className="w-8 px-1 py-2" />
                <th className="px-3 py-2 font-medium">Lead</th>
                <th className="px-3 py-2 font-medium">Dealer</th>
                <th className="px-3 py-2 font-medium">Lender</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Waiting on</th>
                <th className="px-3 py-2 font-medium">In stage</th>
                <th className="px-3 py-2 font-medium">Total age</th>
                <th className="px-3 py-2 font-medium">Reqs</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = expanded === r.assignmentId;
                return (
                  <Fragment key={r.assignmentId}>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(r.leadId)}
                          onChange={() => toggleSelect(r.leadId)}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="px-1 py-2">
                        <button
                          type="button"
                          onClick={() => toggleExpand(r)}
                          aria-label={open ? "Collapse history" : "Expand history"}
                          className="rounded p-1 hover:bg-slate-100"
                        >
                          {open ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900">
                          {r.customerName ?? "—"}
                        </div>
                        <div className="text-xs text-slate-500">
                          {r.referenceId ?? r.leadId}
                          {r.city ? ` · ${r.city}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.dealerName ?? "—"}</div>
                        <div className="text-xs text-slate-500">{r.dealerCode ?? ""}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.nbfcShortName ?? "—"}</div>
                        <div className="text-xs text-slate-500">{r.productName ?? ""}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.stageLabel}</div>
                        {r.slaOverdue && (
                          <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                            <AlertTriangle className="h-3 w-3" />
                            SLA overdue
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${waitingClass(r.waitingOn)}`}
                        >
                          {WAITING_ON_LABEL[r.waitingOn]}
                        </span>
                      </td>
                      <td className={`px-3 py-2 ${ageClass(r.timeInStageMs)}`}>
                        {formatDuration(r.timeInStageMs)}
                      </td>
                      <td className={`px-3 py-2 ${ageClass(r.totalAgeMs)}`}>
                        {formatDuration(r.totalAgeMs)}
                      </td>
                      <td className="px-3 py-2">{r.openRequests || "—"}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {dt(r.lastActivityAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => downloadOne(r.leadId)}
                          title="Download this file's NBFC actions as CSV"
                          className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>

                    {open && (
                      <tr className="bg-slate-50">
                        <td colSpan={12} className="px-6 py-4">
                          {historyLoading && !history[r.leadId] ? (
                            <div className="flex items-center gap-2 text-sm text-slate-500">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading history…
                            </div>
                          ) : (history[r.leadId] ?? []).length === 0 ? (
                            <p className="text-sm text-slate-500">
                              No recorded NBFC actions on this file yet.
                            </p>
                          ) : (
                            <ol className="space-y-2">
                              {(history[r.leadId] ?? []).map((e, i) => (
                                <li key={i} className="flex gap-3 text-sm">
                                  <span className="w-40 shrink-0 text-xs text-slate-500">
                                    {dt(e.at)}
                                  </span>
                                  <span className="w-20 shrink-0 text-xs font-medium text-slate-600">
                                    {PARTY_LABEL[e.party]}
                                  </span>
                                  <span className="text-slate-900">
                                    {e.action}
                                    {e.detail && (
                                      <span className="text-slate-500"> — {e.detail}</span>
                                    )}
                                  </span>
                                </li>
                              ))}
                            </ol>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
