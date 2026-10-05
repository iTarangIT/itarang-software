"use client";

// Sales Head operations — "Is the team doing the work, and what is stuck?"
// (CRM Reporting & Dashboards redesign). Rendered at /sales-head and at
// /admin/reports/sales-dashboard, so Sales Head, Admin, CEO, Business Head and
// Partner read one screen.
//
// Every card reads the module that owns its numbers: the sales dashboard
// builder (activity and outcome per person), the targets service, needs-
// attention (idle leads), dealer health (accounts by owner) and the admin
// reports (funnel by owner, lost analysis, ASM handoff). A card whose source
// the viewer's role cannot read, or that the CRM does not track yet, says so —
// it never shows a placeholder number.
//
// Filters live in the URL (same keys as the sales dashboard API), so a view
// survives a refresh and can be shared.

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Check, Download, Search } from "lucide-react";

import type { SalesDashboard, SalesSpocBlock } from "@/lib/admin/salesDashboardTypes";
import type { ReportResult, UserOption } from "@/lib/admin/types";
import type { TargetRow } from "@/lib/targets/service";
import type { TargetMetric } from "@/lib/targets/rules";
import type { NeedsAttentionHolderSummary } from "@/lib/leads/needsAttention";
import type { DealerHealthGroup, DealerHealthRow } from "@/lib/dealers/accountHealth";
import type { RegionsResponse } from "@/app/api/locations/regions/route";
import { OutsideTerritoryClaims } from "@/components/leads/OutsideTerritoryClaims";
import {
    ActionTile,
    CardLink,
    DashCard,
    DashPageHeader,
    HEAT_LEGEND,
    HeatCell,
    LoadingBlock,
    NotAvailable,
    ProgressBar,
    SectionHeading,
    SegmentedControl,
    TABLE_HEAD,
    inr,
    num,
    toneForPct,
    toneText,
} from "@/components/dashboard/redesign/primitives";
import { useSalesDashboardFilters } from "./useSalesDashboardFilters";

type Period = "today" | "week" | "month";
type TeamSeg = "all" | "field" | "inside";

