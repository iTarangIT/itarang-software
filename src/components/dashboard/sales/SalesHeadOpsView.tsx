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

import { SALES_DASHBOARD_MAX_DAYS, type SalesDashboard, type SalesSpocBlock } from "@/lib/admin/salesDashboardTypes";
import type { ReportResult, UserOption } from "@/lib/admin/types";
import type { TargetRow } from "@/lib/targets/service";
import type { TargetMetric } from "@/lib/targets/rules";
import type { NeedsAttentionHolderSummary } from "@/lib/leads/needsAttention";
import type { DealerHealthGroup, DealerHealthRow } from "@/lib/dealers/accountHealth";
import type { RegionsResponse } from "@/app/api/locations/regions/route";
import type { ActionKey, ActionSummary } from "@/lib/dashboard/salesHeadActions";
import type { IsrScore } from "@/lib/admin/isrScorecard";
import type { SalesHeadMeasures } from "@/lib/dashboard/salesHeadMeasures";
import { STUCK_DAYS, batteryText, countWithShare, hoursText, share } from "@/lib/dashboard/salesHeadMeasureFormat";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import { OPEN_STATUSES, type LeadStatus } from "@/lib/lifecycle/transitions";
import { OutsideTerritoryClaims } from "@/components/leads/OutsideTerritoryClaims";
import { EcofyStageTile } from "@/components/ecofy/EcofyStageTile";
import { batteryReading } from "@/lib/admin/batteryReading";
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
import { DrillLeadsModal, type DrillTarget } from "@/app/(dashboard)/admin/reports/_components/DrillLeadsModal";
import { SalesDrillModal, type SalesDrillTarget } from "./SalesDrillModal";
import type { DrillKind, DrillRow } from "@/lib/dashboard/salesDrill";
import { ResponseTimeCard } from "./ResponseTimeCard";
import { BUSINESS_TYPE_OPTIONS, BUSINESS_TYPE_UNSET, BUSINESS_TYPE_UNSET_LABEL } from "@/lib/leads/businessType";
import { orderByTeam } from "@/lib/users/teamRules";
import { InvoicesReadUpTo } from "@/components/sales/InvoicesReadUpTo";

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
/** YYYY-MM-DD moved by `days`. */
const addDays = (day: string, days: number) => {
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() + days);
    return ymd(d);
};

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

type ScoreCell = {
    actual: string;
    target: string | null;
    pct: number | null;
    /** Shown after "/" when there is no target ("no target", "of calls", "delivered"). */
    note?: string;
    /** A share, not progress to a target: plain colour, bar = pct. */
    neutral?: boolean;
    /** A bar with no % - e.g. relative to the team's best. */
    bar?: number;
};

