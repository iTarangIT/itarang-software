"use client";

/**
 * Admin buyback dashboard (V-round rewrite of the M22 page).
 *
 * The whole page now reads from ONE endpoint — `/api/admin/buyback/dashboard` —
 * which computes every block (KPIs+deltas, monthly money flow, pipeline funnel,
 * battery mix, dealer/vendor leaderboards) server-side under the SAME filter set.
 * A Date / Dealer / Vendor change re-fetches once and moves every number on the
 * page, instead of the old client-side pills that silently skipped the KPI row
 * and funnel. Charts are recharts, lazily loaded (`@/components/buyback/charts`,
 * `ssr:false`); every rupee still traces to `deal_line_locks` (the API's job).
 *
 * The funnel's five stages come from the shared `STAGE_BUCKETS` (src/lib/buyback/
 * flow.ts) — the same contract the Review Queue's `?stage=` deep-link reads — so
 * a stage row links straight to the queue pre-filtered to that stage.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Card, DealTable, ExportCsvButton, FilterPill, KpiCard, PageHeader } from "@/components/buyback/ui";
import type { DealTableHead, DealTableRow } from "@/components/buyback/ui";
import { MoneyFlowChart, MixDonut } from "@/components/buyback/charts";
import { inr } from "@/lib/buyback/format";

// ---- Payload types (mirror /api/admin/buyback/dashboard) -------------------
interface Kpi {
  value: number;
  delta: number | null;
}
interface DashboardPayload {
  kpis: {
    dealers: Kpi;
    requests: Kpi;
    active_negotiations: Kpi;
    margin: Kpi;
  };
  money_flow: { month: string; received: number; paid_out: number; margin_locked: number }[];
  funnel: { stage: string; key: string; deals: number; units: number; value_at_stake: number }[];
  mix: {
    chemistry: { key: string; units: number }[];
    brand: { key: string; units: number }[];
  };
  dealers: { entity_id: string; name: string; deals: number; closed: number; margin: number; paid_out: number }[];
  vendors: { vendor_id: string; name: string; threads: number; won: number; bid_to_win: number; bought: number }[];
}

const ALL = "ALL";

const DATE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days" },
  { value: "365", label: "Last 365 days" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

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

function count(n: number): string {
  return n.toLocaleString("en-IN");
}

/** The green/red delta sub-line under a KPI value. Hidden when delta is null. */
function DeltaLine({
  delta,
  money = false,
  presetDays,
  navy = false,
}: {
  delta: number | null;
  money?: boolean;
  presetDays: number;
  navy?: boolean;
}) {
  if (delta === null) return null;
  const up = delta > 0;
  const down = delta < 0;
  const arrow = up ? "▲" : down ? "▼" : "▬";
  const mag = Math.abs(delta);
  const magStr = money ? inr(mag) : count(mag);
  const signStr = delta === 0 ? "±0" : `${up ? "+" : "−"}${magStr}`;
  const tone = delta === 0
    ? navy
      ? "text-slate-300"
      : "text-slate-400"
    : up
      ? navy
        ? "text-green-300"
        : "text-green-600"
      : navy
        ? "text-rose-300"
        : "text-red-600";
  const muted = navy ? "text-[#9FB4C6]" : "text-slate-400";
  return (
    <span className={`mt-1 flex flex-wrap items-baseline gap-x-1 text-[11px] font-semibold ${tone}`}>
      <span>
        {arrow} {signStr}
      </span>
      <span className={`font-normal ${muted}`}>vs previous {presetDays} days</span>
    </span>
  );
}

