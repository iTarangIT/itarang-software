"use client";

/**
 * Negotiations — live dealer & vendor threads, in one list (design handoff,
 * iTarang Portal.dc.html `scrNegotiations`, lines 950-955).
 *
 * Same data source as the review queue (`/api/admin/buyback/queue`) — this is
 * a NARROWER view of the same rows, filtered client-side to the statuses
 * where price is still being discussed, rather than a second endpoint. Rounds
 * · Latest · Version come from Ext-5 (queue route: neg_rounds,
 * last_offer_total, offer_version — offer_version already existed).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Card, DealTable, EmptyState, PageHeader, SourceBadge } from "@/components/buyback/ui";
import type { DealTableHead, DealTableRow } from "@/components/buyback/ui";
import StatusChip from "@/components/buyback/StatusChip";
import { inr } from "@/lib/buyback/format";

interface QueueRow {
  request_id: string;
  request_no: string;
  source_channel: string;
  status: string;
  offer_version: number;
  dealer_name: string;
  neg_rounds: number;
  last_offer_total: number | null;
}

// Negotiations screen's slice of the deal lifecycle — price discussion is
// still open on both legs. Matches the brief's status list exactly.
const LIVE_STATUSES = new Set([
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
  "VENDOR_ROUTED",
  "VENDOR_NEGOTIATING",
  "DEALER_ACCEPTED",
  "MARGIN_SET",
]);

const HEADS: DealTableHead[] = [
  { label: "Request" },
  { label: "Dealer" },
  { label: "Rounds" },
  { label: "Latest", align: "right" },
  { label: "Version" },
  { label: "Status" },
];

export default function AdminBuybackNegotiationsPage() {
  const router = useRouter();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/buyback/queue")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load negotiations.");
          return;
        }
        setQueue(j?.data?.queue ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load negotiations.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const live = queue.filter((r) => LIVE_STATUSES.has(r.status));

  const rows: DealTableRow[] = live.map((r) => ({
    key: r.request_id,
    onClick: () => router.push(`/admin/buyback/${r.request_id}`),
    ariaLabel: `Open ${r.request_no}`,
    cells: [
      <div key="request" className="flex items-center gap-2">
        <Link
          href={`/admin/buyback/${r.request_id}`}
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
      <span key="dealer" className="text-slate-700">
        {r.dealer_name}
      </span>,
      <span key="rounds" className="text-slate-600">
        {r.neg_rounds} round{r.neg_rounds === 1 ? "" : "s"}
      </span>,
      <span key="latest" className="text-right font-semibold tabular-nums text-slate-900">
        {r.last_offer_total === null ? "—" : inr(r.last_offer_total)}
      </span>,
      <span key="version" className="text-slate-500">
        v{r.offer_version}
      </span>,
      <StatusChip key="status" status={r.status} />,
    ],
  }));

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader title="Negotiations" sub="Live dealer & vendor threads" />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !loading && live.length === 0 ? (
          <EmptyState
            icon="🤝"
            title="No live negotiations"
            body="Deals appear here while price discussion is open."
          />
        ) : (
          <Card>
            <DealTable
              heads={HEADS}
              rows={rows}
              loading={loading ? "Loading…" : undefined}
              empty={!loading ? "No live negotiations." : undefined}
            />
          </Card>
        )}
      </div>
    </div>
  );
}
