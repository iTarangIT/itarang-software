"use client";

// CEO overview — "How the business is doing" (CRM Reporting & Dashboards
// redesign). One period control drives every figure. Each block reads the
// module that owns its definition (control tower, overview, data health,
// gross margin, snapshot summary, finance funnel, dealer health), so this
// screen cannot disagree with the report a card opens.
//
// A figure the CRM cannot compute is said to be unavailable — never filled
// with a placeholder number. The working panels that used to live here are on
// their own pages: /ceo/quotations, /ceo/finance, /ceo/intellicar. The Green
// Energy news card stays on this page; its full feed is /ceo/news.

import React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarRange,
  CircleCheck,
  FileText,
  RefreshCw,
  Target,
  TrendingDown,
  UserPlus,
} from "lucide-react";

import type { ControlTower, Compare } from "@/lib/dashboard/ceoControlTower";
import type { DataHealthCheck } from "@/lib/dashboard/dataHealth";
import type { GrossMarginReport } from "@/lib/dashboard/grossMargin";
import type { DealerHealthRow } from "@/lib/dealers/accountHealth";
import {
  ACCOUNT_BUCKETS,
  ACCOUNT_BUCKET_LABELS,
  type AccountBucket,
} from "@/lib/dealers/accountHealthRules";
import type { FunnelCountsResult } from "@/lib/admin/funnelCountsTypes";
import type { ReportResult } from "@/lib/admin/types";
import type { SalesDashboard } from "@/lib/admin/salesDashboardTypes";
import type { CeoOverviewData } from "@/components/dashboard/ceo/CeoOverviewCards";
import { DashboardSkeleton } from "@/components/dashboard/ceo/DashboardSkeleton";
import { GreenNewsCard } from "@/components/dashboard/ceo/GreenNewsCard";
import {
  ActionCard,
  CardLink,
  DashCard,
  DashPageHeader,
  KpiTile,
  LoadingBlock,
  NotAvailable,
  ProgressBar,
  SectionHeading,
  SegmentedControl,
  StackedBand,
  StatusPill,
  TABLE_HEAD,
  inr,
  num,
  toneForPct,
  toneText,
  type Tone,
} from "@/components/dashboard/redesign/primitives";
import {
  GroupedBarChart,
  RevenuePaceChart,
  type PacePoint,
} from "@/components/dashboard/redesign/charts";

// "custom" is the from–to pair beside the presets: picking a date leaves no
// preset highlighted, because the dates say what the window is.
type Period = "mtd" | "last" | "qtd" | "fy" | "custom";
type Preset = Exclude<Period, "custom">;
type CustomRange = { from: string; to: string };

// No "Today" / "This week" presets here (CEO asked for them to go, 6 Oct
// 2026): a shorter window is the from–to pair beside the chips.
const PERIODS: ReadonlyArray<{ value: Preset; label: string }> = [
  { value: "mtd", label: "This month" },
  { value: "last", label: "Last month" },
  { value: "qtd", label: "Quarter" },
  { value: "fy", label: "Financial year" },
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ym = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

type Snapshot = {
  purchases: number;
  sales: number;
  otherExpenses: number;
  net: number;
};
type MonthSnapshot = Snapshot & { month: string; label: string };

/**
 * The selected period as (a) the CEO routes' window query, (b) inclusive
 * from/to days for the routes that take a plain range, and (c) the calendar
 * months it covers, for the per-month snapshot figures.
 */
function resolvePeriod(period: Period, now: Date, custom: CustomRange) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = ymd(now);
  const range = (from: string, to: string) =>
    new URLSearchParams({ period: "range", from, to }).toString();

  if (period === "custom") {
    // Both days are set (the page only switches to "custom" once they are);
    // a pair typed the wrong way round is read as the range it describes.
    let [from, to] = [custom.from, custom.to];
    if (from > to) [from, to] = [to, from];
    const first = new Date(`${from}T00:00:00`);
    const last = new Date(`${to}T00:00:00`);
    const days = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
    // Days of the range already behind us, for the pace projection: all of
    // them when the range is in the past, none when it has not started.
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const elapsedDays = Math.min(
      days,
      Math.max(0, Math.round((todayStart - first.getTime()) / 86_400_000) + 1),
    );
    // The snapshot figures exist per whole month only, so a range is covered
    // when it runs from a 1st to a month's last day; otherwise the card says
    // so rather than showing figures for days outside the range.
    const wholeMonths =
      first.getDate() === 1 &&
      last.getDate() === new Date(last.getFullYear(), last.getMonth() + 1, 0).getDate();
    const months: string[] = [];
    if (wholeMonths) {
      for (let d = new Date(first); d <= last; d.setMonth(d.getMonth() + 1)) months.push(ym(d));
    }
    return {
      from,
      to,
      ceoQs: range(from, to),
      months: wholeMonths ? months : null,
      slots: days,
      elapsed: elapsedDays,
    };
  }
  if (period === "last") {
    const first = new Date(y, m - 1, 1);
    const last = new Date(y, m, 0);
    return {
      from: ymd(first),
      to: ymd(last),
      ceoQs: range(ymd(first), ymd(last)),
      months: [ym(first)],
      slots: last.getDate(),
      elapsed: last.getDate(),
    };
  }
  if (period === "qtd") {
    const first = new Date(y, m - (m % 3), 1);
    const months = Array.from({ length: (m % 3) + 1 }, (_, i) =>
      ym(new Date(y, first.getMonth() + i, 1)),
    );
    return {
      from: ymd(first),
      to: today,
      ceoQs: range(ymd(first), today),
      months,
      slots: 0,
      elapsed: 0,
    };
  }
  if (period === "fy") {
    const first = new Date(m >= 3 ? y : y - 1, 3, 1);
    return {
      from: ymd(first),
      to: today,
      ceoQs: "period=fy",
      months: null,
      slots: 0,
      elapsed: 0,
    };
  }
  // Sent as an explicit 1st → today range, not `period=mtd`: that keyword
  // resolves to the WHOLE calendar month, so "previous period of the same
  // length" became a full month and five days of October were compared with
  // the thirty-one days before them. With the range, 1–5 Oct compares with
  // the five days before the 1st.
  return {
    from: `${ym(now)}-01`,
    to: today,
    ceoQs: range(`${ym(now)}-01`, today),
    months: [ym(now)],
    slots: new Date(y, m + 1, 0).getDate(),
    elapsed: now.getDate(),
  };
}

