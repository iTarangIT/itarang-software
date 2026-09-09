"use client";

// E-282 — lender status for ONE lead, rendered inside its KYC-review card.
//
// Replaces the former "NBFC Files" tab: the same rows the cross-lead tracker
// returned, but keyed to the card the admin is already looking at. One row per
// lender assignment (a lead may be with more than one NBFC), plus the derived
// action history on demand and a per-file CSV export.
//
// Data comes from `/api/admin/nbfc-file-tracker?leadIds=…` (fetched by the
// page for all visible leads at once) and `/api/admin/nbfc-file-tracker/[leadId]`
// for the timeline.

import { useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  daysElapsed,
  formatDuration,
  WAITING_ON_LABEL,
  type WaitingOn,
} from "@/lib/nbfc/file-tracker";

export type TrackerRow = {
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
  return "text-gray-900";
}

export function waitingClass(w: WaitingOn): string {
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

/**
 * The compact chip shown in the card header — one per lender assignment.
 * `{lender} · {stage}` coloured by whose move it is, with an SLA flag.
 */
export function LenderChip({ row }: { row: TrackerRow }) {
  return (
    <span
      title={`${row.stageLabel} · waiting on ${WAITING_ON_LABEL[row.waitingOn]} · in stage ${formatDuration(row.timeInStageMs)}`}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold whitespace-nowrap ${waitingClass(row.waitingOn)}`}
    >
      {row.nbfcShortName ?? "Lender"} · {row.stageLabel}
      {row.slaOverdue && (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-700">
          <AlertTriangle className="h-2.5 w-2.5" />
          SLA
        </span>
      )}
    </span>
  );
}

export default function LeadNbfcUpdates({
  leadId,
  rows,
}: {
  leadId: string;
  rows: TrackerRow[];
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ActionEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (!next || history) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/admin/nbfc-file-tracker/${encodeURIComponent(leadId)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Failed to load history");
      }
      setHistory(json.data.entries as ActionEntry[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load history");
      setShowHistory(false);
    } finally {
      setHistoryLoading(false);
    }
  }

  function downloadCsv() {
    window.location.href = `/api/admin/nbfc-file-tracker/${encodeURIComponent(leadId)}?format=csv`;
  }

  if (rows.length === 0) return null;

  return (
    <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500">
          Lender updates
        </h4>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleHistory}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1 text-[10px] font-bold text-gray-600 hover:bg-gray-50"
          >
            {showHistory ? "Hide history" : "Show history"}
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            title="Download this file's NBFC actions as CSV"
            className="rounded-lg border border-gray-200 bg-white p-1.5 hover:bg-gray-50"
          >
            <Download className="h-3.5 w-3.5 text-gray-600" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-2 py-1.5 font-bold">Lender</th>
              <th className="px-2 py-1.5 font-bold">Stage</th>
              <th className="px-2 py-1.5 font-bold">Waiting on</th>
              <th className="px-2 py-1.5 font-bold">In stage</th>
              <th className="px-2 py-1.5 font-bold">Total age</th>
              <th className="px-2 py-1.5 font-bold">Reqs</th>
              <th className="px-2 py-1.5 font-bold">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.assignmentId} className="border-t border-blue-100">
                <td className="px-2 py-2">
                  <div className="font-medium text-gray-900">{r.nbfcShortName ?? "—"}</div>
                  <div className="text-xs text-gray-500">{r.productName ?? ""}</div>
                </td>
                <td className="px-2 py-2">
                  <div>{r.stageLabel}</div>
                  {r.slaOverdue && (
                    <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                      <AlertTriangle className="h-3 w-3" />
                      SLA overdue
                    </span>
                  )}
                </td>
                <td className="px-2 py-2">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${waitingClass(r.waitingOn)}`}
                  >
                    {WAITING_ON_LABEL[r.waitingOn]}
                  </span>
                </td>
                <td className={`px-2 py-2 ${ageClass(r.timeInStageMs)}`}>
                  {formatDuration(r.timeInStageMs)}
                </td>
                <td className={`px-2 py-2 ${ageClass(r.totalAgeMs)}`}>
                  {formatDuration(r.totalAgeMs)}
                </td>
                <td className="px-2 py-2">{r.openRequests || "—"}</td>
                <td className="px-2 py-2 text-xs text-gray-500">{dt(r.lastActivityAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showHistory && (
        <div className="mt-3 border-t border-blue-100 pt-3">
          {historyLoading && !history ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading history…
            </div>
          ) : (history ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">No recorded NBFC actions on this file yet.</p>
          ) : (
            <ol className="space-y-2">
              {(history ?? []).map((e, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="w-40 shrink-0 text-xs text-gray-500">{dt(e.at)}</span>
                  <span className="w-20 shrink-0 text-xs font-medium text-gray-600">
                    {PARTY_LABEL[e.party]}
                  </span>
                  <span className="text-gray-900">
                    {e.action}
                    {e.detail && <span className="text-gray-500"> — {e.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