export function SalesHeadOpsView() {
    const router = useRouter();
    const pathname = usePathname();
    const { filters } = useSalesDashboardFilters(true);
    const [team, setTeam] = React.useState<TeamSeg>("all");
    const [score, setScore] = React.useState<"field" | "inside">("field");
    const [phone, setPhone] = React.useState("");
    const [pressed, setPressed] = React.useState<Period | null>(null);
    // ID 88 — "Where open leads are sitting": activity in the period, or time in stage.
    const [cells, setCells] = React.useState<"count" | "aged">("count");
    // A clicked number in "Where open leads are sitting" — its lead list popup.
    const [drill, setDrill] = React.useState<DrillTarget | null>(null);
    // Any other clicked number on the screen (salesDrill.ts) — its rows popup.
    const [sdrill, setSdrill] = React.useState<SalesDrillTarget | null>(null);

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
        const next: Record<string, string> = {
            from: filters.from,
            to: filters.to,
            state: filters.state,
            city: filters.city,
            spoc_id: filters.spoc_id,
            business_type: filters.business_type,
            ...patch,
        };
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
        const s = p.toString();
        router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
    };

    const dashQs = new URLSearchParams({ from, to });
    if (filters.state) dashQs.set("state", filters.state);
    if (filters.spoc_id) dashQs.set("spoc_id", filters.spoc_id);
    // ID 11 — city and type of business, honoured by the dashboard figures and
    // by the funnel / lost / handoff reports (one shared lead scope).
    const reportQs = new URLSearchParams({ date_from: from, date_to: to });
    if (filters.state) reportQs.set("state", filters.state);
    for (const k of ["city", "business_type"] as const) {
        if (filters[k]) {
            dashQs.set(k, filters[k]);
            reportQs.set(k, filters[k]);
        }
    }

    const dash = useQuery<SalesDashboard>({
        queryKey: ["sales-head-ops", "dashboard", dashQs.toString()],
        queryFn: () => getData(`/api/admin/reports/sales-dashboard?${dashQs}`),
        placeholderData: (prev) => prev,
    });
    const targets = useQuery<{ rows: TargetRow[]; context: { working_days_total: number; working_days_elapsed: number } }>({
        queryKey: ["sales-head-ops", "targets", to.slice(0, 7)],
        queryFn: () => getData(`/api/admin/targets?month=${to.slice(0, 7)}`),
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    const idle = useQuery<{ holders: NeedsAttentionHolderSummary[] }>({
        queryKey: ["sales-head-ops", "idle"],
        queryFn: () => getData("/api/admin/needs-attention"),
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    // ID 156: who reports to whom, so the scorecard lists each team under its manager.
    const lines = useQuery<{ rows: Array<{ user_id: string; reports_to: string | null }> }>({
        queryKey: ["sales-head-ops", "reporting-lines"],
        queryFn: () => getData("/api/admin/reporting-lines"),
        staleTime: 10 * 60 * 1000,
        retry: false,
    });
    const managerOf = React.useMemo(
        () => new Map((lines.data?.rows ?? []).filter((r) => r.reports_to).map((r) => [r.user_id, r.reports_to as string])),
        [lines.data],
    );
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
    // The seven tiles beyond idle / dealer health; same filters as the screen.
    const actionQs = new URLSearchParams();
    if (filters.state) actionQs.set("state", filters.state);
    if (filters.spoc_id) actionQs.set("spoc_id", filters.spoc_id);
    if (team !== "all") actionQs.set("team", team);
    const actions = useQuery<ActionSummary>({
        queryKey: ["sales-head-ops", "needs-action", actionQs.toString()],
        queryFn: () => getData(`/api/admin/reports/needs-action?${actionQs}`),
        placeholderData: (prev) => prev,
        staleTime: 60 * 1000,
        retry: false,
    });
    // ID 189 — targets the CEO posted that are not pushed to the team yet (this
    // month and later), and open "Ask for correction" requests. A role without
    // the Targets page gets a 403 and the tile is simply left out.
    const awaitingTargets = useQuery<{ targets: number; people: number; corrections: number; first_month: string | null }>({
        queryKey: ["sales-head-ops", "targets-awaiting"],
        queryFn: () => getData("/api/admin/targets?awaiting=1"),
        staleTime: 60 * 1000,
        retry: false,
    });
    // Inside-sales scorecard figures the sales dashboard does not carry
    // (engaged calls, hot leads visited, quotes delivered, Won).
    const isrQs = new URLSearchParams({ from, to });
    if (filters.state) isrQs.set("state", filters.state);
    const isr = useQuery<Record<string, IsrScore>>({
        queryKey: ["sales-head-ops", "isr-scorecard", isrQs.toString()],
        queryFn: () => getData(`/api/admin/reports/isr-scorecard?${isrQs}`),
        enabled: score === "inside",
        placeholderData: (prev) => prev,
        retry: false,
    });
    // ID 88 — the figures that used to read "not tracked yet": speed, stuck
    // over 7 days, engaged / WhatsApp shares, verified visits, quote boxes,
    // stage lost at, and the batteries estimate. Same filters as the dashboard.
    const measures = useQuery<SalesHeadMeasures>({
        queryKey: ["sales-head-ops", "measures", dashQs.toString()],
        queryFn: () => getData(`/api/admin/reports/sales-head-measures?${dashQs}`),
        placeholderData: (prev) => prev,
        retry: false,
    });
    const m = measures.data;
    const regions = useQuery<RegionsResponse>({
        queryKey: ["sales-head-ops", "regions"],
        queryFn: () => getData("/api/locations/regions"),
        staleTime: 60 * 60 * 1000,
    });
    // Cities of the chosen state; every city when no state is chosen.
    const cityOptions = React.useMemo(() => {
        const r = regions.data;
        if (!r) return [];
        const code = r.states.find((st) => st.name === filters.state)?.code;
        const list = code ? (r.citiesByState[code] ?? []) : Object.values(r.citiesByState).flat();
        return [...new Set(list)].sort((a, b) => a.localeCompare(b));
    }, [regions.data, filters.state]);
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

    // ── Targets ──────────────────────────────────────────────────────────────
    // A target is a monthly figure. This month: the targets service's own
    // to-date progress. Any other period: the monthly target pro-rata to the
    // period's working days (Mon–Sat) out of the month's, against the period's
    // actual — so Today / This week read "actual / target" too.
    // ID 157 (Kartik, 10 Oct): people reports count every target that was sent
    // (pushed), accepted or not; a draft or one waiting for approval stays out.
    const targetOf = (userId: string, metric: TargetMetric) =>
        targets.data?.rows.find(
            (t) => t.user_id === userId && t.metric === metric && (t.status === "pushed" || t.status === "accepted"),
        ) ?? null;
    const monthDays = targets.data?.context.working_days_total ?? 0;
    const daysLeft = targets.data ? Math.max(monthDays - targets.data.context.working_days_elapsed, 0) : null;
    const periodDays = React.useMemo(() => {
        let n = 0;
        const end = new Date(`${to}T00:00:00`);
        for (let d = new Date(`${from}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0) n++;
        return n;
    }, [from, to]);
    const targetDays = monthToDate ? (targets.data?.context.working_days_elapsed ?? 0) : periodDays;
    const cell = (userId: string, metric: TargetMetric | null, fallback: number, money = false): ScoreCell => {
        const fmt = (v: number) => (money ? inr(v) : num(v));
        const t = metric ? targetOf(userId, metric) : null;
        if (!t) return { actual: fmt(fallback), target: null, pct: null, note: "no target", bar: 0 };
        if (monthToDate) {
            return {
                actual: t.progress.actual == null ? fmt(fallback) : fmt(t.progress.actual),
                target: fmt(t.progress.mtd_target),
                pct: t.progress.pct_of_mtd == null ? null : Math.round(t.progress.pct_of_mtd),
            };
        }
        const perDay = metric === "calls_per_day";
        const goal = perDay ? t.progress.monthly_target : monthDays > 0 ? (t.progress.monthly_target * periodDays) / monthDays : 0;
        return {
            actual: fmt(fallback),
            target: fmt(Math.round(goal * 10) / 10),
            pct: goal > 0 ? Math.round((fallback / goal) * 100) : null,
        };
    };
    // ID 88 #4 — batteries come from invoice item lines. Invoices in range with
    // no lines captured make the count unknown ("—", never 0); some without
    // lines make it a floor ("n+"). Same rule as the sales dashboard tables.
    // When lines are missing, the dealer-approved quote's battery units stand
    // in as a labelled estimate ("≈"), never mixed into the invoice count.
    const batteryCell = (p: SalesSpocBlock): ScoreCell => {
        const r = batteryReading(p.outcome);
        const est = m?.batteries?.find((b) => b.spoc === p.spoc_id);
        if (r.state === "unknown") {
            const t = batteryText(r, "", est, num);
            return { actual: t.actual, target: null, pct: null, note: t.note };
        }
        const c = cell(p.spoc_id, "batteries_sold", p.outcome.batteries_to_dealers);
        return { ...c, actual: batteryText(r, c.actual, est, num).actual };
    };

    // ── Needs action now ─────────────────────────────────────────────────────
    const holders = (idle.data?.holders ?? []).filter((h) => inSeg(h.holder_role, team) && (!filters.spoc_id || h.holder_id === filters.spoc_id));
    const idleTotal = holders.reduce((a, h) => a + h.idle, 0);
    const idleOver14 = holders.reduce((a, h) => a + h.idle_over_14, 0);
    const deadNumbers = holders.reduce((a, h) => a + h.non_responsive, 0);
    const groups = health.data?.summary ?? [];
    const redDormant = groups.reduce((a, g) => a + (g.by_bucket.red ?? 0) + (g.by_bucket.dormant ?? 0), 0);
    const atRisk = groups.reduce((a, g) => a + g.at_risk_90d, 0);
    // ID 148: live dealers only — a closed dealer needs no owner (summary groups are live already).
    const unowned = (health.data?.rows ?? []).filter((r) => !r.owner_id && r.bucket !== "closed").length;
    const hot = d?.interest.rows.find((r) => r.interest_level === "hot");
    const hotAged = hot ? hot.age_8_14 + hot.age_15_30 + hot.age_30_plus : 0;
    const hotQs = new URLSearchParams();
    if (filters.state) hotQs.set("state", filters.state);
    if (filters.spoc_id) hotQs.set("spoc_id", filters.spoc_id);

    type Tile = React.ComponentProps<typeof ActionTile> & { key: string; n: number; ready: boolean };
    const a = actions.data;
    const actionTile = (
        key: ActionKey,
        label: string,
        severity: Tile["severity"],
        href = `/admin/reports/needs-action/${key}${actionQs.toString() ? `?${actionQs}` : ""}`,
    ): Tile => ({
        key,
        ready: Boolean(a?.[key]),
        n: a?.[key]?.count ?? 0,
        severity,
        count: num(a?.[key]?.count ?? 0),
        label,
        sub: a?.[key]?.sub,
        href,
    });
    const tiles: Tile[] = [
        actionTile("sales_ready", "Sales-ready leads with no owner", "now", "/admin/ready-to-assign"),
        actionTile("hot_not_called", "Hot leads not called in time", "now"),
        actionTile("visit_overdue", "Waiting for a field visit", "now"),
        actionTile("won_undo_requests", "Undo Mark Won requests waiting", "now"),
        {
            key: "hot",
            ready: Boolean(d),
            n: hotAged,
            severity: "now",
            count: num(hotAged),
            label: "Hot leads open more than 7 days",
            sub: hot ? `${num(hot.total)} Hot leads open in all · ${num(hot.age_30_plus)} older than 30 days` : undefined,
            // The count comes from the sales dashboard, which takes state and person but not team.
            href: `/admin/reports/needs-action/hot_aged${hotQs.toString() ? `?${hotQs}` : ""}`,
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
            key: "targets_awaiting",
            ready: Boolean(awaitingTargets.data),
            n: (awaitingTargets.data?.targets ?? 0) + (awaitingTargets.data?.corrections ?? 0),
            severity: "soon",
            count: num(awaitingTargets.data?.targets ?? 0),
            label: "Targets waiting for your approval",
            sub: awaitingTargets.data
                ? `Posted by the CEO, not pushed yet · ${num(awaitingTargets.data.people)} ${awaitingTargets.data.people === 1 ? "person" : "people"}` +
                  (awaitingTargets.data.corrections ? ` · ${num(awaitingTargets.data.corrections)} correction${awaitingTargets.data.corrections === 1 ? "" : "s"} asked` : "")
                : undefined,
            href: `/admin/targets${awaitingTargets.data?.first_month ? `?month=${awaitingTargets.data.first_month.slice(0, 7)}` : ""}`,
        },
        actionTile("quotes_no_answer", "Quotes with no answer", "soon"),
        actionTile("said_yes", "Dealer approved, but not marked Won", "soon"),
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
        actionTile("onboarding_stalled", "Onboarding stalled", "soon"),
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
            href: "/admin/accounts",
        },
        actionTile("won_without_quote", "Won without an approved quote", "info"),
        actionTile("won_undone_week", "Won undone in the last 7 days", "info"),
    ];
    // A tile whose source failed on this database (not ready) is left out;
    // a zero tile is shown, marked "All clear".
    const readyTiles = tiles.filter((t) => t.ready);
    const openTiles = readyTiles.filter((t) => t.n > 0);

    // ── Where open leads are sitting ─────────────────────────────────────────
    const HEAT_COLS = ["owned_open", "not_worked", "touched", "connected", "hot", "warm", "cold", "converted"] as const;
    const idKey = byOwner.data?.drill?.idKey;
    const ownerRows = (byOwner.data?.rows ?? []).filter(
        (r) => inSeg(r.role == null ? null : String(r.role), team) && (!filters.spoc_id || !idKey || String(r[idKey]) === filters.spoc_id),
    );
    const heatLabel = (k: string) => byOwner.data?.columns.find((c) => c.key === k)?.label ?? k;
    const heatMax = Object.fromEntries(HEAT_COLS.map((k) => [k, Math.max(0, ...ownerRows.map((r) => Number(r[k] ?? 0)))]));
    // A column's CSV: every lead behind that column, for the people on screen.
    const columnCsvHref = (k: string) => {
        const p = new URLSearchParams(reportQs);
        p.set("metric", k);
        p.set("format", "csv");
        if (idKey) p.set("person_ids", ownerRows.map((r) => String(r[idKey] ?? "")).filter(Boolean).join(","));
        return `/api/admin/reports/owner-leads?${p}`;
    };
    const worst = [...ownerRows].sort((a, b) => Number(b.not_worked ?? 0) - Number(a.not_worked ?? 0))[0];

    // ── Why we lost ──────────────────────────────────────────────────────────
    const lostRows = (lost.data?.rows ?? []).map((r) => ({ category: String(r.category), reason: String(r.reason), n: Number(r.count ?? 0) }));
    const salesLost = lostRows.filter((r) => r.category === "Sales lost" && r.n > 0).sort((a, b) => b.n - a.n);
    const lostTotal = salesLost.reduce((a, r) => a + r.n, 0);
    const dropouts = lostRows.filter((r) => r.category !== "Sales lost").reduce((a, r) => a + r.n, 0);

    const csvHref = `/api/admin/reports/sales-dashboard?${dashQs}&format=csv`;

    // ── Click a number → its rows (salesDrill.ts) ───────────────────────────
    /** The screen's filters + which number; `extra` = person / persons / key. */
    const drillQuery = (kind: DrillKind, extra: Record<string, string> = {}) => {
        const q = new URLSearchParams(dashQs);
        q.set("kind", kind);
        for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
        return q.toString();
    };
    const openDrill = (title: string, count: number, kind: DrillKind, extra: Record<string, string> = {}) => {
        if (count > 0) setSdrill({ title, count, query: drillQuery(kind, extra) });
    };
    /** A column's CSV: every row behind that column for the people listed. */
    const columnCsv = (kind: DrillKind, people: SalesSpocBlock[]) =>
        `/api/admin/reports/sales-drill?${drillQuery(kind, { persons: people.map((p) => p.spoc_id).join(",") })}&format=csv`;
    // Accounts by owner: the page already holds every account row.
    const accountRows = (group: string, buckets: string[] | null): DrillRow[] =>
        (health.data?.rows ?? [])
            .filter((r) => (r.owner_name ?? "(unassigned)") === group && (!buckets || buckets.includes(r.bucket)))
            .map((r) => ({
                id: r.account_id ?? r.key,
                href: r.account_id ? `/admin/accounts/${encodeURIComponent(r.account_id)}` : r.lead_id ? `/inside-sales/lead/${encodeURIComponent(r.lead_id)}` : null,
                name: r.dealer,
                phone: null,
                city: r.city,
                state: r.state,
                status: r.bucket,
                rating: r.gstin,
                person_id: r.owner_id,
                person_name: r.owner_name,
                owner_name: r.business_type ? r.business_type.replace(/_/g, " ") : null,
                at: r.last_order,
                detail: [
                    r.last_order ? `last order ${r.last_order}` : "no order yet",
                    `${r.orders} order${r.orders === 1 ? "" : "s"}`,
                    r.revenue_90d ? `${inr(r.revenue_90d)} billed in 90 days` : null,
                    r.closed_reason,
                ]
                    .filter(Boolean)
                    .join(" · "),
            }));
    const openAccounts = (group: string, label: string, buckets: string[] | null) => {
        const rows = accountRows(group, buckets);
        if (rows.length > 0) setSdrill({ title: `${group} — ${label}`, count: rows.length, rows, csvName: `accounts-${group}-${label}`.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
    };

    // Pinned with the page header while scrolling, so it is sized to sit on one
    // row on a laptop screen: long state names and the search box are capped.
    const filterBar = (
        <div className="flex flex-wrap items-center gap-2.5 rounded-[14px] border border-border bg-surface px-3 py-2">
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
                <select value={filters.state} onChange={(e) => update({ state: e.target.value, city: "" })} className={`${SELECT} max-w-[170px]`}>
                    <option value="">All states</option>
                    {(regions.data?.states ?? []).map((s) => (
                        <option key={s.code} value={s.name}>
                            {s.name}
                        </option>
                    ))}
                </select>
            </label>
            <label className="flex items-center gap-2 text-[13px] text-ink-muted">
                City
                <select value={filters.city} onChange={(e) => update({ city: e.target.value })} className={`${SELECT} max-w-[170px]`}>
                    <option value="">All cities</option>
                    {cityOptions.map((c) => (
                        <option key={c} value={c}>
                            {c}
                        </option>
                    ))}
                </select>
            </label>
            <label className="flex items-center gap-2 text-[13px] text-ink-muted">
                Type of business
                <select
                    value={filters.business_type}
                    onChange={(e) => update({ business_type: e.target.value })}
                    className={`${SELECT} max-w-[170px]`}
                >
                    <option value="">All types</option>
                    {BUSINESS_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                    <option value={BUSINESS_TYPE_UNSET}>{BUSINESS_TYPE_UNSET_LABEL}</option>
                </select>
            </label>
            <label className="flex items-center gap-2 text-[13px] text-ink-muted">
                Person
                <select value={filters.spoc_id} onChange={(e) => update({ spoc_id: e.target.value })} className={`${SELECT} max-w-[170px]`}>
                    <option value="">Everyone</option>
                    {repOptions.map((r) => (
                        <option key={r.user_id} value={r.user_id}>
                            {r.name ?? r.email}
                        </option>
                    ))}
                </select>
            </label>
            <form
                className="ml-auto flex min-h-10 w-full items-center gap-2 rounded-[10px] border border-border bg-[#fbfcfd] px-3 sm:w-[230px]"
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
                    placeholder="Find dealer by phone"
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
    );

    return (
        <div className="flex flex-col gap-7 pb-12" data-testid="sales-head-ops">
            <DashPageHeader
                    sticky
                    eyebrow="Sales dashboard"
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
                    footer={filterBar}
                >
                    <div className="flex flex-wrap items-center justify-end gap-2.5">
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
                        {/* Any date range: the presets above are shortcuts for it. A
                            From after To pulls the other end along, never past today, and the range stays within the API's SALES_DASHBOARD_MAX_DAYS. */}
                        <div className="flex items-center gap-1.5">
                            <label className="text-[13px] text-ink-muted" htmlFor="sales-dash-from">
                                From
                            </label>
                            <input
                                id="sales-dash-from"
                                type="date"
                                value={from}
                                max={preset.today.to}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    if (!v) return;
                                    setPressed(null);
                                    update({ from: v, to: v > to ? v : to > addDays(v, SALES_DASHBOARD_MAX_DAYS - 1) ? addDays(v, SALES_DASHBOARD_MAX_DAYS - 1) : to });
                                }}
                                className={SELECT}
                            />
                            <label className="text-[13px] text-ink-muted" htmlFor="sales-dash-to">
                                To
                            </label>
                            <input
                                id="sales-dash-to"
                                type="date"
                                value={to}
                                max={preset.today.to}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    if (!v) return;
                                    setPressed(null);
                                    update({ from: v < from ? v : from < addDays(v, 1 - SALES_DASHBOARD_MAX_DAYS) ? addDays(v, 1 - SALES_DASHBOARD_MAX_DAYS) : from, to: v });
                                }}
                                className={SELECT}
                            />
                        </div>
                    </div>
                </DashPageHeader>

            {dash.error && (
                <div className="rounded-xl border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
                    {(dash.error as Error).message}
                </div>
            )}

            {/* Needs action now */}
            <div className="flex flex-col gap-3">
                <SectionHeading title="Needs action now" note="Each opens its list with the actions on the row: assign, reassign, call, open lead." />
                {/* Every tile stays on screen, a zero one marked "All clear", so
                    the grid reads the same on every database and every day. */}
                {readyTiles.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
                        {readyTiles.map((t) => (
                            <ActionTile key={t.key} severity={t.severity} count={t.count} label={t.label} sub={t.sub} href={t.href} clear={t.n === 0} />
                        ))}
                    </div>
                ) : dash.isLoading || idle.isLoading || health.isLoading || actions.isLoading ? (
                    <LoadingBlock />
                ) : null}
                {readyTiles.length > 0 && openTiles.length === 0 && (
                    <div className="flex items-center gap-2 text-[13px] font-semibold text-success">
                        <Check className="h-4 w-4" aria-hidden /> Nothing is past its limit right now.
                    </div>
                )}
                <p className="text-xs text-ink-muted">
                    Working hours for the hot-lead limit: Mon–Sat, 10:00–19:00 IST. Sales-ready leads with no owner are assigned on{" "}
                    <Link href="/admin/ready-to-assign" className="font-semibold text-brand-sky hover:underline">
                        Ready to Assign
                    </Link>
                    .
                </p>
                <OutsideTerritoryClaims
                    filters={{ from, to, state: filters.state, city: filters.city, spoc_id: filters.spoc_id, team }}
                />
            </div>

            {/* Team scorecard */}
            <DashCard
                title="Team scorecard against target"
                caption={
                    monthToDate
                        ? `Actual / target to date${daysLeft == null ? "" : `, and what each person needs per working day for the rest of the month. ${daysLeft} working days left.`}`
                        : `Actual / target for the selected days — the monthly target pro-rata to ${periodDays} working ${periodDays === 1 ? "day" : "days"}${daysLeft == null ? "" : `. Revenue needed per day is for the rest of the month: ${daysLeft} working days left`}.`
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
                        // ID 156: each manager's team right under them (↳).
                        const list = orderByTeam(score === "field" ? fieldPeople : insidePeople, managerOf);
                        const heads =
                            score === "field"
                                ? ["Dealer visits", "New dealer visits", "Batteries sold", "KYC submitted", "Revenue"]
                                : ["Calls per day", "Engaged calls", "Hot leads to field", "Of which visited", "Quotes delivered"];
                        if (list.length === 0) return <NotAvailable empty reason="No one in this team has activity for these filters." />;
                        const isrOf = (id: string): IsrScore =>
                            isr.data?.[id] ?? { calls: 0, engaged: 0, hot_to_field: 0, hot_visited: 0, quotes_delivered: 0, won: 0 };
                        const maxQuotes = Math.max(1, ...list.map((p) => isrOf(p.spoc_id).quotes_delivered));
                        const isrCell = cell;
                        return (
                            <div className="overflow-x-auto">
                                <div className="min-w-[900px]">
                                    <div className={`grid grid-cols-[180px_repeat(5,minmax(0,1fr))_150px] gap-3 border-b border-border pb-2 ${TABLE_HEAD}`}>
                                        <span>Person</span>
                                        {heads.map((h) => (
                                            <span key={h}>{h}</span>
                                        ))}
                                        <span className="text-right">{score === "field" ? "Revenue needed per day" : monthToDate ? "Won this month" : "Won"}</span>
                                    </div>
                                    {list.map((p) => {
                                        const cells: ScoreCell[] =
                                            score === "field"
                                                ? [
                                                      cell(p.spoc_id, "dealer_visits", p.totals.unique_visits),
                                                      cell(p.spoc_id, "new_dealer_visits", p.totals.new_visits),
                                                      batteryCell(p),
                                                      cell(p.spoc_id, "kyc_submitted", p.outcome.kyc_submitted),
                                                      cell(p.spoc_id, "revenue", p.outcome.revenue, true),
                                                  ]
                                                : (() => {
                                                      const x = isrOf(p.spoc_id);
                                                      const engagedPct = x.calls > 0 ? Math.round((x.engaged / x.calls) * 100) : null;
                                                      const visitedPct = x.hot_to_field > 0 ? Math.round((x.hot_visited / x.hot_to_field) * 100) : null;
                                                      const cells: ScoreCell[] = [
                                                          isrCell(p.spoc_id, "calls_per_day", p.averages.avg_calls_per_day),
                                                          engagedPct == null
                                                              ? { actual: "—", target: null, pct: null, note: "no calls" }
                                                              : { actual: `${engagedPct}%`, target: null, pct: null, note: "of calls", bar: engagedPct },
                                                          isrCell(p.spoc_id, "hot_to_ground", x.hot_to_field),
                                                          visitedPct == null
                                                              ? { actual: num(x.hot_visited), target: null, pct: null, note: "none sent" }
                                                              : { actual: num(x.hot_visited), target: num(x.hot_to_field), pct: visitedPct, neutral: true },
                                                          {
                                                              actual: num(x.quotes_delivered),
                                                              target: null,
                                                              pct: null,
                                                              note: "delivered",
                                                              bar: (x.quotes_delivered / maxQuotes) * 100,
                                                          },
                                                      ];
                                                      return cells;
                                                  })();
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
                                                    {p.member && <span className="mr-1 font-normal text-ink-muted" aria-label="reports to the person above">↳</span>}
                                                    {p.name ?? "Unnamed"}
                                                </button>
                                                {cells.map((c, i) => {
                                                    const tone = toneForPct(c.pct);
                                                    return (
                                                        <div key={i} className="flex flex-col gap-1">
                                                            <span className="text-[13px] text-ink tabular-nums">
                                                                <span className="font-bold">{c.actual}</span>{" "}
                                                                {c.target != null ? (
                                                                    <span className="text-ink-muted">/ {c.target}</span>
                                                                ) : c.note ? (
                                                                    <span className="text-ink-muted">/ {c.note}</span>
                                                                ) : null}{" "}
                                                                {c.pct != null && (
                                                                    <span className={`font-bold ${c.neutral ? "text-ink" : toneText(tone)}`}>{c.pct}%</span>
                                                                )}
                                                            </span>
                                                            {c.pct != null && !c.neutral ? (
                                                                <ProgressBar pct={Math.min((c.pct / 120) * 100, 100)} tone={tone} height={6} />
                                                            ) : c.neutral && c.pct != null ? (
                                                                <ProgressBar pct={c.pct} height={6} />
                                                            ) : c.bar != null ? (
                                                                <ProgressBar pct={c.bar} height={6} />
                                                            ) : null}
                                                        </div>
                                                    );
                                                })}
                                                <span
                                                    className={`text-right text-[13px] font-semibold tabular-nums ${
                                                        score === "field" && need?.rag === "red" && (need.remaining ?? 0) > 0 ? "text-danger" : "text-ink"
                                                    }`}
                                                >
                                                    {score === "inside"
                                                        ? (() => {
                                                              const x = isrOf(p.spoc_id);
                                                              return (
                                                                  <>
                                                                      {num(x.won)}
                                                                      {/* ID 172: 60 days after Won, promised vs ordered. */}
                                                                      {x.volume && (
                                                                          <span
                                                                              className="block text-[11px] font-normal text-ink-muted"
                                                                              title={`${x.volume.dealers} dealer(s) whose 60 days after Won ended in this period: batteries promised (2 × per month on the deal card) vs battery units invoiced.`}
                                                                          >
                                                                              60 d: {num(x.volume.actual)} of {num(x.volume.expected)} promised
                                                                          </span>
                                                                      )}
                                                                  </>
                                                              );
                                                          })()
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
                {/* ID 171 — revenue and batteries are only as fresh as the invoices read. */}
                {score === "field" && <InvoicesReadUpTo />}
                {score === "inside" && (
                    <span className="text-xs text-ink-muted">
                        Hot leads to field counts leads that were Hot at the moment of transfer. &ldquo;Of which visited&rdquo; shows whether the ASM
                        agreed they were worth a visit. Engaged = calls where the rep spoke with the dealer. Every figure is credited to the person who
                        did it.
                        {insidePeople.length > 0
                            ? (() => {
                                  const none = insidePeople.filter((p) => !targetOf(p.spoc_id, "calls_per_day") && !targetOf(p.spoc_id, "hot_to_ground"));
                                  return none.length
                                      ? ` ${none.map((p) => p.name ?? "Unnamed").join(", ")} ${none.length === 1 ? "has" : "have"} no target yet.`
                                      : "";
                              })()
                            : ""}
                        {isr.error ? " These figures could not be loaded." : ""}
                    </span>
                )}
                <span className="text-xs text-ink-muted">
                    Targets from{" "}
                    <Link href="/admin/targets" className="font-semibold text-brand-sky hover:underline">
                        Admin › Targets
                    </Link>
                    {monthDays > 0 ? `, pro-rata to ${targetDays} of ${monthDays} working days` : ", pro-rata to working days"}. Batteries and revenue
                    come from invoices matched to each person&apos;s dealer accounts. Where an invoice has no item lines, &ldquo;≈&rdquo; is an
                    estimate from the battery units on that dealer&apos;s approved quote, not an invoiced count.
                    {targets.error ? " Targets could not be loaded for your role." : ""}
                </span>
            </DashCard>

            {/* Open leads + handoffs */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <DashCard
                    className="xl:col-span-2"
                    title="Where open leads are sitting"
                    caption={
                        cells === "aged"
                            ? `Open leads that have sat in the same stage for more than ${STUCK_DAYS} days, by owner and stage, as of today.`
                            : worst && Number(worst.not_worked ?? 0) > 0
                              ? `Open leads and what happened to them in the period, by person. ${String(worst.person)} has ${num(Number(worst.not_worked))} leads not worked.`
                              : "Open leads and what happened to them in the period, by person."
                    }
                    action={
                        <SegmentedControl
                            label="Show in cells"
                            size="sm"
                            options={[
                                { value: "count", label: "How many" },
                                { value: "aged", label: `Stuck over ${STUCK_DAYS} days` },
                            ]}
                            value={cells}
                            onChange={setCells}
                        />
                    }
                >
                    {cells === "aged" ? (
                        <StuckGrid
                            rows={m?.stuck?.filter((r) => inSeg(r.role, team)) ?? null}
                            loading={measures.isLoading}
                        />
                    ) : !byOwner.data ? (
                        byOwner.isLoading ? <LoadingBlock /> : <NotAvailable reason={(byOwner.error as Error | null)?.message} />
                    ) : ownerRows.length === 0 ? (
                        <NotAvailable empty reason="No one owns open leads for these filters." />
                    ) : (
                        <div className="overflow-x-auto">
                            <div className="flex min-w-[720px] flex-col gap-1">
                                <div className={`grid grid-cols-[150px_repeat(8,minmax(0,1fr))] gap-1 ${TABLE_HEAD} !tracking-[0.04em]`}>
                                    <span />
                                    {HEAT_COLS.map((k) => (
                                        <span key={k} className="flex flex-col items-center gap-1 text-center leading-snug">
                                            {heatLabel(k)}
                                            <a
                                                href={columnCsvHref(k)}
                                                download
                                                title={`Download every lead in "${heatLabel(k)}" for the people shown (CSV)`}
                                                aria-label={`Download ${heatLabel(k)} leads as CSV`}
                                                className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-brand-sky hover:bg-bg"
                                            >
                                                <Download className="h-3 w-3" aria-hidden /> CSV
                                            </a>
                                        </span>
                                    ))}
                                </div>
                                {ownerRows.map((r, i) => (
                                    <div key={idKey ? String(r[idKey]) : i} className="grid grid-cols-[150px_repeat(8,minmax(0,1fr))] items-center gap-1">
                                        <span className="truncate text-[13px] font-semibold text-ink">{String(r.person)}</span>
                                        {HEAT_COLS.map((k) => {
                                            const v = Number(r[k] ?? 0);
                                            const personId = idKey ? String(r[idKey] ?? "") : "";
                                            return (
                                                <HeatCell
                                                    key={k}
                                                    value={v}
                                                    max={heatMax[k]}
                                                    title={v > 0 && personId ? `See ${String(r.person)}'s ${heatLabel(k).toLowerCase()} leads` : undefined}
                                                    onClick={
                                                        v > 0 && personId
                                                            ? () =>
                                                                  setDrill({
                                                                      personId,
                                                                      personName: String(r.person),
                                                                      metric: k,
                                                                      metricLabel: heatLabel(k),
                                                                      count: v,
                                                                  })
                                                            : undefined
                                                    }
                                                />
                                            );
                                        })}
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
                        <span>More · shaded within each column · click a number for its leads, or CSV on a column for all of them ·</span>
                        <Link href="/admin/reports" className="font-semibold text-brand-sky hover:underline">
                            open Funnel by Owner
                        </Link>
                        <span>·</span>
                        {/* ID 91 */}
                        <Link href="/reports?analysis=lead_sources" className="font-semibold text-brand-sky hover:underline">
                            which lead sources convert
                        </Link>
                    </div>
                    {drill && <DrillLeadsModal target={drill} qs={reportQs.toString()} onClose={() => setDrill(null)} />}
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
                                    <span className="text-right">
                                        <DrillNum
                                            value={Number(r.handoffs ?? 0)}
                                            onClick={() =>
                                                openDrill(`${String(r.asm_name ?? "Unassigned")} — handoffs`, Number(r.handoffs ?? 0), "handoffs", {
                                                    person: r.asm_id == null ? "__none__" : String(r.asm_id),
                                                })
                                            }
                                        />
                                    </span>
                                    <span className="text-right">
                                        <DrillNum
                                            value={Number(r.converted ?? 0)}
                                            onClick={() =>
                                                openDrill(`${String(r.asm_name ?? "Unassigned")} — handoffs converted`, Number(r.converted ?? 0), "handoff_converted", {
                                                    person: r.asm_id == null ? "__none__" : String(r.asm_id),
                                                })
                                            }
                                        />
                                        {r.conversion_rate != null && <span className="text-ink-muted"> · {r.conversion_rate}%</span>}
                                    </span>
                                    <span className="text-right">{r.avg_days_to_close == null ? "—" : r.avg_days_to_close}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {/* ID 88 — speed, from the lead clocks (working hours, the Response time card's clocks). */}
                    <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-3">
                        <span className={TABLE_HEAD}>Speed · median, slowest 1 in 10 (working hours)</span>
                        {!m?.speed ? (
                            <span className="text-xs text-ink-muted">
                                {measures.isLoading ? "Loading…" : "Lead clocks are not set up on this server yet (migration E-337)."}
                            </span>
                        ) : (
                            [
                                {
                                    label: "Sales-ready → assigned",
                                    s: m.speed.ready_to_assigned,
                                    n: `${num(m.speed.ready_to_assigned.assigned)} assigned${m.speed.ready_to_assigned.waiting ? ` · ${num(m.speed.ready_to_assigned.waiting)} still waiting` : ""}`,
                                },
                                { label: "Assigned → first attempt", s: m.speed.assigned_to_attempt, n: `${num(m.speed.assigned_to_attempt.started)} assignments` },
                                { label: "Transfer → first visit", s: m.speed.transfer_to_visit, n: `${num(m.speed.transfer_to_visit.started)} transfers` },
                            ].map(({ label, s, n }) => (
                                <div key={label} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-baseline gap-2 text-[13px]">
                                    <span className="font-semibold text-ink">{label}</span>
                                    <span className="text-right tabular-nums">
                                        <span className="font-bold">{hoursText(s.median_h)}</span>
                                        <span className="text-ink-muted"> · {hoursText(s.p90_h)}</span>
                                        <span className="block text-[11.5px] text-ink-muted">{n}</span>
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </DashCard>
            </div>

            {/* ID 51 #2 — Ecofy leads by stage: its own block, never in the dealer numbers above. */}
            <EcofyStageTile />

            {/* Calling + field */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <DashCard
                    title="Calling (inside sales)"
                    caption={<span className="text-[13px] text-ink-muted">Calls logged in the period, per person</span>}
                >
                    <PeopleTable
                        loading={dash.isLoading}
                        people={shown.filter((p) => inSeg(p.role, "inside"))}
                        heads={["Calls", "Per day", "Dealers called", "Engaged", "WhatsApp", "New hot", "Converted"]}
                        kinds={["calls", null, "dealers_called", "engaged", "whatsapp", "new_hot", "converted"]}
                        counts={(p) => {
                            const c = m?.calling?.find((x) => x.user_id === p.spoc_id);
                            return [p.totals.calls, 0, p.totals.dealers_called, c?.engaged ?? 0, c?.whatsapp ?? 0, p.totals.new_hot, p.totals.converted];
                        }}
                        onDrill={(p, kind, label, n) => openDrill(`${p.name ?? "Unnamed"} — ${label}`, n, kind, { person: p.spoc_id })}
                        columnCsv={columnCsv}
                        row={(p) => {
                            // ID 88 — engaged = connected calls (share of calls); WhatsApp =
                            // chats that count as contact (dealer replied + a fresh screenshot),
                            // as a share of all contacts made (engaged calls + WhatsApp).
                            const c = m?.calling?.find((x) => x.user_id === p.spoc_id);
                            const engaged = c ? countWithShare(c.engaged, share(c.engaged, c.calls), num) : m?.calling ? "0" : "—";
                            const wa = c ? countWithShare(c.whatsapp, share(c.whatsapp, c.engaged + c.whatsapp), num) : m?.calling ? "0" : "—";
                            return [
                                num(p.totals.calls),
                                num(p.averages.avg_calls_per_day),
                                num(p.totals.dealers_called),
                                engaged,
                                wa,
                                num(p.totals.new_hot),
                                num(p.totals.converted),
                            ];
                        }}
                    />
                    <span className="text-xs leading-relaxed text-ink-muted">
                        Engaged = calls where the rep spoke with the dealer, with its share of calls. WhatsApp = chats that count as contact
                        (dealer replied, with a fresh screenshot), with its share of all contacts.
                        {measures.error ? " These two columns could not be loaded." : ""}
                    </span>
                </DashCard>

                <DashCard title="Field (ASM)" caption={<span className="text-[13px] text-ink-muted">Visits logged in the period, per person</span>}>
                    <PeopleTable
                        loading={dash.isLoading}
                        people={shown.filter((p) => inSeg(p.role, "field"))}
                        heads={["Visits", "Dealers visited", "New dealers", "Verified", "Productive", "Planned today", "KYC submitted"]}
                        kinds={["visits", "dealers_visited", "new_dealers", "verified", "productive", "planned_today", "kyc_submitted"]}
                        counts={(p) => {
                            const v = m?.field?.find((x) => x.user_id === p.spoc_id);
                            return [
                                p.totals.visits,
                                p.totals.unique_visits,
                                p.totals.new_visits,
                                v?.verified ?? 0,
                                v?.productive ?? 0,
                                p.snapshot.planned_visits_today,
                                p.outcome.kyc_submitted,
                            ];
                        }}
                        onDrill={(p, kind, label, n) => openDrill(`${p.name ?? "Unnamed"} — ${label}`, n, kind, { person: p.spoc_id })}
                        columnCsv={columnCsv}
                        row={(p) => {
                            // ID 88 — of the visits marked visited in the period.
                            const v = m?.field?.find((x) => x.user_id === p.spoc_id);
                            const fallback = m?.field ? "0" : "—";
                            return [
                                num(p.totals.visits),
                                num(p.totals.unique_visits),
                                num(p.totals.new_visits),
                                v ? countWithShare(v.verified, share(v.verified, v.visited), num) : fallback,
                                v ? countWithShare(v.productive, share(v.productive, v.visited), num) : fallback,
                                num(p.snapshot.planned_visits_today),
                                num(p.outcome.kyc_submitted),
                            ];
                        }}
                    />
                    <span className="text-xs leading-relaxed text-ink-muted">
                        Of the visits marked visited: verified = with a shop photo and a location pin; productive = outcome Productive or
                        Commercials progressed. Each with its share.
                        {measures.error ? " These two columns could not be loaded." : ""}
                    </span>
                </DashCard>
            </div>

            {/* ID 86 — lead / owner / transfer clocks */}
            <ResponseTimeCard from={from} to={to} spocId={filters.spoc_id || undefined} />

            {/* Quotes */}
            <DashCard
                title="Quotes in progress"
                action={<span className="text-[13px] text-ink-muted">Quotes created in the period</span>}
            >
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                    {(
                        [
                            ["Quotes issued", d ? d.outcome.quotes_issued : null, "Leads with a first quote", "quotes_issued"],
                            ["Revised quotes", d ? d.outcome.quote_revisions : null, "Later versions of a quote", "quote_revisions"],
                            // ID 88 — where each lead's latest quote created in the period stands.
                            ["Waiting for approval", m?.quotes ? m.quotes.waiting_approval : null, "With the CEO, not yet released", "waiting_approval"],
                            ["Delivered, no answer", m?.quotes ? m.quotes.delivered_no_answer : null, "Sent to the dealer, no reply logged", "delivered_no_answer"],
                            ["Dealer said yes", m?.quotes ? m.quotes.dealer_yes : null, "Dealer approved the quote", "dealer_yes"],
                            ["Declined", m?.quotes ? m.quotes.dealer_declined : null, "Dealer declined the quote", "dealer_declined"],
                        ] as const
                    ).map(([label, value, sub, kind]) => (
                        <div key={label} className="flex flex-col gap-1.5 rounded-xl border border-border bg-[#fbfcfd] p-4">
                            <span className="text-[13px] font-semibold">{label}</span>
                            <span className="text-[26px] font-bold text-brand-navy tabular-nums">
                                {value == null ? "—" : <DrillNum value={value} onClick={() => openDrill(label, value, kind)} />}
                            </span>
                            <span className="text-[12.5px] text-ink-muted">{sub}</span>
                        </div>
                    ))}
                </div>
                <span className="text-xs text-ink-muted">
                    The last four boxes count each lead&apos;s latest quote created in the period
                    {m?.quotes
                        ? ` (${num(m.quotes.total)}): also ${num(m.quotes.approved_not_sent)} approved but not sent yet, ${num(m.quotes.refused_by_us)} refused by us, ${num(m.quotes.withdrawn)} withdrawn`
                        : ""}
                    . Quotes past their answer limit are on the &ldquo;Quotes with no answer&rdquo; tile.
                    {measures.error ? " These boxes could not be loaded." : ""}
                </span>
            </DashCard>

            {/* Accounts + lost */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <DashCard
                    title="Accounts by owner"
                    caption={<span className="text-[13px] text-ink-muted">Live dealer accounts each person manages, as of today</span>}
                    action={
                        unowned > 0 ? (
                            <CardLink href="/admin/accounts" primary>
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
                                            <span className="text-right">
                                                <DrillNum value={g.dealers} onClick={() => openAccounts(g.group, "accounts", null)} />
                                            </span>
                                            <span className="text-right">
                                                <DrillNum
                                                    value={(g.by_bucket.active ?? 0) + (g.by_bucket.cooling ?? 0)}
                                                    onClick={() => openAccounts(g.group, "ordering", ["active", "cooling"])}
                                                />
                                            </span>
                                            <span className={`text-right font-bold ${risk >= 8 ? "text-danger" : ""}`}>
                                                <DrillNum value={risk} onClick={() => openAccounts(g.group, "red + dormant", ["red", "dormant"])} />
                                            </span>
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
                                    <span className="text-right text-[13.5px] font-bold tabular-nums">
                                        <DrillNum value={l.n} onClick={() => openDrill(`Lost — ${l.reason.replace(/_/g, " ")}`, l.n, "lost_reason", { key: l.reason })} />
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    {/* ID 88 — the status each lead left when it moved to Lost (status history). */}
                    <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-3">
                        <span className={TABLE_HEAD}>Stage it was lost at</span>
                        {!m?.lost_stage ? (
                            <span className="text-xs text-ink-muted">{measures.isLoading ? "Loading…" : "Could not be loaded."}</span>
                        ) : m.lost_stage.length === 0 ? (
                            <span className="text-xs text-ink-muted">No leads were marked Lost in this period.</span>
                        ) : (
                            m.lost_stage.map((s) => (
                                <div key={s.stage} className="grid grid-cols-[minmax(0,190px)_minmax(0,1fr)_44px] items-center gap-3">
                                    <span className="truncate text-[13px] font-semibold">
                                        {LEAD_STATUS_LABEL[s.stage as LeadStatus] ?? (s.stage === "Unknown" ? "Not recorded" : s.stage.replace(/_/g, " "))}
                                    </span>
                                    <ProgressBar pct={(s.n / m.lost_stage![0].n) * 100} />
                                    <span className="text-right text-[13px] font-bold tabular-nums">
                                        <DrillNum
                                            value={s.n}
                                            onClick={() =>
                                                openDrill(
                                                    `Lost at — ${LEAD_STATUS_LABEL[s.stage as LeadStatus] ?? (s.stage === "Unknown" ? "Not recorded" : s.stage.replace(/_/g, " "))}`,
                                                    s.n,
                                                    "lost_stage",
                                                    { key: s.stage },
                                                )
                                            }
                                        />
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </DashCard>
            </div>
            {sdrill && <SalesDrillModal target={sdrill} onClose={() => setSdrill(null)} />}
        </div>
    );
}

/** A number that opens its rows; plain text when there is nothing behind it. */
function DrillNum({ value, onClick }: { value: number; onClick: () => void }) {
    if (!value) return <>{num(value)}</>;
    return (
        <button
            type="button"
            onClick={onClick}
            title="See the rows behind this number"
            className="cursor-pointer tabular-nums underline-offset-2 hover:text-brand-sky hover:underline"
        >
            {num(value)}
        </button>
    );
}

function PeopleTable({
    people,
    heads,
    row,
    loading,
    kinds,
    counts,
    onDrill,
    columnCsv,
}: {
    people: SalesSpocBlock[];
    heads: string[];
    row: (p: SalesSpocBlock) => string[];
    loading: boolean;
    /** Per column: the number it drills into (salesDrill.ts), or null (a rate, not a count). */
    kinds?: (DrillKind | null)[];
    /** Per column: the raw count behind the shown text — 0 makes the cell plain. */
    counts?: (p: SalesSpocBlock) => number[];
    onDrill?: (p: SalesSpocBlock, kind: DrillKind, label: string, n: number) => void;
    /** A column's CSV link for the people listed. */
    columnCsv?: (kind: DrillKind, people: SalesSpocBlock[]) => string;
}) {
    if (loading && people.length === 0) return <LoadingBlock />;
    if (people.length === 0) return <NotAvailable empty reason="No one in this team has activity for these filters." />;
    // Column count follows `heads` (inline, since a computed class name is not generated by Tailwind).
    const columns = { gridTemplateColumns: `minmax(0,1.4fr) repeat(${heads.length}, minmax(0,1fr))` };
    return (
        <div className="overflow-x-auto">
            <div style={{ minWidth: Math.max(520, 140 + heads.length * 90) }}>
                <div className={`grid gap-2.5 border-b border-border pb-2 ${TABLE_HEAD}`} style={columns}>
                    <span>Person</span>
                    {heads.map((h, i) => {
                        const kind = kinds?.[i];
                        return (
                            <span key={h} className="flex flex-col items-end gap-0.5 text-right">
                                {h}
                                {kind && columnCsv && (
                                    <a
                                        href={columnCsv(kind, people)}
                                        download
                                        title={`Download every row behind "${h}" for the people shown (CSV)`}
                                        className="inline-flex items-center gap-0.5 text-[10px] font-semibold normal-case tracking-normal text-brand-sky hover:underline"
                                    >
                                        <Download className="h-3 w-3" aria-hidden /> CSV
                                    </a>
                                )}
                            </span>
                        );
                    })}
                </div>
                {people.map((p) => (
                    <div
                        key={p.spoc_id}
                        className="grid min-h-[42px] items-center gap-2.5 border-b border-[#f1f4f7] text-[13.5px] tabular-nums"
                        style={columns}
                    >
                        <span className="truncate font-semibold">{p.name ?? "Unnamed"}</span>
                        {(() => {
                            const n = counts?.(p);
                            return row(p).map((v, i) => {
                                const kind = kinds?.[i];
                                const c = n?.[i] ?? 0;
                                return (
                                    <span key={i} className="text-right">
                                        {kind && onDrill && c > 0 ? (
                                            <button
                                                type="button"
                                                onClick={() => onDrill(p, kind, heads[i].toLowerCase(), c)}
                                                title="See the rows behind this number"
                                                className="cursor-pointer tabular-nums underline-offset-2 hover:text-brand-sky hover:underline"
                                            >
                                                {v}
                                            </button>
                                        ) : (
                                            v
                                        )}
                                    </span>
                                );
                            });
                        })()}
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * ID 88 — "Stuck over 7 days": open leads per owner and stage that have sat in
 * that stage longer than STUCK_DAYS (salesHeadMeasures.ts stuck()), as of today.
 * Shaded within each stage column, like the activity view.
 */
function StuckGrid({ rows, loading }: { rows: SalesHeadMeasures["stuck"]; loading: boolean }) {
    if (!rows) return loading ? <LoadingBlock /> : <NotAvailable reason="Time in stage could not be loaded." />;
    const stages = OPEN_STATUSES.filter((s) => rows.some((r) => (r.by_stage[s] ?? 0) > 0));
    if (rows.length === 0 || stages.length === 0) {
        return <NotAvailable empty reason={`No open lead has sat in one stage for more than ${STUCK_DAYS} days.`} />;
    }
    const max = Object.fromEntries(stages.map((s) => [s, Math.max(0, ...rows.map((r) => r.by_stage[s] ?? 0))]));
    const columns = { gridTemplateColumns: `150px repeat(${stages.length + 1}, minmax(0,1fr))` };
    return (
        <div className="overflow-x-auto">
            <div className="flex flex-col gap-1" style={{ minWidth: Math.max(560, 150 + (stages.length + 1) * 72) }}>
                <div className={`grid gap-1 ${TABLE_HEAD} !tracking-[0.04em]`} style={columns}>
                    <span />
                    {stages.map((s) => (
                        <span key={s} className="text-center leading-snug">
                            {LEAD_STATUS_LABEL[s]}
                        </span>
                    ))}
                    <span className="text-center leading-snug">Total</span>
                </div>
                {rows.map((r) => (
                    <div key={r.owner_id} className="grid items-center gap-1" style={columns}>
                        <span className="truncate text-[13px] font-semibold text-ink">{r.owner}</span>
                        {stages.map((s) => (
                            <HeatCell key={s} value={r.by_stage[s] ?? 0} max={max[s]} />
                        ))}
                        <span className="text-center text-[13px] font-bold tabular-nums text-ink">{num(r.total)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