async function getData<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success === false) {
    throw new Error(json?.error?.message ?? "Could not load this section");
  }
  return json.data as T;
}

/** "▲ 9% vs previous period", coloured by whether up is good. */
function changeOf(c: Compare | undefined, upIsGood = true) {
  if (!c || c.prev == null || c.prev === 0) return null;
  const pct = Math.round(((c.now - c.prev) / c.prev) * 100);
  if (pct === 0) return { text: "Same as previous period", good: true };
  const up = pct > 0;
  return {
    text: `${up ? "▲" : "▼"} ${Math.abs(pct)}% vs previous period`,
    good: up === upIsGood,
  };
}

const BUCKET_COLOR: Record<AccountBucket, string> = {
  active: "#1e7e34",
  cooling: "#e0a100",
  orange: "#ec835a",
  red: "#c0392b",
  dormant: "#5a6877",
  not_ordered_yet: "#86b6ef",
  never_ordered: "#b8c2cc",
};

/** "Orange — pitch now (31–45 d)" → ["Orange — pitch now", "31–45 d"]. */
function bucketParts(k: AccountBucket): [string, string] {
  const full = ACCOUNT_BUCKET_LABELS[k];
  const i = full.indexOf(" (");
  return i < 0 ? [full, ""] : [full.slice(0, i), full.slice(i + 2, -1)];
}

