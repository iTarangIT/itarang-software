"use client";

/**
 * M22 — the admin buyback dashboard (design handoff, iTarang Portal.dc.html
 * `scrAdminDash`, lines 785-818): a KPI row (incl. the navy "Total Margin
 * Earned" hero), a margin-by-month bar chart, a pipeline funnel, and
 * dealer-wise / vendor-wise breakdown tables.
 *
 * Built entirely off /api/admin/buyback/reports (previously landed for M22
 * but with no UI caller until now) and /api/admin/buyback/ledger's
 * reconciliation block — per M22's AC, "no report reads live catalog
 * prices." Every rupee here traces back to `deal_line_locks` (frozen at
 * agreement, fill-once) or the settlement ledger, never `catalog_variants`.
 *
 * KPI/chart sourcing (see reports/route.ts + ledger/route.ts docblocks):
 *   - Total Dealers        = row count of reports?type=dealer
 *   - Total Requests       = SUM(deals) across every reports?type=funnel row
 *                            (every bd.status, not just the open queue) —
 *                            ONE source for the whole KPI row rather than
 *                            re-deriving a second count from the queue.
 *   - Active Negotiations  = SUM(deals) from funnel rows whose status is
 *                            NEGOTIATING / FINAL_OFFER_SENT / VENDOR_ROUTED /
 *                            VENDOR_NEGOTIATING
 *   - Total Margin Earned  = ledger reconciliation.expected_margin — the
 *                            realised margin (Σ qty × (vendor_price −
 *                            dealer_price)) scoped to CLOSED deals, which by
 *                            the ledger route's own AC equals ledger_net.
 *   - Margin by month      = reports?type=margin rows, grouped by month of
 *                            `raised_at` (Ext-4), summing realised_margin.
 *                            This is ALL locked deals regardless of status —
 *                            a different scope than the CLOSED-only KPI
 *                            above, since that's what the margin report
 *                            returns; the trend line is deliberately wider
 *                            than the headline number.
 *   - Pipeline funnel      = reports?type=funnel rows, bucketed into the 5
 *                            proto stages.
 *   - Dealer/Vendor tables = reports?type=dealer / ?type=vendor rows.
 *
 * Filter pills (Date / Dealer / Vendor) are client-side, turning the proto's
 * decorative pills into real controls (matching the review queue's
 * FilterPill pattern). Margin rows are the only dataset carrying date +
 * dealer + vendor together, so the pills drive the "Margin by month" chart
 * and, by dealer/vendor name, narrow the two breakdown tables. The top KPI
 * row and the funnel stay unfiltered network-overview numbers: funnel rows
 * carry only a status (no dealer/vendor/date to filter on), and Total Margin
 * Earned is the single reconciled ledger figure — narrowing either without a
 * new endpoint parameter is out of scope (constraints: "no other endpoint
 * changes").
 *
 * E-192-C: `/reports` (margin/funnel/dealer/vendor, all fetched with no
 * params below) now defaults to the last 12 months server-side when neither
 * `from` nor `to` is passed. Every number on this page — including the "All
 * time" pill option, which used to mean exactly that — is therefore scoped
 * to the last 12 months; the pill is relabelled "Last 12 months" rather than
 * silently keeping a name it no longer delivers on. `reports?type=dealer`'s
 * row count (Total Dealers) and `?type=vendor`'s breakdown table are also
 * now capped at 200 rows server-side (`has_more` is not surfaced here — this
 * is an operations overview, not a paginated list; Payments & Settlement and
 * the Ledger page are where a stuck old deal must never silently disappear,
 * and those explicitly opt out of the window instead).
 */

import { useEffect, useMemo, useState } from "react";

import { Card, DealTable, FilterPill, KpiCard, PageHeader } from "@/components/buyback/ui";
import type { DealTableHead, DealTableRow } from "@/components/buyback/ui";
import { inr } from "@/lib/buyback/format";

interface MarginRow {
  request_no: string;
  dealer: string;
  vendor: string;
  status: string;
  units: number | string;
  dealer_total: number | string;
  vendor_total: number | string;
  planned_margin: number | string;
  realised_margin: number | string;
  raised_at: string | null;
}

interface FunnelRow {
  status: string;
  deals: number;
  units: number | string;
  value_at_stake: number | string;
}

