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
 * Filters are client-side over the already-fetched queue — the API
 * (src/app/api/admin/buyback/queue/route.ts) is untouched. EVERY column has
 * one: Source (the Request column's badge), Dealer, City, Provenance, Dealer
 * quote, SLA aging, Status — plus the Date range. Option lists for Source /
 * Dealer / City / Status are derived from the data itself, so a filter never
 * offers a value with zero rows behind it.
 *
 * E-192: the initial fetch caps at `?limit=500`. When the API reports
 * `has_more`, a "Load more" row appears under the table and fetches the next
 * page at `?offset=<rows loaded so far>`, appending to `queue`. Filters keep
 * running client-side over everything loaded so far — unchanged.
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
  ExportCsvButton,
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

const PROVENANCE_OPTIONS = [
  { value: ALL, label: "All" },
  { value: "FULL", label: "Complete (100%)" },
  { value: "PARTIAL", label: "Partial (1–99%)" },
  { value: "NONE", label: "None (0%)" },
];

const QUOTE_OPTIONS = [
  { value: ALL, label: "All" },
  { value: "LT50K", label: "Under ₹50k" },
  { value: "50K_2L", label: "₹50k – ₹2L" },
  { value: "GT2L", label: "Over ₹2L" },
];

const SLA_OPTIONS = [
  { value: ALL, label: "All" },
  { value: "LT24H", label: "Under 24h" },
  { value: "1_3D", label: "1–3 days" },
  { value: "GT3D", label: "Over 3 days" },
];

const SOURCE_LABELS: Record<string, string> = {
  WEB: "Web",
  WHATSAPP: "WhatsApp",
  CSV: "CSV",
};

/** Queue age in hours — hours_in_queue when the API sent it, else days × 24. */
function ageHours(r: QueueRow): number {
  if (typeof r.hours_in_queue === "number") return r.hours_in_queue;
  return (r.days_in_queue ?? 0) * 24;
}

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
  // E-192 — Load more: hasMore mirrors the API's `has_more`; loadingMore
  // guards against double-clicks firing overlapping fetches.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [statusFilter, setStatusFilter] = useState(ALL);
  const [dealerFilter, setDealerFilter] = useState(ALL);
  const [cityFilter, setCityFilter] = useState(ALL);
  const [sourceFilter, setSourceFilter] = useState(ALL);
  const [provenanceFilter, setProvenanceFilter] = useState(ALL);
  const [quoteFilter, setQuoteFilter] = useState(ALL);
  const [slaFilter, setSlaFilter] = useState(ALL);
  const [dateFilter, setDateFilter] = useState(ALL);
  // "Now", for the date-range filter's cutoff — captured once the queue
  // loads rather than read via Date.now() during render/useMemo, which
  // react-hooks/purity (rightly) rejects as an impure render call.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/buyback/queue?limit=500")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load the review queue.");
          return;
        }
        setQueue(j?.data?.queue ?? []);
        setHasMore(Boolean(j?.data?.has_more));
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

  // E-192 — fetches the next 500 rows (offset = rows already loaded) and
  // appends. Client-side filters (below) keep running over the full,
  // growing `queue` array unchanged.
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/admin/buyback/queue?limit=500&offset=${queue.length}`);
      const j = await res.json();
      if (j?.success === false) {
        setError(j?.error?.message ?? "Could not load more requests.");
        return;
      }
      setQueue((prev) => [...prev, ...((j?.data?.queue ?? []) as QueueRow[])]);
      setHasMore(Boolean(j?.data?.has_more));
    } catch {
      setError("Could not load more requests.");
    } finally {
      setLoadingMore(false);
    }
  };

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

  const cityOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of queue) {
      if (r.dealer_city) seen.add(r.dealer_city);
    }
    return [
      { value: ALL, label: "All" },
      ...[...seen].sort().map((city) => ({ value: city, label: city })),
    ];
  }, [queue]);

  const sourceOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of queue) {
      if (r.source_channel) seen.add(r.source_channel);
    }
    return [
      { value: ALL, label: "All" },
      ...[...seen].sort().map((s) => ({ value: s, label: SOURCE_LABELS[s] ?? s })),
    ];
  }, [queue]);

  const filtered = useMemo(() => {
    const now = loadedAt ?? 0;
    const cutoff = dateFilter === ALL ? null : now - Number(dateFilter) * 24 * 60 * 60 * 1000;

    return queue.filter((r) => {
      if (statusFilter !== ALL && r.status !== statusFilter) return false;
      if (dealerFilter !== ALL && r.dealer_name !== dealerFilter) return false;
      if (cityFilter !== ALL && r.dealer_city !== cityFilter) return false;
      if (sourceFilter !== ALL && r.source_channel !== sourceFilter) return false;

      if (provenanceFilter !== ALL) {
        const pct = r.provenance_pct ?? 0;
        if (provenanceFilter === "FULL" && pct < 100) return false;
        if (provenanceFilter === "PARTIAL" && (pct <= 0 || pct >= 100)) return false;
        if (provenanceFilter === "NONE" && pct > 0) return false;
      }

      if (quoteFilter !== ALL) {
        const quote = r.dealer_quote ?? 0;
        if (quoteFilter === "LT50K" && quote >= 50_000) return false;
        if (quoteFilter === "50K_2L" && (quote < 50_000 || quote > 200_000)) return false;
        if (quoteFilter === "GT2L" && quote <= 200_000) return false;
      }

      if (slaFilter !== ALL) {
        const hours = ageHours(r);
        if (slaFilter === "LT24H" && hours >= 24) return false;
        if (slaFilter === "1_3D" && (hours < 24 || hours > 72)) return false;
        if (slaFilter === "GT3D" && hours <= 72) return false;
      }

      if (cutoff !== null) {
        const ts = rowTimestamp(r, now);
        if (ts === null || ts < cutoff) return false;
      }
      return true;
    });
  }, [
    queue,
    statusFilter,
    dealerFilter,
    cityFilter,
    sourceFilter,
    provenanceFilter,
    quoteFilter,
    slaFilter,
    dateFilter,
    loadedAt,
  ]);

  // U6 — flat, human-readable CSV mapper over the CURRENTLY loaded+filtered
  // rows (same `filtered` array the table renders), not the raw API shape.
  const csvRows = filtered.map((r) => ({
    Request: r.request_no,
    Source: SOURCE_LABELS[r.source_channel] ?? r.source_channel,
    Dealer: r.dealer_name,
    City: r.dealer_city ?? "",
    "Total units": r.total_units,
    "Dealer quote": r.dealer_quote,
    "Provenance %": r.provenance_pct,
    "Days in queue": r.days_in_queue,
    Status: statusLabel(r.status),
  }));

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
          // U5 — the row itself is already a keyboard target (role="link",
          // Enter/Space). Without this the nested Link is a SECOND, redundant
          // tab stop landing on the same destination.
          tabIndex={-1}
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
          right={
            <div className="flex flex-wrap items-center gap-2">
              <AdminBuybackSearch />
              <ExportCsvButton filename="buyback-queue.csv" rows={csvRows} />
            </div>
          }
        />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !loading && queue.length === 0 ? (
          <EmptyState icon="✅" title="The queue is empty" body="Nothing is waiting on iTarang." />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              <FilterPill label="Source" value={sourceFilter} options={sourceOptions} onChange={setSourceFilter} />
              <FilterPill label="Dealer" value={dealerFilter} options={dealerOptions} onChange={setDealerFilter} />
              <FilterPill label="City" value={cityFilter} options={cityOptions} onChange={setCityFilter} />
              <FilterPill
                label="Provenance"
                value={provenanceFilter}
                options={PROVENANCE_OPTIONS}
                onChange={setProvenanceFilter}
              />
              <FilterPill label="Quote" value={quoteFilter} options={QUOTE_OPTIONS} onChange={setQuoteFilter} />
              <FilterPill label="SLA" value={slaFilter} options={SLA_OPTIONS} onChange={setSlaFilter} />
              <FilterPill label="Status" value={statusFilter} options={statusOptions} onChange={setStatusFilter} />
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
              {/* E-192 — Load more: only the currently-fetched page filters
                  client-side; this pulls the next 500 in from the server. */}
              {!loading && hasMore && (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="w-full border-t border-[#F4F6F9] px-[18px] py-3 text-center text-[12.5px] font-semibold text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadingMore ? "Loading…" : `Load more (${queue.length} shown)`}
                </button>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
