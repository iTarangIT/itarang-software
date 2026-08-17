"use client";

/**
 * E-221 — the CEO's quotation-approval panel on /ceo.
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
 * E-226 — every quote in the PENDING tab failed the OEM reference-price check,
 * so every row states which check it failed and, where money is involved, what
 * the concession is worth. The per-line breakdown expands rather than showing
 * by default: the summary is enough to decide most rows, and the queue is
 * worked front to back.
 *
 * E-230 — the APPROVED tab, and why it is a tab rather than a second panel.
 *
 * Auto-approval opened a blind spot. Before it, every quote passed through the
 * CEO's hands, so the pending queue was also the complete record of what went
 * out. Now the quotes that clear the reference price release themselves and
 * appear nowhere. "What went out in my name, and at what margin" is the
 * question the price book makes askable, and it belongs beside the queue that
 * answers its opposite — a separate card would put two halves of one subject in
 * two places and add a second thing to scroll past.
 *
 * The two tabs share every row primitive and differ only where they must: the
 * released rows carry who released them instead of Approve/Reject, because
 * nothing about a released quote is still decidable here.
 */

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  ScrollText,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { Pagination, usePagination } from "@/components/shared/Pagination";

// E-242 — "history" is the decision log: approvals AND rejections together.
// Kept as a third tab rather than a page of its own because every row primitive
// is already shared, and a separate screen would be a second door to data this
// panel is already showing.
type Tab = "pending" | "approved" | "history";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "history", label: "History" },
];

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

interface Quotation {
  commercial_id: string;
  dealer_lead_id: string;
  version_no: number;
  event_type: string;
  value: number;
  /** Both figures, so a roll-up replacing a typed price is visible, not silent. */
  price_quoted: number | null;
  final_price: number | null;
  quote_document_url: string | null;
  line_count: number;
  /**
   * What the rep agreed with this dealer. These print on the dealer's document,
   * so the approver has to see them before releasing it. Optional because a
   * cached page may still hold a response from before they were selected.
   */
  terms?: {
    payment_method: string | null;
    credit_terms: string | null;
    delivery_terms: string | null;
    warranty_terms: string | null;
    deal_notes: string | null;
  } | null;
  /** null for quotes raised before E-226, which were gated unconditionally. */
  oem: OemSummary | null;
  raised_by: string;
  dealer_name: string;
  city: string | null;
  created_at: string;
  /** Approved tab only. null on rows that predate the distinction. */
  approval_route: "auto" | "manual" | null;
  approved_by_name: string | null;
  approved_at: string | null;
  /** E-242 — 'approved' | 'rejected' | 'pending'. */
  approval_status: string;
  /** E-242 — mandatory on a rejection, and until now displayed nowhere. */
  rejection_reason: string | null;
  quote_number: string | null;
  quote_pdf_url: string | null;
  /** E-243 — the DEALER's answer, not iTarang's. Null until they respond. */
  dealer_decision: "approved" | "declined" | null;
  dealer_decision_at: string | null;
}