interface DealerRow {
  dealer: string;
  requests: number;
  closed: number;
  units: number | string;
  paid_out: number | string;
  margin_earned: number | string | null;
}

interface VendorRow {
  vendor: string;
  quoted_on: number;
  won: number;
  bid_to_win: string;
  bought: number | string;
  avg_days_to_pay: number | null;
}

interface LedgerReconciliation {
  scope: string;
  ledger_net: number;
  expected_margin: number;
  planned_margin: number;
  uplift: number;
  difference: number;
  reconciled: boolean;
}

const ALL = "ALL";

const DATE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days" },
  // The underlying /reports fetches now default to a 12-month server-side
  // window (E-192-C) — this option no longer means true all-time, so it is
  // labelled to match what it actually shows.
  { value: ALL, label: "Last 12 months" },
];

const NEGOTIATION_STATUSES = new Set([
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
  "VENDOR_ROUTED",
  "VENDOR_NEGOTIATING",
]);

// Proto's 5 funnel buckets (handoff:791), each rolling up a set of
// buyback_deals.status values. Colors match the handoff exactly.
const FUNNEL_BUCKETS: { label: string; statuses: string[]; color: string }[] = [
  { label: "Submitted", statuses: ["SUBMITTED", "UNDER_REVIEW", "INFO_REQUESTED"], color: "#2563EB" },
  { label: "Reviewed", statuses: ["NEGOTIATING", "FINAL_OFFER_SENT", "DEALER_ACCEPTED"], color: "#0EA5E9" },
  {
    label: "Locked",
    statuses: ["MARGIN_SET", "VENDOR_ROUTED", "VENDOR_NEGOTIATING", "VENDOR_AGREED", "PO_EXCHANGED"],
    color: "#16A34A",
  },
  {
    label: "Picked",
    statuses: ["PICKUP_SCHEDULED", "PICKED_UP", "INVOICE_RAISED", "INVOICE_APPROVED"],
    color: "#0D9488",
  },
  { label: "Settled", statuses: ["SETTLED", "CLOSED"], color: "#166534" },
];

const DEALER_HEADS: DealTableHead[] = [
  { label: "Dealer" },
  { label: "Deals" },
  { label: "Closed" },
  { label: "Margin", align: "right" },
];