export default function CEODashboard() {
  const [period, setPeriod] = React.useState<Period>("mtd");
  const [custom, setCustom] = React.useState<CustomRange>({ from: "", to: "" });
  const [mix, setMix] = React.useState<"type" | "city">("type");

  // One clock for the page. Re-read on a period change so a tab left open
  // overnight does not keep yesterday's "today".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = React.useMemo(() => new Date(), [period, custom]);
  const win = React.useMemo(
    () => resolvePeriod(period, now, custom),
    [period, now, custom],
  );
  const todayStr = ymd(now);
  // A typed day becomes the window as soon as the pair is complete; until
  // then the preset stays in charge and the half-typed pair just waits.
  const pickCustom = (patch: Partial<CustomRange>) => {
    const next = { ...custom, ...patch };
    setCustom(next);
    if (next.from && next.to) setPeriod("custom");
  };
  const rangeQs = `from=${win.from}&to=${win.to}`;

  const tower = useQuery<ControlTower & { label: string }>({
    queryKey: ["ceo-control-tower", win.ceoQs],
    queryFn: () => getData(`/api/dashboard/ceo/control-tower?${win.ceoQs}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  const overview = useQuery<CeoOverviewData>({
    queryKey: ["ceo-overview", win.ceoQs],
    queryFn: () => getData(`/api/dashboard/ceo/overview?${win.ceoQs}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = useQuery<any>({
    queryKey: ["dashboard-metrics", "ceo"],
    queryFn: () => getData(`/api/dashboard/ceo`),
    refetchInterval: 60_000,
  });
  const health = useQuery<{ checks: DataHealthCheck[] }>({
    queryKey: ["ceo-data-health"],
    queryFn: () => getData("/api/dashboard/ceo/data-health"),
    staleTime: 5 * 60 * 1000,
  });
  const margin = useQuery<{ report: GrossMarginReport }>({
    queryKey: ["ceo-gross-margin-window", rangeQs],
    queryFn: () => getData(`/api/dashboard/ceo/gross-margin?${rangeQs}`),
    staleTime: 5 * 60 * 1000,
  });
  const sales = useQuery<SalesDashboard>({
    queryKey: ["ceo-sales-outcome", rangeQs],
    queryFn: () => getData(`/api/admin/reports/sales-dashboard?${rangeQs}`),
    staleTime: 5 * 60 * 1000,
  });
  const funnel = useQuery<FunnelCountsResult>({
    queryKey: ["ceo-finance-funnel", rangeQs],
    queryFn: () => getData(`/api/admin/reports/funnel-counts?${rangeQs}`),
    staleTime: 5 * 60 * 1000,
  });
  const stages = useQuery<ReportResult>({
    queryKey: ["ceo-lead-funnel", rangeQs],
    queryFn: () =>
      getData(
        `/api/admin/reports/lead_funnel?date_from=${win.from}&date_to=${win.to}`,
      ),
    staleTime: 5 * 60 * 1000,
  });
  const dealers = useQuery<{ rows: DealerHealthRow[] }>({
    queryKey: ["ceo-dealer-health"],
    queryFn: () => getData("/api/admin/dealer-health"),
    staleTime: 5 * 60 * 1000,
  });

  // Revenue against costs, last six calendar months (the current one to date).
  const sixMonths = React.useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) =>
        ym(new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)),
      ),
    [now],
  );
  const history = useQuery<MonthSnapshot[]>({
    queryKey: ["ceo-snapshot-history", sixMonths.join(",")],
    queryFn: () =>
      Promise.all(
        sixMonths.map(async (month) => ({
          month,
          ...(await getData<Snapshot & { label: string }>(
            `/api/dashboard/ceo/snapshot-summary?month=${month}`,
          )),
        })),
      ),
    staleTime: 5 * 60 * 1000,
  });
  const fySnapshot = useQuery<Snapshot>({
    queryKey: ["ceo-snapshot-fy"],
    queryFn: () => getData("/api/dashboard/ceo/snapshot-summary?period=fy"),
    enabled: period === "fy",
    staleTime: 5 * 60 * 1000,
  });

  if (tower.isLoading && !tower.data) return <DashboardSkeleton />;

  if (tower.error || !tower.data) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger-bg">
          <AlertCircle className="h-6 w-6 text-danger" />
        </div>
        <h3 className="text-base font-bold text-brand-navy">
          Couldn&apos;t load the dashboard
        </h3>
        <p className="mt-1.5 text-sm text-ink-muted">
          {(tower.error as Error | null)?.message ??
            "We hit a problem fetching your metrics."}
        </p>
        <button
          onClick={() => tower.refetch()}
          className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-[10px] bg-brand-navy px-4 text-sm font-semibold text-white hover:bg-brand-800"
        >
          <RefreshCw
            className={`h-4 w-4 ${tower.isFetching ? "animate-spin" : ""}`}
          />
          Retry
        </button>
      </div>
    );
  }

  const { exceptions: x, money, engine, base: baseBlock, people } = tower.data;
  const ov = overview.data;
  const m = base.data ?? {};
  const periodLabel =
    period === "custom"
      ? `${win.from} to ${win.to}`
      : PERIODS.find((p) => p.value === period)!.label;
  // A period change keeps the previous figures on screen until the new ones
  // land; say so, and dim them, rather than show last period's numbers under
  // this period's name.
  const switching = tower.isPlaceholderData || overview.isPlaceholderData;

  // ── Trust ────────────────────────────────────────────────────────────────
  // Each check is the share of records that is INCOMPLETE (its label says
  // what is missing), so 0 % is the good end: up to 5 % passes, up to 20 % is
  // "fix soon", beyond that "fix now".
  const checks = (health.data?.checks ?? []).map((c) => {
    const tone: Tone =
      c.pct == null ? "neutral" : c.pct <= 5 ? "good" : c.pct <= 20 ? "warn" : "bad";
    const state =
      c.pct == null
        ? "Not checked"
        : c.pct <= 5
          ? "Good"
          : c.pct <= 20
            ? "Fix soon"
            : "Fix now";
    return { ...c, tone, state };
  });

  // ── Needs you today ──────────────────────────────────────────────────────
  type Need = React.ComponentProps<typeof ActionCard> & { key: string; n: number };
  const needs: Need[] = x
    ? [
        {
          key: "quotes",
          n: x.quotes_pending,
          icon: FileText,
          tone: "bad",
          label: "Quotes waiting for your approval",
          count: num(x.quotes_pending),
          sub: "A rep cannot send a quote until you act on it",
          href: "/ceo/quotations",
          cta: x.quotes_pending === 1 ? "Review quote" : "Review quotes",
          primary: true,
        },
        {
          key: "unowned",
          n: x.awaiting_assignment_total,
          icon: UserPlus,
          tone: "warn",
          label: "Sales-ready leads with no owner",
          count: num(x.awaiting_assignment_total),
          sub: `${num(x.unassigned_over_7d)} waiting more than 7 days`,
          href: "/admin/ready-to-assign",
          cta: "Open list",
        },
        {
          // ID 75.4 — replaces "Leads idle over 7 working days" here; idle
          // leads are still on Needs Attention and the Sales Head dashboard.
          key: "said_yes",
          n: x.said_yes_not_won,
          icon: CircleCheck,
          tone: "warn",
          label: "Dealer said yes, not marked Won",
          count: num(x.said_yes_not_won),
          sub:
            `${inr(x.said_yes_value)} in approved quotes` +
            (x.said_yes_oldest_days == null
              ? ""
              : ` · oldest ${x.said_yes_oldest_days} working day${x.said_yes_oldest_days === 1 ? "" : "s"}` +
                ` (limit ${x.said_yes_limit_days})`),
          href: "/ceo/said-yes",
          cta: "Open list",
        },
        {
          key: "red",
          n: x.red_dormant_dealers,
          icon: TrendingDown,
          tone: "bad",
          label: "Dealers in Red or Dormant",
          count: num(x.red_dormant_dealers),
          sub: `${inr(x.at_risk_90d)} billed to them in the last 90 days`,
          href: "/admin/reports/dealer-health",
          cta: "Open list",
        },
        {
          key: "below80",
          n: x.spocs_below_80 ?? 0,
          icon: Target,
          tone: "bad",
          label: "People below 80% of target",
          count: num(x.spocs_below_80 ?? 0),
          sub: "Against their target to date",
          href: "#team",
          cta: "See team",
        },
      ]
    : [];

  // ── Headline tiles ───────────────────────────────────────────────────────
  const months = margin.data?.report.available
    ? margin.data.report.months
    : null;
  const marginTotal = months
    ? months.reduce(
        (a, mo) => ({
          margin: a.margin + mo.total.margin,
          revenue: a.revenue + mo.total.revenue,
        }),
        { margin: 0, revenue: 0 },
      )
    : null;
  const marginPct =
    marginTotal && marginTotal.revenue > 0
      ? (marginTotal.margin / marginTotal.revenue) * 100
      : null;

  // Receivables are a balance, not a flow: everything still unpaid today,
  // whichever period the invoice is dated in.
  const owed: number | null =
    m.outstandingCredits == null ? null : Number(m.outstandingCredits);

  const dealerRows = dealers.data?.rows ?? null;
  const bucketCount = (k: AccountBucket) =>
    dealerRows
      ? dealerRows.filter((r) => r.bucket === k).length
      : (baseBlock?.dealers[k] ?? 0);
  const bucketRevenue = (k: AccountBucket) =>
    dealerRows
      ? dealerRows
          .filter((r) => r.bucket === k)
          .reduce((a, r) => a + Number(r.revenue_90d || 0), 0)
      : null;
  const haveDealers = Boolean(dealerRows || baseBlock);
  const liveDealers = ACCOUNT_BUCKETS.reduce((a, k) => a + bucketCount(k), 0);
  const ordering = bucketCount("active") + bucketCount("cooling");

  // ── Revenue pace ─────────────────────────────────────────────────────────
  const chart = ov?.chart ?? [];
  const byDay = win.slots > 0 && ov?.granularity === "day";
  const pacePoints: PacePoint[] = chart.map((c, i) => ({
    x: byDay ? Number.parseInt(c.name, 10) || i + 1 : i + 1,
    label: c.name,
    value: c.revenue,
  }));
  const paceSlots = byDay ? win.slots : Math.max(pacePoints.length, 1);
  const paceElapsed = byDay ? win.elapsed : paceSlots;
  const revenueSoFar = pacePoints.reduce((a, p) => a + p.value, 0);
  const paceOpen =
    byDay && revenueSoFar > 0 && paceElapsed > 0 && paceElapsed < paceSlots;
  const paceEnd = paceOpen ? (revenueSoFar / paceElapsed) * paceSlots : null;

  // ── Revenue split ────────────────────────────────────────────────────────
  const mixRows = money
    ? [
        // Business type already covers every invoice ("Not classified yet" is
        // its grey row); only the city split leaves unlinked revenue over.
        ...(mix === "type"
          ? money.by_type.map((t) => ({ label: t.type, value: t.revenue, muted: !!t.unclassified }))
          : money.by_city.map((c) => ({ label: c.city, value: c.revenue, muted: false }))),
        ...(mix === "city" && money.unlinked_revenue > 0
          ? [
              {
                label: "Not linked to a dealer",
                value: money.unlinked_revenue,
                muted: true,
              },
            ]
          : []),
      ]
    : [];
  const mixMax = Math.max(1, ...mixRows.map((r) => r.value));

  // ── Money in, money out ──────────────────────────────────────────────────
  const hist = history.data ?? null;
  const spent: Snapshot | null =
    period === "fy"
      ? (fySnapshot.data ?? null)
      : hist && win.months
        ? hist
            .filter((h) => win.months!.includes(h.month))
            .reduce<Snapshot>(
              (a, h) => ({
                purchases: a.purchases + h.purchases,
                sales: a.sales + h.sales,
                otherExpenses: a.otherExpenses + h.otherExpenses,
                net: a.net + h.net,
              }),
              { purchases: 0, sales: 0, otherExpenses: 0, net: 0 },
            )
        : null;
  const departments: Array<{ department: string; total: number | string }> =
    period === "mtd" ? (m.expenses_by_department ?? []) : [];

  // ── Sales engine ─────────────────────────────────────────────────────────
  // The Lead Funnel report's stages when it loads (share of the period's leads
  // that ever reached each stage); the control tower's three steps otherwise.
  type FunnelRow = { label: string; count: number; pct: number | null; note: string };
  const stageRows: FunnelRow[] = (stages.data?.rows ?? []).map((r, i) => {
    const ever = r.ever_reached == null ? null : Number(r.ever_reached);
    const pct = r.pct_reached == null ? null : Number(r.pct_reached);
    return {
      label: String(r.stage).replace(/_/g, " "),
      count: ever ?? Number(r.count ?? 0),
      pct: i === 0 ? null : pct,
      note:
        i === 0
          ? "Created in the period"
          : pct == null
            ? "there now"
            : `${pct}% of leads in`,
    };
  });
  const rateOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
  const engineRows: FunnelRow[] = engine
    ? [
        { label: "Leads in", count: engine.leads_in.now, pct: null, note: "Created in the period" },
        {
          label: "Converted",
          count: engine.converted.now,
          pct: rateOf(engine.converted.now, engine.leads_in.now),
          note: `${rateOf(engine.converted.now, engine.leads_in.now) ?? "—"}% of leads in`,
        },
        {
          label: "First order",
          count: engine.first_orders.now,
          pct: rateOf(engine.first_orders.now, engine.converted.now),
          note: `${rateOf(engine.first_orders.now, engine.converted.now) ?? "—"}% of converted`,
        },
      ]
    : [];
  const funnelRows = stageRows.length > 0 ? stageRows : engineRows;

  // ── Team ─────────────────────────────────────────────────────────────────
  const team = people
    ? [...people.rows].sort(
        (a, b) =>
          (a.pct_of_target ?? Number.POSITIVE_INFINITY) -
          (b.pct_of_target ?? Number.POSITIVE_INFINITY),
      )
    : [];

  const asOf = m.lastUpdated
    ? new Date(m.lastUpdated).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="flex flex-col gap-7 pb-12" data-testid="ceo-overview">
      <DashPageHeader
        eyebrow="CEO overview"
        title="How the business is doing"
        subtitle={
          <>
            {asOf ? `As of ${asOf} · ` : ""}
            {switching
              ? `Loading ${periodLabel.toLowerCase()}…`
              : `${tower.data.label} · each figure compares with the previous period of the same length`}
          </>
        }
      >
        {/* One row beside the title on wide screens; stacked and right-aligned
            when the two controls no longer fit next to it. */}
        <div className="flex flex-wrap items-center gap-3 lg:flex-col lg:flex-nowrap lg:items-end 2xl:flex-row 2xl:items-center">
          <SegmentedControl
            label="Period"
            options={PERIODS}
            value={period}
            onChange={(p) => {
              setPeriod(p);
              setCustom({ from: "", to: "" });
            }}
          />
          <div
            role="group"
            aria-label="Custom date range"
            className={`inline-flex min-h-[46px] items-center gap-1.5 rounded-xl border px-3 text-[13px] font-semibold ${
              period === "custom"
                ? "border-brand-navy/30 bg-surface text-brand-navy shadow-sm"
                : "border-transparent bg-[#e7edf3] text-ink-muted"
            }`}
          >
            <CalendarRange className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
            <input
              type="date"
              value={custom.from}
              max={custom.to || todayStr}
              onChange={(e) => pickCustom({ from: e.target.value })}
              aria-label="From date"
              className="w-[118px] bg-transparent outline-none"
            />
            <span className="opacity-50">to</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from || undefined}
              max={todayStr}
              onChange={(e) => pickCustom({ to: e.target.value })}
              aria-label="To date"
              className="w-[118px] bg-transparent outline-none"
            />
          </div>
        </div>
      </DashPageHeader>

      <div
        className={`flex flex-col gap-7 transition-opacity ${switching ? "opacity-50" : ""}`}
        aria-busy={switching}
      >
      {/* Needs you today */}
      <div className="flex flex-col gap-3">
        <SectionHeading
          title="Needs you today"
          note="Only what needs a decision or has money at stake. A green card is all clear."
        />
        {!x ? (
          <NotAvailable reason="The exceptions could not be computed on this environment." />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {needs.map(({ key, n, tone, primary, ...card }) => (
              <ActionCard
                key={key}
                {...card}
                tone={n > 0 ? tone : "ok"}
                primary={n > 0 && primary}
              />
            ))}
          </div>
        )}
        {x && x.spocs_below_80 == null && (
          <p className="text-xs text-ink-muted">
            Targets are not set up, so &ldquo;people below 80% of target&rdquo;
            cannot be counted.{" "}
            <Link href="/admin/targets" className="font-semibold text-brand-sky hover:underline">
              Set targets
            </Link>
          </p>
        )}
        <p className="text-xs text-ink-muted">
          Not tracked yet: orders claimed without an invoice.
        </p>
      </div>

      {/* Headline tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="Revenue"
          value={money ? inr(money.revenue.now) : "—"}
          href={`/ceo/revenue?from=${win.from}&to=${win.to}&label=${encodeURIComponent(periodLabel)}`}
          spark={chart.map((c) => c.revenue)}
          sub={
            money && money.unlinked_revenue > 0
              ? `${inr(money.unlinked_revenue)} not linked to a dealer`
              : "Non-void invoices dated in the period"
          }
        />
        <KpiTile
          label="Gross margin"
          value={
            marginTotal && marginTotal.revenue > 0
              ? inr(marginTotal.margin)
              : "—"
          }
          pill={
            marginPct != null
              ? { text: `${marginPct.toFixed(1)}% of sales`, tone: "neutral" }
              : undefined
          }
          sub={
            margin.isLoading
              ? "Loading…"
              : marginTotal && marginTotal.revenue > 0
                ? "Invoice lines at OEM cost, before GST · whole months"
                : marginTotal
                  ? "No costed invoice lines in this period yet"
                  : "Not available yet — invoice lines are not costed on this database"
          }
        />
        <KpiTile
          label="Batteries to dealers"
          href={`/ceo/batteries?from=${win.from}&to=${win.to}&label=${encodeURIComponent(periodLabel)}`}
          value={sales.data ? num(sales.data.outcome.batteries_to_dealers) : "—"}
          pill={{ text: "No target", tone: "neutral" }}
          sub={
            sales.isLoading
              ? "Loading…"
              : sales.data
                ? "Allocated to dealer accounts in the period"
                : "Not available yet"
          }
        />
        <KpiTile
          label="New dealers live"
          href={`/ceo/new-dealers?from=${win.from}&to=${win.to}&label=${encodeURIComponent(periodLabel)}`}
          value={funnel.data ? num(funnel.data.totals.dealers_onboarded) : "—"}
          pill={{ text: "No target", tone: "neutral" }}
          sub={
            engine
              ? `${num(engine.converted.now)} leads marked Converted`
              : "Onboarding approved in the period"
          }
        />
        <KpiTile
          label="Dealers ordering"
          href="/admin/reports/dealer-health?bucket=ordering"
          value={haveDealers ? num(ordering) : "—"}
          pill={
            haveDealers && liveDealers > 0
              ? {
                  text: `${Math.round((ordering / liveDealers) * 100)}% of live`,
                  tone: "neutral",
                }
              : undefined
          }
          sub="Ordered in the last 30 days · as of today"
        />
        <KpiTile
          label="Money owed to us"
          value={owed == null ? "—" : inr(owed)}
          href="/ceo/receivables"
          sub="Unpaid on all invoices, as of now · not limited to the period · open for ageing"
        />
      </div>

      {/* Revenue pace + mix */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <DashCard
          className="xl:col-span-2"
          title={`Revenue pace, ${periodLabel.toLowerCase()}`}
          caption={
            paceEnd != null ? (
              <>
                At this pace the month ends at{" "}
                <span className="font-bold">{inr(paceEnd)}</span>, about{" "}
                {inr(revenueSoFar / paceElapsed)} a day over {paceElapsed} days
                so far.
              </>
            ) : (
              <>
                <span className="font-bold">{inr(revenueSoFar)}</span> invoiced
                across the period.
              </>
            )
          }
          action={
            <div className="flex flex-col gap-1.5 text-xs text-ink-muted">
              <span className="flex items-center gap-2">
                <span className="h-[3px] w-[22px] rounded bg-brand-royal" />
                Actual, cumulative
              </span>
              {paceOpen && (
                <span className="flex items-center gap-2">
                  <span className="w-[22px] border-t-2 border-dashed border-brand-royal" />
                  At current pace
                </span>
              )}
            </div>
          }
        >
          {overview.isLoading && !ov ? (
            <LoadingBlock />
          ) : overview.error ? (
            <NotAvailable reason={(overview.error as Error).message} />
          ) : pacePoints.length === 0 ? (
            <NotAvailable empty reason="No invoices dated in this period." />
          ) : (
            <RevenuePaceChart
              points={pacePoints}
              slots={paceSlots}
              elapsed={paceElapsed}
            />
          )}
          <span className="text-xs text-ink-muted">
            No company revenue target is set, so there is no target-pace line.
            Pace is a straight line over calendar days.
          </span>
        </DashCard>

        <DashCard title="Where revenue came from">
          <SegmentedControl
            label="Split revenue by"
            size="sm"
            options={[
              { value: "type", label: "Business type" },
              { value: "city", label: "City" },
            ]}
            value={mix}
            onChange={setMix}
          />
          {!money ? (
            <NotAvailable reason="Revenue could not be split on this environment." />
          ) : mixRows.length === 0 ? (
            <NotAvailable empty reason="No invoice is linked to a dealer account yet." />
          ) : (
            <div className="flex flex-col gap-3.5">
              {mixRows.map((r) => (
                <div key={r.label} className="flex flex-col gap-1.5">
                  <div className="flex justify-between gap-2 text-[13.5px]">
                    <span className="font-semibold text-ink">{r.label}</span>
                    <span className="tabular-nums text-ink">
                      <span className="font-bold">{inr(r.value)}</span>{" "}
                      {money.revenue.now > 0 && (
                        <span className="text-ink-muted">
                          · {Math.round((r.value / money.revenue.now) * 100)}%
                        </span>
                      )}
                    </span>
                  </div>
                  <ProgressBar pct={Math.max(0, (r.value / mixMax) * 100)} muted={r.muted} />
                </div>
              ))}
            </div>
          )}
          <span className="mt-auto text-xs leading-relaxed text-ink-muted">
            {mix === "type"
              ? "Business type comes from each invoice line (HSN code). “Not classified yet”: invoices read before line items were captured."
              : "City is that of the lead or dealer account the invoice matches on GSTIN. Invoices that match neither are shown in grey."}
          </span>
        </DashCard>
      </div>

      {/* Revenue against costs */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <DashCard
          className="xl:col-span-2"
          title="Revenue against total costs, last 6 months"
          caption="Costs are stock bought from OEMs plus approved expenses. The current month is to date."
          action={
            <div className="flex flex-col gap-1.5 text-xs text-ink-muted">
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-[3px] bg-brand-royal" />
                Revenue
              </span>
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-[3px] bg-[#eb6834]" />
                Total costs
              </span>
            </div>
          }
        >
          {history.isLoading ? (
            <LoadingBlock />
          ) : !hist ? (
            <NotAvailable reason={(history.error as Error | null)?.message} />
          ) : (
            <GroupedBarChart
              rows={hist.map((h) => ({
                label: h.label,
                a: h.sales,
                b: h.purchases + h.otherExpenses,
              }))}
            />
          )}
        </DashCard>

        <DashCard title={`Where the money went, ${periodLabel.toLowerCase()}`}>
          {!spent ? (
            history.isLoading || fySnapshot.isLoading ? (
              <LoadingBlock />
            ) : (
              <NotAvailable
                reason={
                  period === "custom" && !win.months
                    ? "Costs are counted by whole month. Pick a range from the 1st to a month-end, or a preset."
                    : undefined
                }
              />
            )
          ) : (
            <>
              <div className="flex items-baseline justify-between border-b border-border pb-2.5">
                <span className="text-sm font-semibold">Revenue</span>
                <span className="text-lg font-bold text-brand-navy tabular-nums">
                  {inr(spent.sales)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex flex-col">
                  <span className="text-sm font-semibold text-ink">
                    Stock bought from OEMs
                  </span>
                  <span className="text-[11.5px] text-ink-muted">
                    By OEM invoice date
                  </span>
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  {inr(spent.purchases)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex flex-col">
                  <span className="text-sm font-semibold text-ink">
                    Running expenses
                  </span>
                  <span className="text-[11.5px] text-ink-muted">
                    Approved expenses
                  </span>
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  {inr(spent.otherExpenses)}
                </span>
              </div>
              {departments.map((d) => (
                <div
                  key={d.department}
                  className="flex items-baseline justify-between gap-2 pl-3.5 text-[13px]"
                >
                  <span className="capitalize text-ink">
                    {String(d.department).replace(/_/g, " ")}
                  </span>
                  <span className="tabular-nums">{inr(Number(d.total))}</span>
                </div>
              ))}
              <div className="flex items-baseline justify-between border-t border-border pt-2.5">
                <span className="text-sm font-semibold">Net of purchases</span>
                <span
                  className={`text-lg font-bold tabular-nums ${spent.net >= 0 ? "text-success" : "text-danger"}`}
                >
                  {spent.net >= 0 ? "+" : "−"}
                  {inr(Math.abs(spent.net))}
                </span>
              </div>
              <span className="text-xs leading-relaxed text-ink-muted">
                This counts stock bought, not stock sold, so a month of heavy
                stocking looks negative. Buyback payments are on the Battery
                buyback card below.
              </span>
            </>
          )}
          <div className="mt-auto flex flex-col">
            <CardLink href="/ceo/finance">Open Revenue &amp; costs</CardLink>
          </div>
        </DashCard>
      </div>

      {/* Engine + base */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <DashCard
          title="Sales engine"
          caption={
            engine
              ? `How far the period's ${num(engine.leads_in.now)} new leads have got. The bar is the share of them that reached each stage.`
              : undefined
          }
        >
          {!engine ? (
            <NotAvailable reason="The lead funnel could not be computed on this environment." />
          ) : (
            <>
              <div className="flex flex-col">
                {funnelRows.map((f) => (
                  <div
                    key={f.label}
                    className="grid min-h-[42px] grid-cols-[minmax(0,150px)_64px_minmax(0,1fr)_120px] items-center gap-3 border-t border-[#f1f4f7]"
                  >
                    <span className="truncate text-[13.5px] font-semibold text-ink">{f.label}</span>
                    <span className="text-right text-[15px] font-bold text-brand-navy tabular-nums">
                      {num(f.count)}
                    </span>
                    {f.pct == null ? <span /> : <ProgressBar pct={f.pct} height={12} />}
                    <span className="text-[12.5px] text-ink-muted tabular-nums">{f.note}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1 text-xs leading-relaxed text-ink-muted">
                <span>
                  {engine.headline.label}:{" "}
                  <span className="font-semibold text-ink">
                    {engine.headline.value == null
                      ? "—"
                      : `${(engine.headline.value * 100).toFixed(1)}%`}
                  </span>
                  . Recent leads are still moving, so the later steps will rise.
                </span>
                <span>
                  AI dialler: {num(engine.ai.leads_called)} dealers called ·{" "}
                  {engine.ai.connect_pct == null ? "—" : `${engine.ai.connect_pct}%`}{" "}
                  connected · {num(engine.ai.ai_qualified)} qualified.
                </span>
                <span>
                  First orders in the period: {num(engine.first_orders.now)}.
                </span>
              </div>
            </>
          )}
        </DashCard>

        <DashCard
          title={haveDealers ? `Dealer base: ${num(liveDealers)} live dealers` : "Dealer base"}
          caption="By days since their last invoice, as of today."
          action={<CardLink href="/admin/accounts">Account management</CardLink>}
        >
          {!haveDealers ? (
            dealers.isLoading ? <LoadingBlock /> : <NotAvailable />
          ) : (
            <>
              <StackedBand
                parts={ACCOUNT_BUCKETS.map((k) => ({
                  key: k,
                  n: bucketCount(k),
                  color: BUCKET_COLOR[k],
                }))}
              />
              <div className="flex flex-col">
                {ACCOUNT_BUCKETS.map((k) => {
                  const [label, rule] = bucketParts(k);
                  const rev = bucketRevenue(k);
                  return (
                    <div
                      key={k}
                      className="grid min-h-9 grid-cols-[14px_minmax(0,1fr)_56px_96px] items-center gap-2.5 border-t border-[#f1f4f7]"
                    >
                      <span className="h-3 w-3 rounded-[3px]" style={{ background: BUCKET_COLOR[k] }} />
                      <span className="text-[13.5px] text-ink">
                        <span className="font-semibold">{label}</span>{" "}
                        {rule && <span className="text-ink-muted">· {rule}</span>}
                      </span>
                      <span className="text-right text-sm font-bold text-brand-navy tabular-nums">
                        {num(bucketCount(k))}
                      </span>
                      <span className="text-right text-[12.5px] text-ink-muted tabular-nums">
                        {rev == null || rev === 0 ? "—" : inr(rev)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <span className="text-xs text-ink-muted">
                Right column: billed in the last 90 days.{" "}
                <Link href="/admin/reports/dealer-health" className="font-semibold text-brand-sky hover:underline">
                  Open dealer health
                </Link>
              </span>
            </>
          )}
        </DashCard>
      </div>

      {/* Team + finance + buyback */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <DashCard
          id="team"
          className="xl:col-span-2"
          title={`Team against target, ${periodLabel.toLowerCase()}`}
          caption={
            people?.basis === "target"
              ? "Furthest behind first. Each person is measured against their target to date."
              : "No targets are set for this period, so people are listed by what they converted."
          }
          action={<CardLink href="/sales-head">Sales Head view</CardLink>}
        >
          {!people ? (
            <NotAvailable reason="The team figures could not be computed on this environment." />
          ) : team.length === 0 ? (
            <NotAvailable empty reason="No sales activity in this period." />
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[640px]">
                <div
                  className={`grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_100px_84px_84px_84px] gap-3 border-b border-border pb-2 ${TABLE_HEAD}`}
                >
                  <span>Person</span>
                  <span>% of target to date</span>
                  <span className="text-right">Revenue</span>
                  <span className="text-right">Converted</span>
                  <span className="text-right">Idle leads</span>
                  <span className="text-right">Engaged</span>
                </div>
                {team.map((t) => {
                  const tone = toneForPct(t.pct_of_target);
                  return (
                    <div
                      key={t.spoc_id}
                      className="grid min-h-11 grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_100px_84px_84px_84px] items-center gap-3 border-b border-[#f1f4f7] text-[13.5px] tabular-nums"
                    >
                      <span className="truncate font-semibold text-ink">{t.name}</span>
                      {t.pct_of_target == null ? (
                        <span className="text-[13px] text-ink-muted">No target</span>
                      ) : (
                        <div className="flex items-center gap-2.5">
                          <ProgressBar
                            pct={Math.min((t.pct_of_target / 120) * 100, 100)}
                            tone={tone}
                            tick={83.3}
                          />
                          <span className={`w-12 text-right text-[13px] font-bold ${toneText(tone)}`}>
                            {t.pct_of_target}%
                          </span>
                        </div>
                      )}
                      <span className="text-right">{t.revenue ? inr(t.revenue) : "—"}</span>
                      <span className="text-right">{num(t.converted)}</span>
                      <span className={`text-right ${t.idle_leads >= 15 ? "font-semibold text-danger" : ""}`}>
                        {num(t.idle_leads)}
                      </span>
                      <span className="text-right">
                        {t.engaged_pct == null ? "—" : `${t.engaged_pct}%`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <span className="text-xs leading-relaxed text-ink-muted">
            The black tick is 100% of target. Engaged = share of calls where
            the rep spoke with the dealer.
            {money && money.unlinked_revenue > 0
              ? ` ${inr(money.unlinked_revenue)} of this period's revenue is credited to no one: its invoices are not linked to a dealer account.`
              : ""}
          </span>
        </DashCard>

        <div className="flex flex-col gap-5">
          <DashCard
            title="Customer finance (NBFC)"
            caption={<span className="text-[12.5px] text-ink-muted">Loans for dealers&apos; customers, in the period</span>}
          >
            {!funnel.data ? (
              funnel.isLoading ? <LoadingBlock /> : <NotAvailable />
            ) : (
              <div className="grid grid-cols-3 gap-2.5">
                <MiniStat value={num(funnel.data.totals.kyc_shared)} label="KYC files shared" />
                <MiniStat value={num(funnel.data.totals.files_disbursed)} label="Disbursed" />
                <MiniStat value={num(funnel.data.totals.files_rejected)} label="Rejected" />
              </div>
            )}
          </DashCard>
          <DashCard
            title="Battery buyback"
            caption={<span className="text-[12.5px] text-ink-muted">Scrap sourced from dealers, in the period</span>}
          >
            {!baseBlock ? (
              <NotAvailable />
            ) : (
              <div className="grid grid-cols-3 gap-2.5">
                <MiniStat
                  value={
                    baseBlock.buyback.kg.now >= 1000
                      ? `${(baseBlock.buyback.kg.now / 1000).toFixed(1)} t`
                      : `${num(baseBlock.buyback.kg.now)} kg`
                  }
                  label="Sourced"
                  delta={changeOf(baseBlock.buyback.kg)}
                />
                <MiniStat
                  value={ov?.buyback.available ? num(ov.buyback.completed) : "—"}
                  label="Deals closed"
                />
                <MiniStat
                  value={baseBlock.buyback.per_kg == null ? "—" : inr(baseBlock.buyback.per_kg)}
                  label="Paid per kg"
                  note={`${inr(baseBlock.buyback.paid)} in total`}
                />
              </div>
            )}
          </DashCard>
        </div>
      </div>

      </div>

      {/* E-306 — Green Energy Today: the morning brief and top headlines. Not
          period-driven: news is always "now". Full feed on /ceo/news. */}
      <GreenNewsCard />

      {/* Trust */}
      <DashCard
        id="trust"
        title="Can you trust these numbers?"
        action={
          <span className="text-[13px] text-ink-muted">
            Every number above is under-counted until these reach 0%. Each
            opens its fix list.
          </span>
        }
      >
        {health.isLoading ? (
          <LoadingBlock />
        ) : checks.length === 0 ? (
          <NotAvailable reason={(health.error as Error | null)?.message} />
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {checks.map((c) => (
              <Link
                key={c.key}
                href={c.fix_href}
                className="flex flex-col gap-1.5 rounded-xl border border-border bg-[#fbfcfd] p-3.5 text-ink transition-colors hover:border-brand-200"
              >
                <span className="min-h-[34px] text-[12.5px] leading-snug text-ink-muted">
                  {c.label}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-[22px] font-bold text-brand-navy tabular-nums">
                    {c.pct == null ? "—" : `${c.pct}%`}
                  </span>
                  <StatusPill tone={c.tone}>{c.state}</StatusPill>
                </span>
                <span className="text-xs text-ink-muted">
                  {c.bad == null
                    ? "Could not be checked"
                    : c.bad === 0
                      ? "Nothing missing"
                      : `${num(c.bad)} of ${num(c.total ?? 0)}`}
                </span>
              </Link>
            ))}
          </div>
        )}
      </DashCard>
    </div>
  );
}

function MiniStat({
  value,
  label,
  note,
  delta,
}: {
  value: string;
  label: string;
  note?: string;
  delta?: { text: string; good: boolean } | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xl font-bold text-brand-navy tabular-nums">{value}</span>
      <span className="text-xs text-ink-muted">{label}</span>
      {delta && (
        <span className={`text-[11.5px] font-semibold ${delta.good ? "text-success" : "text-danger"}`}>
          {delta.text}
        </span>
      )}
      {note && <span className="text-[11.5px] text-ink-muted">{note}</span>}
    </div>
  );
}
