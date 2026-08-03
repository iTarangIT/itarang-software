"use client";

/**
 * E-221 — the CEO's pending-quotation queue on /ceo.
 *
 * Every quote a rep raises waits here before it may be sent to a dealer, so
 * this panel is a blocker on someone else's work: it leads with the wait time,
 * shows oldest first, and states the true pending count even when the list
 * below is capped.
 *
 * Rejection demands a reason inline rather than firing on click. A refusal with
 * no stated reason leaves the rep nothing to act on, and the number they were
 * refused is the one they will otherwise send again.
 *
 * E-226 — every quote here failed the OEM reference-price check, so every row
 * states which check it failed and, where money is involved, what the
 * concession is worth. The per-line breakdown expands rather than showing by
 * default: the summary is enough to decide most rows, and the queue is worked
 * front to back.
 */

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Loader2, ScrollText } from "lucide-react";
import Link from "next/link";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { Pagination, usePagination } from "@/components/shared/Pagination";

interface OemLine {
  product_name: string;
  asset_type: string;
  quantity: number;
  quoted_unit_price: number | null;
  oem_price: number | null;
  delta: number | null;
  status: "at_or_above" | "below" | "no_reference" | "unpriced";
}

interface OemSummary {
  reason: string;
  shortfall_total: number;
  lines_flagged: number;
  lines: OemLine[];
}

interface PendingQuotation {
  commercial_id: string;
  dealer_lead_id: string;
  version_no: number;
  event_type: string;
  value: number;
  quote_document_url: string | null;
  line_count: number;
  /** null for quotes raised before E-226, which were gated unconditionally. */
  oem: OemSummary | null;
  raised_by: string;
  dealer_name: string;
  city: string | null;
  created_at: string;
}

interface QueueResponse {
  total: number;
  capped: boolean;
  quotations: PendingQuotation[];
}