interface QueueResponse {
  status: Tab;
  total: number;
  capped: boolean;
  auto_count: number;
  value_total: number;
  /** History tab only. */
  rejected_count: number;
  mine: boolean;
  quotations: Quotation[];
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

/**
 * The rupees this quote sits ABOVE the reference book, across all lines.
 *
 * The stored evaluation carries only `shortfall_total`, which is 0 for
 * everything the rule released — so on the approved tab it says nothing. The
 * margin above reference is the number that makes a released quote worth
 * reading, and it is derivable from the lines already in hand rather than
 * needing a new column.
 */
function headroomOf(oem: OemSummary): number {
  return oem.lines.reduce(
    (sum, l) => (l.delta != null && l.delta > 0 ? sum + l.delta * l.quantity : sum),
    0,
  );
}

/** Why this quote was released, in one line. Mirrors oemCause on the queue. */
function releaseCause(q: Quotation): string | null {
  if (!q.oem) return null;
  if (q.oem.reason !== "at_or_above_reference") {
    // Released by the CEO despite failing a check — the concession they signed
    // off is the most important thing on the row, so it keeps its own wording.
    return `Released over: ${oemCause(q.oem)}`;
  }
  const headroom = headroomOf(q.oem);
  const n = q.oem.lines.length;
  const lines = `${n} line${n === 1 ? "" : "s"}`;
  return headroom > 0
    ? `${lines} at or above OEM reference · ${formatINRExact(headroom)} above`
    : `${lines} exactly at OEM reference`;
}

const LINE_STATUS_LABEL: Record<OemLine["status"], string> = {
  at_or_above: "OK",
  below: "below",
  no_reference: "no reference",
  unpriced: "unpriced",
};

/**
 * The terms this quotation commits us to, shown WITHOUT a click.
 *
 * Deliberately not behind the expander the OEM breakdown uses. Approving a
 * quotation releases these terms to a dealer; a credit period or a warranty
 * that has to be discovered by clicking is one the approver will not read.
 * Renders nothing at all when the rep set none, so the queue stays scannable.
 */
function TermsStrip({ terms }: { terms: Quotation["terms"] }) {
  if (!terms) return null;
  const chips = [
    ["Payment", terms.payment_method],
    ["Credit", terms.credit_terms],
    ["Delivery", terms.delivery_terms],
    ["Warranty", terms.warranty_terms],
  ].filter(([, v]) => !!v) as [string, string][];

  if (chips.length === 0 && !terms.deal_notes) return null;

  return (
    <div className="mt-1.5">
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700"
            >
              <span className="text-gray-500">{k}</span>
              <span className="font-medium">{v}</span>
            </span>
          ))}
        </div>
      )}
      {terms.deal_notes && (
        <p className="mt-1 text-[11px] text-gray-600 whitespace-pre-wrap">
          <span className="text-gray-500">Notes: </span>
          {terms.deal_notes}
        </p>
      )}
    </div>
  );
}

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

/**
 * Who released this quote.
 *
 * Auto and CEO are visually distinct because they answer different questions: a
 * row of Auto pills is the rule working, and a CEO pill among them is a
 * decision somebody made and may need to explain.
 */
function ReleaseBadge({ q }: { q: Quotation }) {
  if (q.approval_route === "auto") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700">
        <Bot className="w-3 h-3" /> Auto
      </span>
    );
  }
  if (q.approval_route === "manual") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-md bg-brand-50 text-brand-700"
        title={q.approved_by_name ? `Approved by ${q.approved_by_name}` : undefined}
      >
        <UserCheck className="w-3 h-3" />
        {q.approved_by_name ?? "CEO"}
      </span>
    );
  }
  // Pre-E-226: approved, but the row records nothing about how. Saying "auto"
  // here would credit the rule with decisions people made before it existed.
  return (
    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-500">
      Approved
    </span>
  );
}

/**
 * E-242 — "everything" vs "my decisions" on the History tab.
 *
 * `mine` filters on approved_by, which auto-approved rows leave NULL. So the
 * personal view excludes them by construction rather than by a second rule —
 * nobody decided them, so they are not anybody's decisions.
 */
