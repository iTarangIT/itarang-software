"use client";

/**
 * Shared dealer-facing requests table — proto table() columns (design handoff
 * iTarang Portal.dc.html:468-475, used by both scrDealerDash:453 and
 * scrMyRequests:605): Request · Date · Batteries · Est. value · Status.
 *
 * Used by both the dashboard's "Recent requests" card (top 5 rows, caller
 * slices) and the My Requests page (all rows) — one row shape, one place that
 * knows how to render it, so the two screens can't drift.
 *
 * Single navigation per row click: the whole <tr> is the click target (via
 * DealTable's row.onClick); the nested request_no Link exists only for
 * middle-click / open-in-new-tab and stops propagation so it never
 * double-navigates — same pattern as the admin queue
 * (src/app/(dashboard)/admin/buyback/page.tsx).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";

import { DealTable, SourceBadge } from "@/components/buyback/ui";
import type { DealTableHead, DealTableRow } from "@/components/buyback/ui";
import StatusChip from "@/components/buyback/StatusChip";
import { inr } from "@/lib/buyback/format";

/** One reason a DRAFT can't be submitted — mirrors GateIssue on the server. */
export interface DraftBlocker {
  line_id: string | null;
  code:
    | "NO_LINES"
    | "TOO_FEW_PHOTOS"
    | "MISSING_PROVENANCE"
    | "MISSING_SPECS"
    | "QTY_SPLIT_MISMATCH";
  message: string;
}

/** The dealer's own view of a request row — GET /api/buyback/requests. */
export interface DealerRequestRow {
  request_id: string;
  request_no: string;
  status: string;
  source_channel: string;
  created_at: string;
  submitted_at: string | null;
  total_units: number;
  dealer_quote: number;
  /**
   * Why this draft can't be submitted yet. Null for anything already
   * submitted — the question doesn't apply, and [] there would read as
   * "nothing is blocking it". Straight from the submit gate, so it says
   * exactly what the Submit button would.
   */
  draft_blockers?: DraftBlocker[] | null;
}

const HEADS: DealTableHead[] = [
  { label: "Request" },
  { label: "Date" },
  { label: "Batteries" },
  { label: "Est. value", align: "right" },
  { label: "Status" },
];

export default function DealerRequestsTable({
  requests,
  loading,
  emptyMessage = "No requests yet.",
}: {
  requests: DealerRequestRow[];
  loading?: boolean;
  emptyMessage?: string;
}) {
  const router = useRouter();

  const rows: DealTableRow[] = requests.map((r) => ({
    key: r.request_id,
    onClick: () => router.push(`/dealer-portal/buyback/${r.request_id}`),
    ariaLabel: `Open ${r.request_no}`,
    cells: [
      <div key="request" className="flex items-center gap-2">
        <Link
          href={`/dealer-portal/buyback/${r.request_id}`}
          className="font-bold text-slate-900 hover:underline"
          onClick={(e) => e.stopPropagation()}
          // U5 — the row itself is already a keyboard target (role="link",
          // Enter/Space). Without this the nested Link is a SECOND, redundant
          // tab stop landing on the same destination.
          tabIndex={-1}
        >
          {r.request_no}
        </Link>
        <SourceBadge source={r.source_channel} />
      </div>,
      <div key="date" className="text-slate-600">
        {new Date(r.submitted_at ?? r.created_at).toLocaleDateString("en-IN")}
      </div>,
      <div key="units" className="text-slate-600">
        {r.total_units} units
      </div>,
      <div key="value" className="text-right font-semibold tabular-nums text-slate-900">
        {inr(r.dealer_quote)}
      </div>,
      <StatusChip key="status" status={r.status} />,
    ],
  }));

  return (
    <DealTable
      heads={HEADS}
      rows={rows}
      loading={loading ? "Loading…" : undefined}
      empty={!loading ? emptyMessage : undefined}
    />
  );
}