/** "3d" / "5h" / "just now" — how long a rep has been blocked. */
function waitedFor(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Why this quote is in the queue, in one line.
 *
 * Leads with the money where there is money — a shortfall is the thing being
 * decided; a data gap is a different problem that happens to land in the same
 * queue, and conflating them would make the CEO read every row the same way.
 */
function oemCause(oem: OemSummary): string {
  const n = oem.lines_flagged;
  const lines = `${n} line${n === 1 ? "" : "s"}`;
  switch (oem.reason) {
    case "below_reference":
      return `${lines} below OEM reference · ${formatINRExact(
        oem.shortfall_total,
      )} short`;
    case "missing_reference":
      return `${lines} have no OEM reference price on file`;
    case "unpriced_line":
      return `${lines} left unpriced`;
    case "no_product_lines":
      return "No product lines — nothing to check against the price book";
    default:
      return "Needs manual approval";
  }
}

const LINE_STATUS_LABEL: Record<OemLine["status"], string> = {
  at_or_above: "OK",
  below: "below",
  no_reference: "no reference",
  unpriced: "unpriced",
};

function OemBreakdown({ oem }: { oem: OemSummary }) {
  if (oem.lines.length === 0) return null;
  return (
    <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50/60 overflow-x-auto">
      <table className="w-full text-[11px] tabular-nums">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="font-medium px-2 py-1.5">Product</th>
            <th className="font-medium px-2 py-1.5 text-right">Qty</th>
            <th className="font-medium px-2 py-1.5 text-right">Quoted</th>
            <th className="font-medium px-2 py-1.5 text-right">OEM ref</th>
            <th className="font-medium px-2 py-1.5 text-right">Delta</th>
          </tr>
        </thead>
        <tbody>
          {oem.lines.map((l, i) => {
            const ok = l.status === "at_or_above";
            return (
              <tr key={`${l.product_name}-${i}`} className="border-t border-gray-100">
                <td className="px-2 py-1.5 text-gray-700">
                  {l.product_name}
                  <span className="text-gray-400"> · {l.asset_type}</span>
                </td>
                <td className="px-2 py-1.5 text-right text-gray-600">{l.quantity}</td>
                <td className="px-2 py-1.5 text-right text-gray-700">
                  {l.quoted_unit_price != null ? formatINRExact(l.quoted_unit_price) : "—"}
                </td>
                <td className="px-2 py-1.5 text-right text-gray-700">
                  {l.oem_price != null ? formatINRExact(l.oem_price) : "—"}
                </td>
                <td
                  className={`px-2 py-1.5 text-right font-semibold ${
                    ok ? "text-emerald-600" : "text-rose-600"
                  }`}
                >
                  {l.delta != null
                    ? `${l.delta >= 0 ? "+" : "−"}${formatINRExact(Math.abs(l.delta))}`
                    : LINE_STATUS_LABEL[l.status]}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PendingQuotationsPanel() {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<QueueResponse>({
    queryKey: ["ceo-pending-quotations"],
    queryFn: async () => {
      const r = await fetch("/api/dashboard/ceo/quotations", { cache: "no-store" });
      if (!r.ok) throw new Error("Failed to load quotations");
      return (await r.json()).data as QueueResponse;
    },
    refetchInterval: 60_000,
  });

  const decide = useMutation({
    mutationFn: async (vars: {
      id: string;
      decision: "approve" | "reject";
      reason?: string;
    }) => {
      const r = await fetch(
        `/api/dashboard/ceo/quotations/${vars.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: vars.decision, reason: vars.reason }),
        },
      );
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error?.message ?? "Decision failed");
      return j.data;
    },
    onSuccess: () => {
      setRejecting(null);
      setReason("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["ceo-pending-quotations"] });
    },
    // Surfaced in the panel rather than swallowed — the most likely failure is
    // a 409 because someone else already decided, and the CEO needs to know
    // their click did nothing.
    onError: (e: Error) => setError(e.message),
  });

  const quotations = React.useMemo(() => data?.quotations ?? [], [data]);
  const paged = usePagination(quotations, 5);

  if (isLoading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
        </div>
      </Shell>
    );
  }

  if (isError) {
    return (
      <Shell>
        <p className="text-sm text-rose-600 py-6 text-center">
          Couldn&apos;t load pending quotations.
        </p>
      </Shell>
    );
  }

  if (quotations.length === 0) {
    return (
      <Shell count={0}>
        <p className="text-sm text-gray-400 italic py-6 text-center">
          No quotations waiting for approval.
        </p>
      </Shell>
    );
  }

  return (
    <Shell count={data?.total ?? 0}>
      {data?.capped && (
        <p className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
          Showing the 100 oldest of {data.total} pending quotations.
        </p>
      )}
      {error && (
        <p className="text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 mb-3">
          {error}
        </p>
      )}

      <ul className="divide-y divide-gray-50">
        {paged.pageItems.map((q) => {
          const isRejecting = rejecting === q.commercial_id;
          const busy = decide.isPending && decide.variables?.id === q.commercial_id;
          return (
            <li key={q.commercial_id} className="py-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <Link
                    href={`/inside-sales/lead/${q.dealer_lead_id}`}
                    className="text-sm font-semibold text-gray-900 hover:text-brand-700 hover:underline"
                  >
                    {q.dealer_name}
                  </Link>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {q.city ? `${q.city} · ` : ""}
                    {q.raised_by} · v{q.version_no}
                    {q.line_count > 0 && ` · ${q.line_count} line${q.line_count === 1 ? "" : "s"}`}
                    {q.event_type === "quote_revision" && " · revision"}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p
                    className="text-sm font-bold text-gray-900 tabular-nums"
                    title={formatINRExact(q.value)}
                  >
                    {q.value > 0 ? formatINRCompact(q.value) : "—"}
                  </p>
                  <p className="text-[11px] font-medium text-amber-600">
                    waiting {waitedFor(q.created_at)}
                  </p>
                </div>
              </div>

              {q.oem && (
                <div className="mt-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded(expanded === q.commercial_id ? null : q.commercial_id)
                    }
                    disabled={q.oem.lines.length === 0}
                    className={`inline-flex items-center gap-1 text-[11px] font-medium rounded-md px-1.5 py-0.5 -ml-1.5 ${
                      q.oem.reason === "below_reference"
                        ? "text-rose-700"
                        : "text-amber-700"
                    } ${q.oem.lines.length > 0 ? "hover:bg-gray-50" : "cursor-default"}`}
                  >
                    {q.oem.lines.length > 0 &&
                      (expanded === q.commercial_id ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      ))}
                    {oemCause(q.oem)}
                  </button>
                  {expanded === q.commercial_id && <OemBreakdown oem={q.oem} />}
                </div>
              )}

              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {q.quote_document_url && (
                  <a
                    href={q.quote_document_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 hover:underline"
                  >
                    <FileText className="w-3 h-3" /> Quote
                  </a>
                )}
                <div className="flex-1" />
                {!isRejecting && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        decide.mutate({ id: q.commercial_id, decision: "approve" })
                      }
                      className="h-7 px-3 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {busy ? "…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setRejecting(q.commercial_id);
                        setReason("");
                        setError(null);
                      }}
                      className="h-7 px-3 rounded-lg text-[11px] font-bold border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>

              {isRejecting && (
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <input
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this rejected? (required)"
                    className="flex-1 min-w-[200px] h-8 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                  />
                  <button
                    type="button"
                    disabled={!reason.trim() || busy}
                    onClick={() =>
                      decide.mutate({
                        id: q.commercial_id,
                        decision: "reject",
                        reason: reason.trim(),
                      })
                    }
                    className="h-8 px-3 rounded-lg text-[11px] font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"
                  >
                    {busy ? "…" : "Confirm reject"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejecting(null)}
                    className="h-8 px-2 rounded-lg text-[11px] font-semibold text-gray-500 hover:bg-gray-100"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Pagination
        page={paged.page}
        pageCount={paged.pageCount}
        onPageChange={paged.setPage}
        total={paged.total}
        from={paged.from}
        to={paged.to}
        noun="quotations"
        compact
      />
    </Shell>
  );
}

function Shell({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div
      data-testid="pending-quotations-panel"
      className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm"
    >
      <div className="flex items-center gap-2 mb-4">
        <ScrollText className="w-4 h-4 text-gray-400" />
        <h3 className="text-sm font-semibold text-gray-900">Quotation Approvals</h3>
        {count != null && count > 0 && (
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
            {count} pending
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