function HistoryFilter({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1 mb-3">
      {[
        { v: false, label: "All decisions" },
        { v: true, label: "Mine only" },
      ].map((o) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          className={`h-6 px-2.5 rounded-md text-[11px] font-semibold transition ${
            value === o.v
              ? "bg-gray-900 text-white"
              : "text-gray-500 hover:bg-gray-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function QuotationApprovalsPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = React.useState<Tab>("pending");
  const [rejecting, setRejecting] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  // E-242 — History only. Off by default so the tab opens on the whole record;
  // an auto-approved quote has no decider, so "mine" excludes them by nature.
  const [mineOnly, setMineOnly] = React.useState(false);

  const { data, isLoading, isError } = useQuery<QueueResponse>({
    queryKey: ["ceo-quotations", tab, mineOnly],
    queryFn: async () => {
      const mine = tab === "history" && mineOnly ? "&mine=true" : "";
      const r = await fetch(`/api/dashboard/ceo/quotations?status=${tab}${mine}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Failed to load quotations");
      return (await r.json()).data as QueueResponse;
    },
    // The pending queue is a live work surface; the released record is not, and
    // re-fetching a historical list every minute is noise the tab does not need.
    refetchInterval: tab === "pending" ? 60_000 : false,
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
      // Both tabs: an approval leaves one list and joins the other, so a stale
      // Approved tab would omit the row the CEO just released.
      qc.invalidateQueries({ queryKey: ["ceo-quotations"] });
    },
    // Surfaced in the panel rather than swallowed — the most likely failure is
    // a 409 because someone else already decided, and the CEO needs to know
    // their click did nothing.
    onError: (e: Error) => setError(e.message),
  });

  const quotations = React.useMemo(() => data?.quotations ?? [], [data]);
  const paged = usePagination(quotations, 5);
  const { setPage } = paged;

  // Page 1 on every tab switch. usePagination only clamps DOWN when a list
  // shrinks, so switching from page 3 of a long queue to a short released list
  // would otherwise land mid-list with no indication why.
  const switchTab = React.useCallback(
    (next: Tab) => {
      setTab(next);
      setPage(1);
      setExpanded(null);
      setRejecting(null);
      setError(null);
    },
    [setPage],
  );

  const header = (
    <Tabs value={tab} onChange={switchTab} pendingCount={data?.total} />
  );

  if (isLoading) {
    return (
      <Shell header={header}>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
        </div>
      </Shell>
    );
  }

  if (isError) {
    return (
      <Shell header={header}>
        <p className="text-sm text-rose-600 py-6 text-center">
          Couldn&apos;t load quotations.
        </p>
      </Shell>
    );
  }

  if (quotations.length === 0) {
    return (
      <Shell header={header}>
        {tab === "history" && <HistoryFilter value={mineOnly} onChange={setMineOnly} />}
        <p className="text-sm text-gray-400 italic py-6 text-center">
          {tab === "pending"
            ? "No quotations waiting for approval."
            : tab === "history"
              ? mineOnly
                ? "You haven't decided any quotations yet."
                : "No decisions recorded yet."
              : "No quotations released yet."}
        </p>
      </Shell>
    );
  }

  const approved = tab === "approved";
  const history = tab === "history";
  // Both are records rather than queues: nothing on either is decidable, and
  // both order newest-decision-first.
  const decided = approved || history;

  return (
    <Shell header={header}>
      {history && <HistoryFilter value={mineOnly} onChange={setMineOnly} />}
      {history && data && (
        <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 mb-3">
          <span className="font-semibold text-gray-700">
            {data.total} decision{data.total === 1 ? "" : "s"}
          </span>
          {" · "}
          <span className="text-emerald-700 font-medium">
            {data.total - data.rejected_count} approved
          </span>
          {" · "}
          <span className="text-rose-700 font-medium">
            {data.rejected_count} rejected
          </span>
          {!mineOnly && data.auto_count > 0 && ` · ${data.auto_count} auto-approved`}
        </p>
      )}
      {approved && data && (
        <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 mb-3">
          <span className="font-semibold text-gray-700">
            {data.total} quote{data.total === 1 ? "" : "s"} released
          </span>
          {data.value_total > 0 && ` · ${formatINRCompact(data.value_total)} total`}
          {" · "}
          {data.auto_count} auto-approved, {data.total - data.auto_count} by hand
        </p>
      )}
      {data?.capped && (
        <p className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
          Showing the {approved ? "100 most recent" : "100 oldest"} of {data.total}{" "}
          {approved ? "released" : "pending"} quotations.
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
          const rejected = q.approval_status === "rejected";
          // On History a rejected row keeps the OEM cause that sent it to the
          // queue in the first place — that is the number the decision was
          // about — while an approved one reads as a release.
          const cause =
            approved || (history && !rejected)
              ? releaseCause(q)
              : q.oem
                ? oemCause(q.oem)
                : null;
          const overridden =
            approved && q.oem != null && q.oem.reason !== "at_or_above_reference";
          return (
            <li key={q.commercial_id} className="py-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Link
                      href={`/inside-sales/lead/${q.dealer_lead_id}`}
                      className="text-sm font-semibold text-gray-900 hover:text-brand-700 hover:underline"
                    >
                      {q.dealer_name}
                    </Link>
                    {approved && <ReleaseBadge q={q} />}
                    {history &&
                      (rejected ? (
                        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-rose-100 text-rose-700">
                          Rejected
                        </span>
                      ) : (
                        <ReleaseBadge q={q} />
                      ))}
                    {q.quote_number && (
                      <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                        {q.quote_number}
                      </span>
                    )}
                    {/* E-243 — the outcome that actually matters commercially:
                        a released quote the dealer took. Shown on both records
                        tabs; a pending quote cannot have one. */}
                    {decided && q.dealer_decision && (
                      <span
                        className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md ${
                          q.dealer_decision === "approved"
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-200 text-slate-700"
                        }`}
                        title={
                          q.dealer_decision_at
                            ? `Dealer responded ${waitedFor(q.dealer_decision_at)} ago`
                            : undefined
                        }
                      >
                        Dealer {q.dealer_decision === "approved" ? "approved" : "declined"}
                      </span>
                    )}
                  </div>
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
                  {decided ? (
                    <p className="text-[11px] font-medium text-gray-400">
                      {history && rejected ? "rejected" : "released"}{" "}
                      {waitedFor(q.approved_at ?? q.created_at)} ago
                    </p>
                  ) : (
                    <p className="text-[11px] font-medium text-amber-600">
                      waiting {waitedFor(q.created_at)}
                    </p>
                  )}
                  {history && q.approved_by_name && (
                    <p className="text-[11px] text-gray-400">by {q.approved_by_name}</p>
                  )}
                </div>
              </div>

              <TermsStrip terms={q.terms} />

              {q.oem && cause && (
                <div className="mt-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded(expanded === q.commercial_id ? null : q.commercial_id)
                    }
                    disabled={q.oem.lines.length === 0}
                    className={`inline-flex items-center gap-1 text-[11px] font-medium rounded-md px-1.5 py-0.5 -ml-1.5 ${
                      approved && !overridden
                        ? "text-emerald-700"
                        : q.oem.reason === "below_reference"
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
                    {cause}
                  </button>
                  {expanded === q.commercial_id && <OemBreakdown oem={q.oem} />}
                </div>
              )}

              {/* E-242 — the stated reason. Mandatory on every rejection since
                  E-221, written by the decision route, and displayed nowhere at
                  all until this line. */}
              {history && rejected && q.rejection_reason && (
                <p className="mt-1.5 text-[11px] text-rose-800 bg-rose-50 border border-rose-100 rounded-lg px-2 py-1.5 whitespace-pre-wrap">
                  <span className="font-semibold">Reason:</span> {q.rejection_reason}
                </p>
              )}

              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {q.quote_pdf_url && (
                  <a
                    href={q.quote_pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 hover:underline"
                  >
                    <FileText className="w-3 h-3" /> Draft
                  </a>
                )}
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
                {/* Nothing about a released quote is decidable here, so the
                    row ends at the document link. Rejecting after release
                    would need to unsend what the dealer already has, which is
                    a different operation than refusing to send it. */}
                {!decided && !isRejecting && (
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

              {!decided && isRejecting && (
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

/**
 * The tab switch, in the dashboard's segmented-control style (same markup as
 * CeoFilterBar's period picker) so it reads as part of the page rather than a
 * new idiom.
 *
 * The pending count rides on its own tab rather than in the panel title: it is
 * a property of that list, and a title-level badge would keep claiming
 * "3 pending" while the released tab is on screen.
 */
function Tabs({
  value,
  onChange,
  pendingCount,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
  pendingCount?: number;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
      {TABS.map((t) => {
        const active = value === t.key;
        const badge = t.key === "pending" && active ? pendingCount : undefined;
        return (
          <button
            key={t.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(t.key)}
            className={`px-3 h-7 text-xs font-semibold rounded-md transition-colors ${
              active ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
            {badge != null && badge > 0 && (
              <span className="ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Shell({
  children,
  header,
}: {
  children: React.ReactNode;
  header?: React.ReactNode;
}) {
  return (
    <div
      data-testid="pending-quotations-panel"
      className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm"
    >
      {/* flex-wrap, and the title truncates rather than shrinking the tabs:
          on a narrow column the switch drops to its own line instead of
          colliding with the heading. */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <ScrollText className="w-4 h-4 text-gray-400 shrink-0" />
        <h3 className="text-sm font-semibold text-gray-900 truncate">
          Quotation Approvals
        </h3>
        {header && <div className="ml-auto">{header}</div>}
      </div>
      {children}
    </div>
  );
}
