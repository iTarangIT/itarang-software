"use client";

/**
 * M06 — the admin review queue.
 *
 * Columns per the design handoff (iTarang Portal.dc.html scrReview, lines
 * 822-840): Request · Dealer · Provenance · Dealer quote · SLA aging ·
 * Status. Built entirely from the shared buyback UI kit
 * (src/components/buyback/ui) rather than re-implementing the prototype's
 * inline styles here.
 *
 * The provenance bar reflects ALL lines on the request. The prototype computed it
 * from `d.lines[0]` alone, so a two-SKU request whose second battery had no
 * paperwork at all still showed 100% and sailed into review.
 *
 * Filters (Status / Dealer / Date range) are client-side over the already-
 * fetched queue — the API (src/app/api/admin/buyback/queue/route.ts) is
 * untouched, and already returns created_at/submitted_at for the date filter.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  PageHeader,
  Card,
  FilterPill,
  SourceBadge,
  DealTable,
  ProvenanceBar,
  SlaChip,
  EmptyState,
} from "@/components/buyback/ui";
import type { DealTableHead, DealTableRow } from "@/components/buyback/ui";
import StatusChip, { statusLabel } from "@/components/buyback/StatusChip";
import AdminBuybackSearch from "@/components/buyback/AdminBuybackSearch";
import { inr } from "@/lib/buyback/format";

interface QueueRow {
  request_id: string;
  request_no: string;
  source_channel: string;
  status: string;
  dealer_name: string;
  dealer_city: string | null;
  total_units: number;
  dealer_quote: number;
  provenance_pct: number;
  days_in_queue: number;
  hours_in_queue: number;
  created_at?: string | null;
  submitted_at?: string | null;
}

const ALL = "ALL";

const DATE_RANGE_OPTIONS = [
  { value: ALL, label: "All time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

const HEADS: DealTableHead[] = [
  { label: "Request" },
  { label: "Dealer" },
  { label: "Provenance" },
  { label: "Dealer quote", align: "right" },
  { label: "SLA aging" },
  { label: "Status" },
];

/**
 * The row's best-known submit timestamp, in ms. Prefers submitted_at, then
 * created_at, and falls back to `now - days_in_queue` (the API always
 * returns that, so the date filter never silently drops a row over a
 * missing timestamp). `now` is passed in rather than read via Date.now()
 * here — this runs inside a useMemo filter, and React's purity rule
 * (rightly) rejects impure calls during render.
 */
function rowTimestamp(r: QueueRow, now: number): number | null {
  const raw = r.submitted_at ?? r.created_at;
  if (raw) {
    const t = new Date(raw).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (typeof r.days_in_queue === "number") {
    return now - r.days_in_queue * 24 * 60 * 60 * 1000;
  }
  return null;
}

export default function AdminBuybackQueuePage() {
  const router = useRouter();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState(ALL);
  const [dealerFilter, setDealerFilter] = useState(ALL);
  const [dateFilter, setDateFilter] = useState(ALL);
  // "Now", for the date-range filter's cutoff — captured once the queue
  // loads rather than read via Date.now() during render/useMemo, which
  // react-hooks/purity (rightly) rejects as an impure render call.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/buyback/queue")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load the review queue.");
          return;
        }
        setQueue(j?.data?.queue ?? []);
        setLoadedAt(Date.now());
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the review queue.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const statusOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of queue) {
      if (!seen.has(r.status)) seen.set(r.status, statusLabel(r.status));
    }
    return [
      { value: ALL, label: "All" },
      ...[...seen.entries()].map(([value, label]) => ({ value, label })),
    ];
  }, [queue]);

  const dealerOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of queue) {
      if (r.dealer_name) seen.add(r.dealer_name);
    }
    return [
      { value: ALL, label: "All" },
      ...[...seen].sort().map((name) => ({ value: name, label: name })),
    ];
  }, [queue]);

  const filtered = useMemo(() => {
    const now = loadedAt ?? 0;
    const cutoff = dateFilter === ALL ? null : now - Number(dateFilter) * 24 * 60 * 60 * 1000;

    return queue.filter((r) => {
      if (statusFilter !== ALL && r.status !== statusFilter) return false;
      if (dealerFilter !== ALL && r.dealer_name !== dealerFilter) return false;
      if (cutoff !== null) {
        const ts = rowTimestamp(r, now);
        if (ts === null || ts < cutoff) return false;
      }
      return true;
    });
  }, [queue, statusFilter, dealerFilter, dateFilter, loadedAt]);

  const rows: DealTableRow[] = filtered.map((r) => ({
    key: r.request_id,
    onClick: () => router.push(`/admin/buyback/${r.request_id}`),
    ariaLabel: `Open ${r.request_no}`,
    cells: [
      <div key="request" className="flex items-center gap-2">
        {/* Nested Link kept for middle-click/open-in-new-tab support. Its
         * onClick stops propagation so the row handler doesn't also push —
         * two navigations per click broke the browser Back button. */}
        <Link
          href={`/admin/buyback/${r.request_id}`}
          className="font-bold text-slate-900 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {r.request_no}
        </Link>
        <SourceBadge source={r.source_channel} />
      </div>,
      <div key="dealer">
        <div className="font-semibold text-slate-800">{r.dealer_name}</div>
        <div className="text-[11.5px] text-slate-400">{r.dealer_city ?? "—"}</div>
      </div>,
      <ProvenanceBar key="provenance" pct={r.provenance_pct} />,
      <div key="quote" className="text-right font-semibold tabular-nums text-slate-900">
        {inr(r.dealer_quote)}
      </div>,
      <SlaChip key="sla" days={r.days_in_queue} hours={r.hours_in_queue} />,
      <StatusChip key="status" status={r.status} />,
    ],
  }));

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Review Queue"
          sub="Requests awaiting review, negotiation & routing"
          right={<AdminBuybackSearch />}
        />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !loading && queue.length === 0 ? (
          <EmptyState icon="✅" title="The queue is empty" body="Nothing is waiting on iTarang." />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              <FilterPill label="Status" value={statusFilter} options={statusOptions} onChange={setStatusFilter} />
              <FilterPill label="Dealer" value={dealerFilter} options={dealerOptions} onChange={setDealerFilter} />
              <FilterPill
                label="Date range"
                value={dateFilter}
                options={DATE_RANGE_OPTIONS}
                onChange={setDateFilter}
              />
            </div>

            <Card>
              <DealTable
                heads={HEADS}
                rows={rows}
                loading={loading ? "Loading…" : undefined}
                empty={!loading ? "No requests match these filters." : undefined}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