const FIELD_ROLES = ["asm", "sales_manager"];
const INSIDE_ROLES = ["inside_sales_rep"];
const inSeg = (role: string | null | undefined, seg: TeamSeg) => {
    const r = (role ?? "").toLowerCase();
    if (seg === "field") return FIELD_ROLES.includes(r);
    if (seg === "inside") return INSIDE_ROLES.includes(r);
    return true;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function presets(now: Date): Record<Period, { from: string; to: string }> {
    const today = ymd(now);
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return {
        today: { from: today, to: today },
        week: { from: ymd(monday), to: today },
        month: { from: `${today.slice(0, 8)}01`, to: today },
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

const SELECT =
    "min-h-10 rounded-[10px] border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand-teal";

type ScoreCell = { actual: string; target: string | null; pct: number | null };

export function SalesHeadOpsView() {
    const router = useRouter();
    const pathname = usePathname();
    const { filters } = useSalesDashboardFilters(true);
    const [team, setTeam] = React.useState<TeamSeg>("all");
    const [score, setScore] = React.useState<"field" | "inside">("field");
    const [phone, setPhone] = React.useState("");
    const [pressed, setPressed] = React.useState<Period | null>(null);

    const now = React.useMemo(() => new Date(), []);
    const preset = React.useMemo(() => presets(now), [now]);
    // No dates in the URL means "this month", the screen's default.
    const from = filters.from || preset.month.from;
    const to = filters.to || preset.month.to;
    // On a Monday "today" and "this week" are the same days, so the URL cannot
    // tell them apart — the button last pressed wins while it still matches.
    const matches = (p: Period) => preset[p].from === from && preset[p].to === to;
    const period = pressed && matches(pressed) ? pressed : ((Object.keys(preset) as Period[]).find(matches) ?? null);
    const monthToDate = period === "month";

    /** Rewrite the URL filters; an empty value removes the key. */
    const update = (patch: Record<string, string>) => {
        const next: Record<string, string> = { from: filters.from, to: filters.to, state: filters.state, spoc_id: filters.spoc_id, ...patch };
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
        const s = p.toString();
        router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
    };

    const dashQs = new URLSearchParams({ from, to });
    if (filters.state) dashQs.set("state", filters.state);
    if (filters.spoc_id) dashQs.set("spoc_id", filters.spoc_id);
    const reportQs = new URLSearchParams({ date_from: from, date_to: to });
    if (filters.state) reportQs.set("state", filters.state);

    const dash = useQuery<SalesDashboard>({
        queryKey: ["sales-head-ops", "dashboard", dashQs.toString()],
        queryFn: () => getData(`/api/admin/reports/sales-dashboard?${dashQs}`),
        placeholderData: (prev) => prev,
    });
    const targets = useQuery<{ rows: TargetRow[]; context: { working_days_total: number; working_days_elapsed: number } }>({
        queryKey: ["sales-head-ops", "targets", to.slice(0, 7)],
        queryFn: () => getData(`/api/admin/targets?month=${to.slice(0, 7)}`),
        enabled: monthToDate,
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    const idle = useQuery<{ holders: NeedsAttentionHolderSummary[] }>({
        queryKey: ["sales-head-ops", "idle"],
        queryFn: () => getData("/api/admin/needs-attention"),
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    const health = useQuery<{ rows: DealerHealthRow[]; summary: DealerHealthGroup[] }>({
        queryKey: ["sales-head-ops", "dealer-health"],
        queryFn: () => getData("/api/admin/dealer-health?group=owner"),
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    const byOwner = useQuery<ReportResult>({
        queryKey: ["sales-head-ops", "funnel-by-owner", reportQs.toString()],
        queryFn: () => getData(`/api/admin/reports/funnel_by_owner?${reportQs}`),
        placeholderData: (prev) => prev,
        retry: false,
    });
    const lost = useQuery<ReportResult>({
        queryKey: ["sales-head-ops", "lost", reportQs.toString()],
        queryFn: () => getData(`/api/admin/reports/lost_analysis?${reportQs}`),
        placeholderData: (prev) => prev,
        retry: false,
    });
    const handoff = useQuery<ReportResult>({
        queryKey: ["sales-head-ops", "handoff", reportQs.toString()],
        queryFn: () => getData(`/api/admin/reports/asm_handoff?${reportQs}`),
        placeholderData: (prev) => prev,
        retry: false,
    });
    const regions = useQuery<RegionsResponse>({
        queryKey: ["sales-head-ops", "regions"],
        queryFn: () => getData("/api/locations/regions"),
        staleTime: 60 * 60 * 1000,
    });
    const reps = useQuery<{ users: UserOption[] }>({
        queryKey: ["sales-head-ops", "reps"],
        queryFn: () => getData("/api/admin/users?roles=asm,inside_sales_rep,sales_manager,sales_head,partner"),
        staleTime: 5 * 60 * 1000,
        retry: false,
    });

    const d = dash.data;
    const repOptions = reps.data?.users ?? [];

    // One block per person. With a person picked the API returns no split, so
    // the whole-screen sections ARE that person's.
    const picked = repOptions.find((r) => r.user_id === filters.spoc_id);
    const people: SalesSpocBlock[] = d
        ? (d.per_spoc ??
          (filters.spoc_id
              ? [{ ...d, spoc_id: filters.spoc_id, name: picked?.name ?? picked?.email ?? "Selected person", role: picked?.role ?? null }]
              : []))
        : [];
    const shown = people.filter((p) => inSeg(p.role, team));
    const fieldPeople = people.filter((p) => inSeg(p.role, "field"));
    const insidePeople = people.filter((p) => inSeg(p.role, "inside"));

    // ── Targets (month to date only — a target is a monthly figure) ──────────
    const targetOf = (userId: string, metric: TargetMetric) =>
        monthToDate ? (targets.data?.rows.find((t) => t.user_id === userId && t.metric === metric) ?? null) : null;
    const daysLeft = targets.data
        ? Math.max(targets.data.context.working_days_total - targets.data.context.working_days_elapsed, 0)
        : null;
    const cell = (userId: string, metric: TargetMetric | null, fallback: number, money = false): ScoreCell => {
        const fmt = (v: number) => (money ? inr(v) : num(v));
        const t = metric ? targetOf(userId, metric) : null;
        if (!t) return { actual: fmt(fallback), target: null, pct: null };
        return {
            actual: t.progress.actual == null ? fmt(fallback) : fmt(t.progress.actual),
            target: fmt(t.progress.mtd_target),
            pct: t.progress.pct_of_mtd == null ? null : Math.round(t.progress.pct_of_mtd),
        };
    };

    // ── Needs action now ─────────────────────────────────────────────────────
    const holders = (idle.data?.holders ?? []).filter((h) => inSeg(h.holder_role, team) && (!filters.spoc_id || h.holder_id === filters.spoc_id));
    const idleTotal = holders.reduce((a, h) => a + h.idle, 0);
    const idleOver14 = holders.reduce((a, h) => a + h.idle_over_14, 0);
    const deadNumbers = holders.reduce((a, h) => a + h.non_responsive, 0);
    const groups = health.data?.summary ?? [];
    const redDormant = groups.reduce((a, g) => a + (g.by_bucket.red ?? 0) + (g.by_bucket.dormant ?? 0), 0);
    const atRisk = groups.reduce((a, g) => a + g.at_risk_90d, 0);
    const unowned = (health.data?.rows ?? []).filter((r) => !r.owner_id).length;
    const hot = d?.interest.rows.find((r) => r.interest_level === "hot");
    const hotAged = hot ? hot.age_8_14 + hot.age_15_30 + hot.age_30_plus : 0;

    type Tile = React.ComponentProps<typeof ActionTile> & { key: string; n: number; ready: boolean };
    const tiles: Tile[] = [
        {
            key: "hot",
            ready: Boolean(d),
            n: hotAged,
            severity: "now",
            count: num(hotAged),
            label: "Hot leads open more than 7 days",
            sub: hot ? `${num(hot.total)} Hot leads open in all · ${num(hot.age_30_plus)} older than 30 days` : undefined,
            href: "/leads",
        },
        {
            key: "red",
            ready: Boolean(health.data),
            n: redDormant,
            severity: "now",
            count: num(redDormant),
            label: "Dealers in Red or Dormant",
            sub: `${inr(atRisk)} billed to them in the last 90 days`,
            href: "/admin/reports/dealer-health",
        },
        {
            key: "idle",
            ready: Boolean(idle.data),
            n: idleTotal,
            severity: "soon",
            count: num(idleTotal),
            label: "Idle leads",
            sub: `No work logged: ISR over 5, ASM over 7 working days · ${num(idleOver14)} over 14`,
            href: "/admin/reports/needs-attention",
        },
        {
            key: "dead",
            ready: Boolean(idle.data),
            n: deadNumbers,
            severity: "info",
            count: num(deadNumbers),
            label: "Dead or non-responsive numbers",
            sub: "Owner kept · repair puts the lead back in play",
            href: "/admin/number-repair",
        },
        {
            key: "unowned",
            ready: Boolean(health.data),
            n: unowned,
            severity: "info",
            count: num(unowned),
            label: "Accounts with no owner",
            sub: "Live dealers nobody manages",
            href: "/admin/account-management",
        },
    ];
    const openTiles = tiles.filter((t) => t.ready && t.n > 0);
    const clearTiles = tiles.filter((t) => t.ready && t.n === 0);

    // ── Where open leads are sitting ─────────────────────────────────────────
    const HEAT_COLS = ["owned_open", "not_worked", "touched", "connected", "hot", "warm", "cold", "converted"] as const;
    const idKey = byOwner.data?.drill?.idKey;
    const ownerRows = (byOwner.data?.rows ?? []).filter(
        (r) => inSeg(r.role == null ? null : String(r.role), team) && (!filters.spoc_id || !idKey || String(r[idKey]) === filters.spoc_id),
    );
    const heatLabel = (k: string) => byOwner.data?.columns.find((c) => c.key === k)?.label ?? k;
    const heatMax = Object.fromEntries(HEAT_COLS.map((k) => [k, Math.max(0, ...ownerRows.map((r) => Number(r[k] ?? 0)))]));
    const worst = [...ownerRows].sort((a, b) => Number(b.not_worked ?? 0) - Number(a.not_worked ?? 0))[0];

    // ── Why we lost ──────────────────────────────────────────────────────────
    const lostRows = (lost.data?.rows ?? []).map((r) => ({ category: String(r.category), reason: String(r.reason), n: Number(r.count ?? 0) }));
    const salesLost = lostRows.filter((r) => r.category === "Sales lost" && r.n > 0).sort((a, b) => b.n - a.n);
    const lostTotal = salesLost.reduce((a, r) => a + r.n, 0);
    const dropouts = lostRows.filter((r) => r.category !== "Sales lost").reduce((a, r) => a + r.n, 0);

    const csvHref = `/api/admin/reports/sales-dashboard?${dashQs}&format=csv`;

    return (
        <div className="flex flex-col gap-7 pb-12" data-testid="sales-head-ops">
            <div className="flex flex-col gap-4">
                <DashPageHeader
                    eyebrow="Sales Head · operations"
                    title="Is the team doing the work, and what is stuck?"
                    subtitle={
                        <>
                            {d ? `As of ${d.as_of_date} (IST) · ` : ""}
                            {from === to ? from : `${from} → ${to}`}
                            {dash.isPlaceholderData
                                ? " · loading…"
                                : d
                                  ? ` · ${d.averages.days_in_range} ${d.averages.days_in_range === 1 ? "day" : "days"}`
                                  : ""}
                        </>
                    }
                >
                    <SegmentedControl
                        label="Period"
                        options={[
                            { value: "today", label: "Today" },
                            { value: "week", label: "This week" },
                            { value: "month", label: "This month" },
                        ]}
                        value={(period ?? "") as Period}
                        onChange={(p) => {
                            setPressed(p);
                            update(p === "month" ? { from: "", to: "" } : preset[p]);
                        }}
                    />
                </DashPageHeader>

                <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-border bg-surface px-3.5 py-3">
                    <SegmentedControl
                        label="Team"
                        size="sm"
                        options={[
                            { value: "all", label: "Everyone" },
                            { value: "field", label: "Field (ASM)" },
                            { value: "inside", label: "Inside sales (ISR)" },
                        ]}
                        value={team}
                        onChange={setTeam}
                    />
                    <label className="flex items-center gap-2 text-[13px] text-ink-muted">
                        State
                        <select value={filters.state} onChange={(e) => update({ state: e.target.value })} className={SELECT}>
                            <option value="">All states</option>
                            {(regions.data?.states ?? []).map((s) => (
                                <option key={s.code} value={s.name}>
                                    {s.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex items-center gap-2 text-[13px] text-ink-muted">
                        Person
                        <select value={filters.spoc_id} onChange={(e) => update({ spoc_id: e.target.value })} className={`${SELECT} max-w-[200px]`}>
                            <option value="">Everyone</option>
                            {repOptions.map((r) => (
                                <option key={r.user_id} value={r.user_id}>
                                    {r.name ?? r.email}
                                </option>
                            ))}
                        </select>
                    </label>
                    <form
                        className="ml-auto flex min-h-10 w-full items-center gap-2 rounded-[10px] border border-border bg-[#fbfcfd] px-3 sm:w-[300px]"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (phone.trim()) router.push(`/leads?search=${encodeURIComponent(phone.trim())}`);
                        }}
                    >
                        <Search className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
                        <input
                            type="search"
                            inputMode="tel"
                            aria-label="Find a dealer by phone number"
                            placeholder="Find a dealer by phone number"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            className="min-w-0 grow border-0 bg-transparent text-[13px] text-ink outline-none"
                        />
                    </form>
                    <a
                        href={csvHref}
                        download
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-[10px] border border-border px-3 text-[13px] font-semibold text-brand-navy hover:bg-bg"
                    >
                        <Download className="h-3.5 w-3.5" aria-hidden /> CSV
                    </a>
                </div>
            </div>

            {dash.error && (
                <div className="rounded-xl border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
                    {(dash.error as Error).message}
                </div>
            )}

            {/* Needs action now */}
            <div className="flex flex-col gap-3">
                <SectionHeading title="Needs action now" note="Each opens its list with the actions on the row: assign, reassign, call, open lead." />
                {openTiles.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
                        {tiles.map(({ key, n, ready, ...t }) => (ready && n > 0 ? <ActionTile key={key} {...t} /> : null))}
                    </div>
                ) : dash.isLoading || idle.isLoading || health.isLoading ? (
                    <LoadingBlock />
                ) : (
                    <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface px-5 py-4 text-sm font-semibold text-success shadow-card">
                        <Check className="h-4 w-4" aria-hidden /> Nothing is past its limit right now.
                    </div>
                )}
                {clearTiles.length > 0 && openTiles.length > 0 && (
                    <div className="flex items-start gap-2 text-[13px] text-ink-muted">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                        <span>
                            <span className="font-semibold text-success">All clear:</span> {clearTiles.map((t) => t.label.toLowerCase()).join(" · ")}
                        </span>
                    </div>
                )}
                <p className="text-xs text-ink-muted">
                    Sales-ready leads with no owner are on{" "}
                    <Link href="/admin/ready-to-assign" className="font-semibold text-brand-sky hover:underline">
                        Ready to Assign
                    </Link>
                    . Not tracked yet: hot leads not called in time · waiting for a field visit · quotes with no answer · onboarding stalled · won
                    without an approved quote.
                </p>
                <OutsideTerritoryClaims />
            </div>

            {/* Team scorecard */}
            <DashCard
                title="Team scorecard against target"
                caption={
                    monthToDate
                        ? `Actual / target to date${daysLeft == null ? "" : `, and what each person needs per working day for the rest of the month. ${daysLeft} working days left.`}`
                        : "Actuals for the selected days. Targets are monthly, so they show on This month."
                }
                action={
                    <SegmentedControl
                        label="Team in the scorecard"
                        size="sm"
                        options={[
                            { value: "field", label: "Field (ASM)" },
                            { value: "inside", label: "Inside sales (ISR)" },
                        ]}
                        value={score}
                        onChange={setScore}
                    />
                }
            >
                {!d ? (
                    dash.isLoading ? <LoadingBlock /> : <NotAvailable />
                ) : (
                    (() => {
                        const list = score === "field" ? fieldPeople : insidePeople;
                        const heads =
                            score === "field"
                                ? ["Dealer visits", "New dealer visits", "Batteries to dealers", "KYC submitted", "Revenue"]
                                : ["Calls per day", "Dealers called", "Hot leads to field", "New hot leads", "Quotes issued"];
                        if (list.length === 0) return <NotAvailable empty reason="No one in this team has activity for these filters." />;
                        return (
                            <div className="overflow-x-auto">
                                <div className="min-w-[900px]">
                                    <div className={`grid grid-cols-[180px_repeat(5,minmax(0,1fr))_150px] gap-3 border-b border-border pb-2 ${TABLE_HEAD}`}>
                                        <span>Person</span>
                                        {heads.map((h) => (
                                            <span key={h}>{h}</span>
                                        ))}
                                        <span className="text-right">{score === "field" ? "Revenue needed per day" : "Converted"}</span>
                                    </div>
                                    {list.map((p) => {
                                        const hotToGround = targetOf(p.spoc_id, "hot_to_ground");
                                        const cells: ScoreCell[] =
                                            score === "field"
                                                ? [
                                                      cell(p.spoc_id, "dealer_visits", p.totals.visits),
                                                      cell(p.spoc_id, "new_dealer_visits", p.totals.new_visits),
                                                      cell(p.spoc_id, "batteries_sold", p.outcome.batteries_to_dealers),
                                                      cell(p.spoc_id, "kyc_submitted", p.outcome.kyc_submitted),
                                                      cell(p.spoc_id, "revenue", p.outcome.revenue, true),
                                                  ]
                                                : [
                                                      cell(p.spoc_id, "calls_per_day", p.averages.avg_calls_per_day),
                                                      cell(p.spoc_id, null, p.totals.dealers_called),
                                                      hotToGround && hotToGround.progress.actual != null
                                                          ? cell(p.spoc_id, "hot_to_ground", hotToGround.progress.actual)
                                                          : { actual: "—", target: null, pct: null },
                                                      cell(p.spoc_id, null, p.totals.new_hot),
                                                      cell(p.spoc_id, null, p.outcome.quotes_issued),
                                                  ];
                                        const need = targetOf(p.spoc_id, "revenue")?.progress ?? null;
                                        return (
                                            <div
                                                key={p.spoc_id}
                                                className="grid min-h-[50px] grid-cols-[180px_repeat(5,minmax(0,1fr))_150px] items-center gap-3 border-b border-[#f1f4f7]"
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => update({ spoc_id: p.spoc_id })}
                                                    className="truncate text-left text-[13.5px] font-semibold text-ink hover:text-brand-sky"
                                                    title="Show only this person"
                                                >
                                                    {p.name ?? "Unnamed"}
                                                </button>
                                                {cells.map((c, i) => {
                                                    const tone = toneForPct(c.pct);
                                                    return (
                                                        <div key={i} className="flex flex-col gap-1">
                                                            <span className="text-[13px] text-ink tabular-nums">
                                                                <span className="font-bold">{c.actual}</span>{" "}
                                                                {c.target != null && <span className="text-ink-muted">/ {c.target}</span>}{" "}
                                                                {c.pct != null && <span className={`font-bold ${toneText(tone)}`}>{c.pct}%</span>}
                                                            </span>
                                                            {c.pct != null && (
                                                                <ProgressBar pct={Math.min((c.pct / 120) * 100, 100)} tone={tone} height={6} />
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                                <span className="text-right text-[13px] font-semibold text-ink tabular-nums">
                                                    {score === "inside"
                                                        ? num(p.totals.converted)
                                                        : !need
                                                          ? "No target"
                                                          : need.remaining != null && need.remaining <= 0
                                                            ? "Target met"
                                                            : need.required_per_day == null
                                                              ? "—"
                                                              : `${inr(need.required_per_day)} a day`}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })()
                )}
                <span className="text-xs text-ink-muted">
                    Targets come from{" "}
                    <Link href="/admin/targets" className="font-semibold text-brand-sky hover:underline">
                        Targets
                    </Link>
                    , pro-rata to working days. Batteries, KYC and revenue reach a person through their dealer accounts&apos; GSTIN. A figure with
                    no target shows the actual alone.
                    {monthToDate && targets.error ? " Targets could not be loaded for your role." : ""}
                </span>
            </DashCard>

            {/* Open leads + handoffs */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <DashCard
                    className="xl:col-span-2"
                    title="Where open leads are sitting"
                    caption={
                        worst && Number(worst.not_worked ?? 0) > 0
                            ? `Open leads and what happened to them in the period, by person. ${String(worst.person)} has ${num(Number(worst.not_worked))} leads not worked.`
                            : "Open leads and what happened to them in the period, by person."
                    }
                    action={
                        <SegmentedControl
                            label="Show in cells"
                            size="sm"
                            options={[
                                { value: "count", label: "How many" },
                                { value: "aged", label: "Stuck over 7 days", disabled: true, title: "Not available yet — time in stage is not tracked" },
                            ]}
                            value="count"
                            onChange={() => undefined}
                        />
                    }
                >
                    {!byOwner.data ? (
                        byOwner.isLoading ? <LoadingBlock /> : <NotAvailable reason={(byOwner.error as Error | null)?.message} />
                    ) : ownerRows.length === 0 ? (
                        <NotAvailable empty reason="No one owns open leads for these filters." />
                    ) : (
                        <div className="overflow-x-auto">
                            <div className="flex min-w-[720px] flex-col gap-1">
                                <div className={`grid grid-cols-[150px_repeat(8,minmax(0,1fr))] gap-1 ${TABLE_HEAD} !tracking-[0.04em]`}>
                                    <span />
                                    {HEAT_COLS.map((k) => (
                                        <span key={k} className="text-center leading-snug">
                                            {heatLabel(k)}
                                        </span>
                                    ))}
                                </div>
                                {ownerRows.map((r, i) => (
                                    <div key={idKey ? String(r[idKey]) : i} className="grid grid-cols-[150px_repeat(8,minmax(0,1fr))] items-center gap-1">
                                        <span className="truncate text-[13px] font-semibold text-ink">{String(r.person)}</span>
                                        {HEAT_COLS.map((k) => (
                                            <HeatCell key={k} value={Number(r[k] ?? 0)} max={heatMax[k]} />
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                        <span>Fewer</span>
                        {HEAT_LEGEND.map((c) => (
                            <span key={c} className="h-3 w-[22px] rounded-[3px]" style={{ background: c }} />
                        ))}
                        <span>More · shaded within each column ·</span>
                        <Link href="/admin/reports" className="font-semibold text-brand-sky hover:underline">
                            open Funnel by Owner for the lead lists
                        </Link>
                    </div>
                </DashCard>

                <DashCard
                    title="Handoffs to field"
                    caption={<span className="text-[13px] text-ink-muted">Leads an ISR handed to each ASM in the period, and how they closed</span>}
                >
                    {!handoff.data ? (
                        handoff.isLoading ? <LoadingBlock /> : <NotAvailable reason={(handoff.error as Error | null)?.message} />
                    ) : handoff.data.rows.length === 0 ? (
                        <NotAvailable empty reason="No handoffs in this period." />
                    ) : (
                        <div className="flex flex-col">
                            <div className={`grid grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] gap-2.5 border-b border-border pb-2 ${TABLE_HEAD}`}>
                                <span>ASM</span>
                                <span className="text-right">Handoffs</span>
                                <span className="text-right">Converted</span>
                                <span className="text-right">Days to close</span>
                            </div>
                            {handoff.data.rows.map((r, i) => (
                                <div
                                    key={i}
                                    className="grid min-h-10 grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] items-center gap-2.5 border-b border-[#f1f4f7] text-[13.5px] tabular-nums"
                                >
                                    <span className="truncate font-semibold">{String(r.asm_name ?? "Unassigned")}</span>
                                    <span className="text-right">{num(Number(r.handoffs ?? 0))}</span>
                                    <span className="text-right">
                                        {num(Number(r.converted ?? 0))}
                                        {r.conversion_rate != null && <span className="text-ink-muted"> · {r.conversion_rate}%</span>}
                                    </span>
                                    <span className="text-right">{r.avg_days_to_close == null ? "—" : r.avg_days_to_close}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    <span className="mt-auto text-xs leading-relaxed text-ink-muted">
                        Speed measures (sales-ready to assigned, assigned to first attempt, transfer to first visit) are not tracked yet.
                    </span>
                </DashCard>
            </div>

            {/* Calling + field */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <DashCard
                    title="Calling (inside sales)"
                    caption={<span className="text-[13px] text-ink-muted">Calls logged in the period, per person</span>}
                >
                    <PeopleTable
                        loading={dash.isLoading}
                        people={shown.filter((p) => inSeg(p.role, "inside"))}
                        heads={["Calls", "Per day", "Dealers called", "New hot", "Converted"]}
                        row={(p) => [
                            num(p.totals.calls),
                            num(p.averages.avg_calls_per_day),
                            num(p.totals.dealers_called),
                            num(p.totals.new_hot),
                            num(p.totals.converted),
                        ]}
                    />
                    <span className="text-xs leading-relaxed text-ink-muted">
                        Connected, engaged (30 seconds or more) and WhatsApp-contact shares per person are not available on this screen yet.
                    </span>
                </DashCard>

                <DashCard title="Field (ASM)" caption={<span className="text-[13px] text-ink-muted">Visits logged in the period, per person</span>}>
                    <PeopleTable
                        loading={dash.isLoading}
                        people={shown.filter((p) => inSeg(p.role, "field"))}
                        heads={["Visits", "Dealers visited", "New dealers", "Planned today", "KYC submitted"]}
                        row={(p) => [
                            num(p.totals.visits),
                            num(p.totals.unique_visits),
                            num(p.totals.new_visits),
                            num(p.snapshot.planned_visits_today),
                            num(p.outcome.kyc_submitted),
                        ]}
                    />
                    <span className="text-xs leading-relaxed text-ink-muted">
                        Verified visits (shop photo and location pin) and productive-visit shares are not tracked yet.
                    </span>
                </DashCard>
            </div>

            {/* Quotes */}
            <DashCard
                title="Quotes in progress"
                action={<span className="text-[13px] text-ink-muted">Quotes created in the period</span>}
            >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-[#fbfcfd] p-4">
                        <span className="text-[13px] font-semibold">Quotes issued</span>
                        <span className="text-[26px] font-bold text-brand-navy tabular-nums">{d ? num(d.outcome.quotes_issued) : "—"}</span>
                        <span className="text-[12.5px] text-ink-muted">Leads with a first quote</span>
                    </div>
                    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-[#fbfcfd] p-4">
                        <span className="text-[13px] font-semibold">Revised quotes</span>
                        <span className="text-[26px] font-bold text-brand-navy tabular-nums">{d ? num(d.outcome.quote_revisions) : "—"}</span>
                        <span className="text-[12.5px] text-ink-muted">Later versions of a quote</span>
                    </div>
                    <NotAvailable
                        className="flex flex-col justify-center"
                        reason="Waiting for approval, delivered, declined and dealer-said-yes boxes with time limits are not available to this screen yet."
                    />
                </div>
            </DashCard>

            {/* Accounts + lost */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <DashCard
                    title="Accounts by owner"
                    caption={<span className="text-[13px] text-ink-muted">Live dealer accounts each person manages, as of today</span>}
                    action={
                        unowned > 0 ? (
                            <CardLink href="/admin/account-management" primary>
                                Assign {num(unowned)} without owner
                            </CardLink>
                        ) : undefined
                    }
                >
                    {!health.data ? (
                        health.isLoading ? <LoadingBlock /> : <NotAvailable reason={(health.error as Error | null)?.message} />
                    ) : groups.length === 0 ? (
                        <NotAvailable empty reason="No live dealer accounts yet." />
                    ) : (
                        <div className="overflow-x-auto">
                            <div className="min-w-[480px]">
                                <div className={`grid grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))] gap-2.5 border-b border-border pb-2 ${TABLE_HEAD}`}>
                                    <span>Owner</span>
                                    <span className="text-right">Accounts</span>
                                    <span className="text-right">Ordering</span>
                                    <span className="text-right">Red + dormant</span>
                                    <span className="text-right">Billed 90 days</span>
                                </div>
                                {groups.map((g) => {
                                    const risk = (g.by_bucket.red ?? 0) + (g.by_bucket.dormant ?? 0);
                                    return (
                                        <div
                                            key={g.group}
                                            className="grid min-h-[38px] grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))] items-center gap-2.5 border-b border-[#f1f4f7] text-[13.5px] tabular-nums"
                                        >
                                            <span className="truncate font-semibold">{g.group}</span>
                                            <span className="text-right">{num(g.dealers)}</span>
                                            <span className="text-right">{num((g.by_bucket.active ?? 0) + (g.by_bucket.cooling ?? 0))}</span>
                                            <span className={`text-right font-bold ${risk >= 8 ? "text-danger" : ""}`}>{num(risk)}</span>
                                            <span className="text-right">{g.revenue_90d ? inr(g.revenue_90d) : "—"}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    <span className="text-xs text-ink-muted">Ordering = last order within 30 days.</span>
                </DashCard>

                <DashCard
                    title="Why we lost"
                    caption={
                        lost.data
                            ? `${num(lostTotal)} leads lost in the period${dropouts > 0 ? `, plus ${num(dropouts)} onboarding drop-outs` : ""}.`
                            : undefined
                    }
                >
                    {!lost.data ? (
                        lost.isLoading ? <LoadingBlock /> : <NotAvailable reason={(lost.error as Error | null)?.message} />
                    ) : salesLost.length === 0 ? (
                        <NotAvailable empty reason="No leads were marked Lost in this period." />
                    ) : (
                        <div className="flex flex-col gap-2.5">
                            {salesLost.map((l) => (
                                <div key={l.reason} className="grid grid-cols-[minmax(0,190px)_minmax(0,1fr)_44px] items-center gap-3">
                                    <span className="truncate text-[13.5px] font-semibold capitalize">{l.reason.replace(/_/g, " ")}</span>
                                    <ProgressBar pct={(l.n / salesLost[0].n) * 100} />
                                    <span className="text-right text-[13.5px] font-bold tabular-nums">{num(l.n)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    <span className="mt-auto text-xs text-ink-muted">The stage a lead was lost at is not tracked yet.</span>
                </DashCard>
            </div>
        </div>
    );
}

function PeopleTable({
    people,
    heads,
    row,
    loading,
}: {
    people: SalesSpocBlock[];
    heads: string[];
    row: (p: SalesSpocBlock) => string[];
    loading: boolean;
}) {
    if (loading && people.length === 0) return <LoadingBlock />;
    if (people.length === 0) return <NotAvailable empty reason="No one in this team has activity for these filters." />;
    return (
        <div className="overflow-x-auto">
            <div className="min-w-[520px]">
                <div className={`grid grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))] gap-2.5 border-b border-border pb-2 ${TABLE_HEAD}`}>
                    <span>Person</span>
                    {heads.map((h) => (
                        <span key={h} className="text-right">
                            {h}
                        </span>
                    ))}
                </div>
                {people.map((p) => (
                    <div
                        key={p.spoc_id}
                        className="grid min-h-[42px] grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))] items-center gap-2.5 border-b border-[#f1f4f7] text-[13.5px] tabular-nums"
                    >
                        <span className="truncate font-semibold">{p.name ?? "Unnamed"}</span>
                        {row(p).map((v, i) => (
                            <span key={i} className="text-right">
                                {v}
                            </span>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