const VENDOR_HEADS: DealTableHead[] = [
  { label: "Vendor" },
  { label: "Threads" },
  { label: "Won" },
  { label: "Bid-to-win", align: "right" },
];

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-200/70 ${className}`} />;
}

function DashboardSkeleton() {
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <SkeletonBlock className="h-8 w-40" />
        <SkeletonBlock className="h-8 w-32" />
        <SkeletonBlock className="h-8 w-32" />
      </div>
      <div className="mb-[22px] grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[84px]" />
        ))}
      </div>
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <SkeletonBlock className="h-[220px]" />
        <SkeletonBlock className="h-[220px]" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SkeletonBlock className="h-[240px]" />
        <SkeletonBlock className="h-[240px]" />
      </div>
    </>
  );
}

export default function AdminBuybackDashboardPage() {
  const [marginRows, setMarginRows] = useState<MarginRow[]>([]);
  const [funnelRows, setFunnelRows] = useState<FunnelRow[]>([]);
  const [dealerRows, setDealerRows] = useState<DealerRow[]>([]);
  const [vendorRows, setVendorRows] = useState<VendorRow[]>([]);
  const [reconciliation, setReconciliation] = useState<LedgerReconciliation | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // "Now", captured once all datasets have loaded — read during render/
  // useMemo would violate React's purity rule (react-hooks/purity), same
  // pattern as the review queue page's `loadedAt`.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const [dateFilter, setDateFilter] = useState("90");
  const [dealerFilter, setDealerFilter] = useState(ALL);
  const [vendorFilter, setVendorFilter] = useState(ALL);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [marginJson, funnelJson, dealerJson, vendorJson, ledgerJson] = await Promise.all([
          fetch("/api/admin/buyback/reports?type=margin").then((r) => r.json()),
          fetch("/api/admin/buyback/reports?type=funnel").then((r) => r.json()),
          // Total Dealers (KPI) is dealerRows.length — request the max
          // breakdown limit so that headline number isn't quietly capped at
          // the route's default 200.
          fetch("/api/admin/buyback/reports?type=dealer&limit=1000").then((r) => r.json()),
          fetch("/api/admin/buyback/reports?type=vendor&limit=1000").then((r) => r.json()),
          fetch("/api/admin/buyback/ledger").then((r) => r.json()),
        ]);

        if (cancelled) return;

        const failed = [marginJson, funnelJson, dealerJson, vendorJson, ledgerJson].find(
          (j) => j?.success === false,
        );
        if (failed) {
          setError(failed?.error?.message ?? "Could not load the buyback dashboard.");
          return;
        }

        setMarginRows(marginJson?.data?.rows ?? []);
        setFunnelRows(funnelJson?.data?.rows ?? []);
        setDealerRows(dealerJson?.data?.rows ?? []);
        setVendorRows(vendorJson?.data?.rows ?? []);
        setReconciliation(ledgerJson?.data?.reconciliation ?? null);
        setLoadedAt(Date.now());
      } catch {
        if (!cancelled) setError("Could not load the buyback dashboard.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- KPI row — unfiltered network-overview numbers (see file docblock) --
  const totalDealers = dealerRows.length;
  const totalRequests = funnelRows.reduce((sum, r) => sum + Number(r.deals ?? 0), 0);
  const activeNegotiations = funnelRows
    .filter((r) => NEGOTIATION_STATUSES.has(r.status))
    .reduce((sum, r) => sum + Number(r.deals ?? 0), 0);
  const totalMarginEarned = reconciliation?.expected_margin ?? 0;

  // ---- Filter option lists, derived from the fetched datasets ------------
  const dealerOptions = useMemo(
    () => [{ value: ALL, label: "All" }, ...dealerRows.map((r) => ({ value: r.dealer, label: r.dealer }))],
    [dealerRows],
  );
  const vendorOptions = useMemo(
    () => [{ value: ALL, label: "All" }, ...vendorRows.map((r) => ({ value: r.vendor, label: r.vendor }))],
    [vendorRows],
  );

  // ---- Margin by month — filtered margin rows, grouped by raised_at month
  const filteredMarginRows = useMemo(() => {
    const now = loadedAt ?? 0;
    const cutoff = dateFilter === ALL ? null : now - Number(dateFilter) * 24 * 60 * 60 * 1000;

    return marginRows.filter((r) => {
      if (dealerFilter !== ALL && r.dealer !== dealerFilter) return false;
      if (vendorFilter !== ALL && r.vendor !== vendorFilter) return false;
      if (cutoff !== null) {
        if (!r.raised_at) return false;
        const t = new Date(r.raised_at).getTime();
        if (Number.isNaN(t) || t < cutoff) return false;
      }
      return true;
    });
  }, [marginRows, dealerFilter, vendorFilter, dateFilter, loadedAt]);

  const monthlyMargin = useMemo(() => {
    const byMonth = new Map<string, { label: string; sortKey: string; total: number }>();
    for (const r of filteredMarginRows) {
      if (!r.raised_at) continue;
      const d = new Date(r.raised_at);
      if (Number.isNaN(d.getTime())) continue;
      const sortKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const entry = byMonth.get(sortKey) ?? {
        label: d.toLocaleDateString("en-US", { month: "short" }),
        sortKey,
        total: 0,
      };
      entry.total += Number(r.realised_margin ?? 0);
      byMonth.set(sortKey, entry);
    }
    // Last 6 months that actually have data, oldest first (chart reads
    // left-to-right chronologically, matching the prototype).
    return [...byMonth.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey)).slice(-6);
  }, [filteredMarginRows]);

  const marginMax = Math.max(1, ...monthlyMargin.map((m) => m.total));

  // ---- Pipeline funnel — unfiltered, bucketed into the 5 proto stages ----
  const funnelCounts = useMemo(
    () =>
      FUNNEL_BUCKETS.map((b) => ({
        ...b,
        count: funnelRows
          .filter((r) => b.statuses.includes(r.status))
          .reduce((sum, r) => sum + Number(r.deals ?? 0), 0),
      })),
    [funnelRows],
  );
  const funnelMax = Math.max(1, ...funnelCounts.map((b) => b.count));

  // ---- Breakdown tables — narrowed by the same Dealer/Vendor pills -------
  const filteredDealerRows = dealerFilter === ALL ? dealerRows : dealerRows.filter((r) => r.dealer === dealerFilter);
  const filteredVendorRows = vendorFilter === ALL ? vendorRows : vendorRows.filter((r) => r.vendor === vendorFilter);

  const dealerTableRows: DealTableRow[] = filteredDealerRows.map((r) => ({
    key: r.dealer,
    cells: [
      <span key="dealer" className="font-bold text-slate-900">
        {r.dealer}
      </span>,
      r.requests,
      r.closed,
      <span key="margin" className="text-right font-semibold tabular-nums text-slate-900">
        {inr(r.margin_earned)}
      </span>,
    ],
  }));

  const vendorTableRows: DealTableRow[] = filteredVendorRows.map((r) => ({
    key: r.vendor,
    cells: [
      <span key="vendor" className="font-bold text-slate-900">
        {r.vendor}
      </span>,
      r.quoted_on,
      r.won,
      <span key="btw" className="text-right font-semibold tabular-nums text-slate-900">
        {r.bid_to_win}
      </span>,
    ],
  }));

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Buyback Dashboard"
          sub="iTarang buyback operations — network overview, last 12 months"
        />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : loading ? (
          <DashboardSkeleton />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              <FilterPill label="Date" value={dateFilter} options={DATE_OPTIONS} onChange={setDateFilter} />
              <FilterPill label="Dealer" value={dealerFilter} options={dealerOptions} onChange={setDealerFilter} />
              <FilterPill label="Vendor" value={vendorFilter} options={vendorOptions} onChange={setVendorFilter} />
            </div>

            <div className="mb-[22px] grid grid-cols-2 gap-3.5 sm:grid-cols-4">
              <KpiCard label="Total Dealers" value={totalDealers} />
              <KpiCard label="Total Requests" value={totalRequests} accent="text-blue-600" />
              <KpiCard label="Active Negotiations" value={activeNegotiations} accent="text-amber-500" />
              <KpiCard
                label="TOTAL MARGIN EARNED"
                value={inr(totalMarginEarned)}
                note="From locked deal values"
                variant="navy"
              />
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
              <Card title="Margin by month">
                <div className="p-[18px]">
                  {monthlyMargin.length === 0 ? (
                    <p className="text-sm text-slate-400">No locked deals in this range.</p>
                  ) : (
                    <div className="flex h-[150px] items-end gap-3.5">
                      {monthlyMargin.map((m) => {
                        const height = Math.max(4, (m.total / marginMax) * 110);
                        return (
                          <div key={m.sortKey} className="flex flex-1 flex-col items-center gap-1.5">
                            <div className="text-[10.5px] font-bold tabular-nums text-slate-500">
                              ₹{Math.round(m.total / 1000)}k
                            </div>
                            <div
                              className="w-full max-w-[40px] rounded-t-md"
                              style={{
                                height: `${height}px`,
                                backgroundImage: "linear-gradient(180deg,#16A34A,#0EA05C)",
                              }}
                            />
                            <div className="text-[11px] text-slate-400">{m.label}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </Card>

              <Card title="Pipeline funnel">
                <div className="p-[18px]">
                  {funnelCounts.map((b) => (
                    <div key={b.label} className="mb-[11px] last:mb-0">
                      <div className="mb-1 flex items-center justify-between text-[12px]">
                        <span className="font-semibold text-slate-600">{b.label}</span>
                        <span className="font-bold text-slate-900">{b.count}</span>
                      </div>
                      <div className="h-[10px] overflow-hidden rounded-md bg-slate-100">
                        <div
                          className="h-full rounded-md"
                          style={{ width: `${(b.count / funnelMax) * 100}%`, background: b.color }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card title="Dealer-wise deals">
                <DealTable
                  heads={DEALER_HEADS}
                  rows={dealerTableRows}
                  empty={dealerFilter === ALL ? "No dealer deals yet." : "No deals for this dealer."}
                />
              </Card>

              <Card title="Vendor-wise deals">
                <DealTable
                  heads={VENDOR_HEADS}
                  rows={vendorTableRows}
                  empty={vendorFilter === ALL ? "No vendor deals yet." : "No deals for this vendor."}
                />
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