function KpiValue({
  main,
  delta,
  money = false,
  presetDays,
  navy = false,
}: {
  main: string;
  delta: number | null;
  money?: boolean;
  presetDays: number;
  navy?: boolean;
}) {
  return (
    <span className="flex flex-col">
      <span>{main}</span>
      <DeltaLine delta={delta} money={money} presetDays={presetDays} navy={navy} />
    </span>
  );
}

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-200/70 ${className}`} />;
}

function DashboardSkeleton() {
  return (
    <>
      <div className="mb-[22px] grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[92px]" />
        ))}
      </div>
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <SkeletonBlock className="h-[320px]" />
        <SkeletonBlock className="h-[320px]" />
      </div>
      <div className="mb-4">
        <SkeletonBlock className="h-[300px]" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SkeletonBlock className="h-[260px]" />
        <SkeletonBlock className="h-[260px]" />
      </div>
    </>
  );
}

export default function AdminBuybackDashboardPage() {
  const router = useRouter();

  const [preset, setPreset] = useState("90");
  const [dealerFilter, setDealerFilter] = useState(ALL);
  const [vendorFilter, setVendorFilter] = useState(ALL);
  const [mixDim, setMixDim] = useState<"chemistry" | "brand">("chemistry");

  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Option lists are captured ONLY from an unfiltered fetch — a fetch narrowed
  // to one dealer/vendor returns a one-row leaderboard, which must not shrink
  // the dropdowns.
  const [dealerOptions, setDealerOptions] = useState([{ value: ALL, label: "All dealers" }]);
  const [vendorOptions, setVendorOptions] = useState([{ value: ALL, label: "All vendors" }]);

  const presetDays = Number(preset);

  // Filter changes / retry flip loading+error from the EVENT (idiomatic), not
  // synchronously inside the effect (which react-hooks/set-state-in-effect
  // rightly rejects as a cascading render). The effect only clears loading in
  // its promise callbacks. Mount starts loading=true via useState.
  const beginLoad = (apply: () => void) => {
    setError(null);
    setLoading(true);
    apply();
  };

  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams();
    params.set("from", new Date(Date.now() - presetDays * DAY_MS).toISOString());
    if (dealerFilter !== ALL) params.set("dealer", dealerFilter);
    if (vendorFilter !== ALL) params.set("vendor", vendorFilter);

    fetch(`/api/admin/buyback/dashboard?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load the buyback dashboard.");
          return;
        }
        const payload = j?.data as DashboardPayload;
        setData(payload);
        if (dealerFilter === ALL && vendorFilter === ALL) {
          setDealerOptions([
            { value: ALL, label: "All dealers" },
            ...payload.dealers.map((d) => ({ value: d.entity_id, label: d.name })),
          ]);
          setVendorOptions([
            { value: ALL, label: "All vendors" },
            ...payload.vendors.map((v) => ({ value: v.vendor_id, label: v.name })),
          ]);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the buyback dashboard.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [preset, dealerFilter, vendorFilter, reloadKey, presetDays]);

  // ---- Derived view data ---------------------------------------------------
  const moneyAllZero = useMemo(
    () =>
      !data ||
      data.money_flow.length === 0 ||
      data.money_flow.every((r) => r.received === 0 && r.paid_out === 0 && r.margin_locked === 0),
    [data],
  );

  const funnelMaxDeals = useMemo(
    () => (data ? Math.max(1, ...data.funnel.map((f) => f.deals)) : 1),
    [data],
  );

  const mixData = data ? data.mix[mixDim] : [];
  const mixTotal = mixData.reduce((s, r) => s + r.units, 0);

  const dealerMaxMargin = useMemo(
    () => (data ? Math.max(1, ...data.dealers.map((d) => Math.max(0, d.margin))) : 1),
    [data],
  );
  const vendorMaxBought = useMemo(
    () => (data ? Math.max(1, ...data.vendors.map((v) => Math.max(0, v.bought))) : 1),
    [data],
  );

  const dealerCsvRows =
    data?.dealers.map((r) => ({
      Dealer: r.name,
      Deals: r.deals,
      Closed: r.closed,
      Margin: r.margin,
      "Paid out": r.paid_out,
    })) ?? [];

  const vendorCsvRows =
    data?.vendors.map((r) => ({
      Vendor: r.name,
      Threads: r.threads,
      Won: r.won,
      "Bid-to-win": `${r.bid_to_win}%`,
      Bought: r.bought,
    })) ?? [];

  const dealerTableRows: DealTableRow[] =
    data?.dealers.map((r) => ({
      key: r.entity_id,
      onClick: () => router.push(`/admin/buyback?dealer=${encodeURIComponent(r.name)}`),
      ariaLabel: `Filter queue to ${r.name}`,
      cells: [
        <div key="dealer">
          <div className="font-bold text-slate-900">{r.name}</div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-slate-100">
            <div
              className="h-full rounded bg-green-500"
              style={{ width: `${(Math.max(0, r.margin) / dealerMaxMargin) * 100}%` }}
            />
          </div>
        </div>,
        r.deals,
        r.closed,
        <span key="margin" className="text-right font-semibold tabular-nums text-slate-900">
          {inr(r.margin)}
        </span>,
      ],
    })) ?? [];

  const vendorTableRows: DealTableRow[] =
    data?.vendors.map((r) => ({
      key: r.vendor_id,
      onClick: () => router.push("/admin/buyback/vendors"),
      ariaLabel: `Open vendors — ${r.name}`,
      cells: [
        <div key="vendor">
          <div className="font-bold text-slate-900">{r.name}</div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-slate-100">
            <div
              className="h-full rounded bg-[color:var(--color-bb-navy,#0B2239)]"
              style={{ width: `${(Math.max(0, r.bought) / vendorMaxBought) * 100}%` }}
            />
          </div>
        </div>,
        r.threads,
        r.won,
        <span key="btw" className="text-right font-semibold tabular-nums text-slate-900">
          {r.bid_to_win}%
        </span>,
      ],
    })) ?? [];

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Buyback Dashboard"
          sub="iTarang buyback operations — money moved, margin made, pipeline health"
        />

        <div className="mb-4 flex flex-wrap gap-2">
          <FilterPill
            label="Date"
            value={preset}
            options={DATE_OPTIONS}
            onChange={(v) => beginLoad(() => setPreset(v))}
          />
          <FilterPill
            label="Dealer"
            value={dealerFilter}
            options={dealerOptions}
            onChange={(v) => beginLoad(() => setDealerFilter(v))}
          />
          <FilterPill
            label="Vendor"
            value={vendorFilter}
            options={vendorOptions}
            onChange={(v) => beginLoad(() => setVendorFilter(v))}
          />
        </div>

        {error ? (
          <Card>
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <p className="text-sm text-slate-500">{error}</p>
              <button
                type="button"
                onClick={() => beginLoad(() => setReloadKey((k) => k + 1))}
                className="rounded-lg bg-[color:var(--color-bb-navy,#0B2239)] px-4 py-2 text-[12.5px] font-semibold text-white hover:opacity-90"
              >
                Retry
              </button>
            </div>
          </Card>
        ) : loading || !data ? (
          <DashboardSkeleton />
        ) : (
          <>
            {/* ---- KPI row ---- */}
            <div className="mb-[22px] grid grid-cols-2 gap-3.5 sm:grid-cols-4">
              <KpiCard
                label="Total Dealers"
                value={
                  <KpiValue main={count(data.kpis.dealers.value)} delta={data.kpis.dealers.delta} presetDays={presetDays} />
                }
              />
              <KpiCard
                label="Total Requests"
                accent="text-blue-600"
                value={
                  <KpiValue
                    main={count(data.kpis.requests.value)}
                    delta={data.kpis.requests.delta}
                    presetDays={presetDays}
                  />
                }
              />
              <KpiCard
                label="Active Negotiations"
                accent="text-amber-500"
                value={
                  <KpiValue
                    main={count(data.kpis.active_negotiations.value)}
                    delta={data.kpis.active_negotiations.delta}
                    presetDays={presetDays}
                  />
                }
              />
              <KpiCard
                label="TOTAL MARGIN"
                variant="navy"
                note="Locked deal values"
                value={
                  <KpiValue
                    main={inr(data.kpis.margin.value)}
                    delta={data.kpis.margin.delta}
                    money
                    presetDays={presetDays}
                    navy
                  />
                }
              />
            </div>

            {/* ---- Money flow + Funnel ---- */}
            <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
              <Card title="Money flow">
                <div className="p-4">
                  {moneyAllZero ? (
                    <p className="py-16 text-center text-sm text-slate-400">
                      No settlements in this window.
                    </p>
                  ) : (
                    <MoneyFlowChart data={data.money_flow} />
                  )}
                </div>
              </Card>

              <Card title="Pipeline funnel">
                <div className="p-[18px]">
                  {data.funnel.map((stage, i) => {
                    const prev = i > 0 ? data.funnel[i - 1] : null;
                    const conv = prev && prev.deals > 0 ? Math.round((stage.deals / prev.deals) * 100) : null;
                    return (
                      <Link
                        key={stage.key}
                        href={`/admin/buyback?stage=${stage.key}`}
                        className="mb-2.5 block rounded-lg px-2 py-1.5 transition last:mb-0 hover:bg-slate-50 hover:ring-1 hover:ring-slate-200"
                      >
                        <div className="mb-1 flex items-center justify-between text-[12px]">
                          <span className="flex items-center gap-2 font-semibold text-slate-600">
                            {stage.stage}
                            {conv !== null && (
                              <span className="rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-bold text-slate-500">
                                {conv}%
                              </span>
                            )}
                          </span>
                          <span className="font-bold text-slate-900">{count(stage.deals)}</span>
                        </div>
                        <div className="h-[10px] overflow-hidden rounded-md bg-slate-100">
                          <div
                            className="h-full rounded-md bg-[color:var(--color-bb-navy,#0B2239)]"
                            style={{ width: `${(stage.deals / funnelMaxDeals) * 100}%` }}
                          />
                        </div>
                        <div className="mt-1 text-[11px] text-slate-400">
                          {count(stage.units)} units · {inr(stage.value_at_stake)} at stake
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </Card>
            </div>

            {/* ---- Battery mix ---- */}
            <div className="mb-4">
              <Card
                title="Battery mix"
                action={
                  <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
                    {(["chemistry", "brand"] as const).map((dim) => (
                      <button
                        key={dim}
                        type="button"
                        onClick={() => setMixDim(dim)}
                        className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold capitalize transition ${
                          mixDim === dim ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                        }`}
                      >
                        {dim}
                      </button>
                    ))}
                  </div>
                }
              >
                <div className="p-[18px]">
                  {mixData.length === 0 ? (
                    <p className="py-12 text-center text-sm text-slate-400">
                      No intake lines in this window.
                    </p>
                  ) : (
                    <MixDonut data={mixData} centerLabel={`${count(mixTotal)} units`} />
                  )}
                </div>
              </Card>
            </div>

            {/* ---- Leaderboards ---- */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card
                title="Dealer-wise deals"
                action={<ExportCsvButton filename="buyback-dealers.csv" rows={dealerCsvRows} />}
              >
                <DealTable
                  heads={DEALER_HEADS}
                  rows={dealerTableRows}
                  empty={dealerFilter === ALL ? "No dealer deals in this window." : "No deals for this dealer."}
                />
              </Card>

              <Card
                title="Vendor-wise deals"
                action={<ExportCsvButton filename="buyback-vendors.csv" rows={vendorCsvRows} />}
              >
                <DealTable
                  heads={VENDOR_HEADS}
                  rows={vendorTableRows}
                  empty={vendorFilter === ALL ? "No vendor deals in this window." : "No deals for this vendor."}
                />
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
