// Daily Sales email v1.1 — Block A "Company" (tracker ID 9, handover P4-6,
// decided 26 / 29 Sep 2026; layout: canvas "Daily Sales email", EmailBlockA).
//
// 22 rows in five groups (Intake, Effort, Commercials, Outcome, Discipline),
// seven columns: Yesterday · Last 7 days · MTD · MTD target · % of target ·
// same period last month · Δ MTD. A row the CRM cannot measure yet is shown
// greyed as "Not measured yet" rather than dropped.
//
// Every figure the Sales dashboard also shows comes from the SAME builder
// (buildSalesDashboard) with the metric definitions of ID 59
// (src/lib/reports/metricDefinitions.ts), so Block A matches the dashboard for
// the same day. The rest are small direct queries, each fail-tolerant: a
// query that fails (e.g. a DB without E-314) turns its row "Not measured yet".
//
// Company MTD target = Σ pushed / accepted targets of the month, pro-rated by
// working days elapsed (Mon–Sat minus holidays, as the targets register does);
// "Targets set for N of M people" says how complete that sum is.

import { sql } from "drizzle-orm";
import type { SalesDashboard } from "@/lib/admin/salesDashboardTypes";
import { engagedCallCount, wasHotAt } from "@/lib/reports/metricDefinitions";
import { monthEnd, workingDaysBetween } from "@/lib/targets/rules";
import { scrapKgSourced } from "@/lib/buyback/scrapKgSourced";
import { istRangeNaive, istRangeTz } from "./window";
import { RAG_AMBER_MIN } from "./rag";

export const NOT_MEASURED = "Not measured yet";

export type Period = { from: string; to: string };
export type Periods = { yesterday: Period; last7: Period; mtd: Period; lastMonth: Period };

/** Value per period; null = not measurable. */
export type RowValues = { y: number | null; d7: number | null; mtd: number | null; lm: number | null };

export type BlockARow = {
    group: "INTAKE" | "EFFORT" | "COMMERCIALS" | "OUTCOME" | "DISCIPLINE";
    label: string;
    kind: "count" | "money" | "percent";
    values: RowValues;
    /** Company MTD target, or null when none is set. */
    target: number | null;
    /**
     * The MTD figure measured the way the TARGET is, when that differs from the
     * figure shown. "Dealers visited" shows distinct dealers company-wide, but
     * its target is the sum of personal targets, each counting that person's
     * own dealers — a dealer two people visited is one dealer here and one
     * toward each of their targets. % of target uses this; the cell does not.
     */
    targetBasisMtd?: number | null;
};

/** % of target for a row, on the target's own basis. */
export function rowPctOfTarget(r: BlockARow): number | null {
    return pctOfTarget(r.targetBasisMtd ?? r.values.mtd, r.target);
}

// ─────────────────────────────── pure formatting ────────────────────────────

export function fmtValue(v: number | null, kind: BlockARow["kind"]): string {
    if (v == null) return NOT_MEASURED;
    if (kind === "money") {
        if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
        if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
        return `₹${Math.round(v).toLocaleString("en-IN")}`;
    }
    if (kind === "percent") return `${Math.round(v)}%`;
    return Math.round(v).toLocaleString("en-IN");
}

export function pctOfTarget(mtd: number | null, target: number | null): number | null {
    if (mtd == null || target == null || target <= 0) return null;
    return Math.round((mtd / target) * 100);
}

export function deltaPct(mtd: number | null, lm: number | null): number | null {
    if (mtd == null || lm == null || lm === 0) return null;
    return Math.round(((mtd - lm) / lm) * 100);
}

export const BLOCK_A_COLUMNS = [
    "Metric",
    "Yesterday",
    "Last 7 days",
    "MTD",
    "MTD target",
    "% of target",
    "Same period last month",
    "Δ MTD",
];

/** Index of "% of target" in BLOCK_A_COLUMNS — coloured red / amber / green (rag.ts). */
export const BLOCK_A_PCT_COLUMN = BLOCK_A_COLUMNS.indexOf("% of target");

/** Rows for the email table: a group header row, then its metrics. */
export function blockATableRows(rows: BlockARow[]): Array<Array<string | number>> {
    const out: Array<Array<string | number>> = [];
    let group: string | null = null;
    for (const r of rows) {
        if (r.group !== group) {
            group = r.group;
            out.push([group, "", "", "", "", "", "", ""]);
        }
        const measured = r.values.mtd != null || r.values.y != null;
        if (!measured) {
            out.push([r.label, NOT_MEASURED, "", "", "", "", "", ""]);
            continue;
        }
        const p = rowPctOfTarget(r);
        const d = deltaPct(r.values.mtd, r.values.lm);
        out.push([
            r.label,
            fmtValue(r.values.y, r.kind),
            fmtValue(r.values.d7, r.kind),
            fmtValue(r.values.mtd, r.kind),
            r.target == null ? "—" : fmtValue(r.target, r.kind),
            p == null ? "—" : `${p}%`,
            r.values.lm == null ? "n/t" : fmtValue(r.values.lm, r.kind),
            d == null ? "—" : `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)}%`,
        ]);
    }
    return out;
}

/** Label of the line under Revenue (tracker ID 69 / handover P1-6). */
export const UNMATCHED_REVENUE_LABEL = "Revenue not matched to a dealer";

/**
 * Tracker ID 69 / P1-6: "₹X not matched to a dealer", right under the company
 * Revenue row. Revenue (salesDashboard queryOutcome) counts only invoices
 * matched to a dealer account or lead; this line is the rest of the same
 * window — revenueSummary().unlinked_total — so the two add up to everything
 * invoiced. Hidden when it is 0 (or unmeasured) in every period. Pure.
 */
export function withUnmatchedRevenue(rows: BlockARow[], values: RowValues | null | undefined): BlockARow[] {
    if (!values) return rows;
    const any = [values.y, values.d7, values.mtd, values.lm].some((v) => v != null && v > 0);
    if (!any) return rows;
    const at = rows.findIndex((r) => r.label === "Revenue");
    const line: BlockARow = { group: "OUTCOME", label: UNMATCHED_REVENUE_LABEL, kind: "money", values, target: null };
    if (at < 0) return [...rows, line];
    return [...rows.slice(0, at + 1), line, ...rows.slice(at + 1)];
}

/** The one-line headline. */
export function blockAHeadline(rows: BlockARow[]): string {
    const get = (label: string) => rows.find((r) => r.label === label);
    const y = (label: string) => get(label)?.values.y;
    const dealers = (n: number) => `${n} dealer${n === 1 ? "" : "s"}`;
    const parts = [
        `${dealers(y("Converted") ?? 0)} converted`,
        `${fmtValue(y("Revenue") ?? 0, "money")} revenue`,
        `${dealers(y("Dealers visited") ?? 0)} visited`,
        `${dealers(y("Dealers called") ?? 0)} called`,
    ];
    const withTarget = rows
        .map((r) => ({ r, p: rowPctOfTarget(r) }))
        .filter((x) => x.p != null) as Array<{ r: BlockARow; p: number }>;
    const behind = withTarget.filter((x) => x.p < RAG_AMBER_MIN).map((x) => `${x.r.label.toLowerCase()} at ${x.p}%`);
    const tail = withTarget.length
        ? behind.length
            ? ` Month to date behind target: ${behind.join(", ")}.`
            : ` Month to date: every targeted metric at ${RAG_AMBER_MIN}% or more.`
        : "";
    return `Yesterday: ${parts.join(" · ")}.${tail}`;
}

// ─────────────────────────────── queries ────────────────────────────────────

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

async function count(db: Exec, q: ReturnType<typeof sql>): Promise<number | null> {
    try {
        const r = (await db.execute(q)) as Array<{ n: string | number | null }>;
        // A query that answers NULL is saying "not measurable in this period"
        // (engagedCallCount) — kept as null, shown as "Not measured yet".
        if (r[0] && r[0].n === null) return null;
        return Number(r[0]?.n ?? 0);
    } catch (e) {
        console.warn("[salesDailyBlockA] metric not measured:", e instanceof Error ? e.message : e);
        return null;
    }
}

/** [from, to] inclusive IST days on a timestamptz column (window.ts). */
const inRange = (col: ReturnType<typeof sql>, p: Period) => istRangeTz(col, p.from, p.to);

function dayAfter(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

/** Kg sourced (complete_pickup) per period — the CEO control tower's figure. */
async function scrapKgPerPeriod(db: Exec, periods: Periods): Promise<RowValues> {
    const one = async (p: Period): Promise<number | null> => {
        try {
            return await scrapKgSourced(p.from, dayAfter(p.to), db);
        } catch (e) {
            console.warn("[salesDailyBlockA] scrap kg not measured:", e instanceof Error ? e.message : e);
            return null;
        }
    };
    const [y, d7, mtd, lm] = await Promise.all([
        one(periods.yesterday),
        one(periods.last7),
        one(periods.mtd),
        one(periods.lastMonth),
    ]);
    return { y, d7, mtd, lm };
}

async function perPeriod(db: Exec, periods: Periods, make: (p: Period) => ReturnType<typeof sql>): Promise<RowValues> {
    const [y, d7, mtd, lm] = await Promise.all([
        count(db, make(periods.yesterday)),
        count(db, make(periods.last7)),
        count(db, make(periods.mtd)),
        count(db, make(periods.lastMonth)),
    ]);
    return { y, d7, mtd, lm };
}

/** Company MTD targets per metric, pro-rated, and how many people have one. */
async function companyTargets(db: Exec, monthFirst: string, upTo: string) {
    try {
        const hol = (await db.execute(sql`
            SELECT holiday_date::text AS d FROM holiday_calendar
             WHERE is_active IS NOT FALSE AND holiday_date BETWEEN ${monthFirst}::date AND ${monthEnd(monthFirst)}::date
        `)) as Array<{ d: string }>;
        const set = new Set(hol.map((h) => h.d));
        const total = workingDaysBetween(monthFirst, monthEnd(monthFirst), set);
        const elapsed = workingDaysBetween(monthFirst, upTo, set);
        const rows = (await db.execute(sql`
            SELECT user_id::text AS user_id, metric, SUM(ceo_target + admin_addon)::float8 AS monthly
              FROM sales_targets
             WHERE month = ${monthFirst}::date AND status IN ('pushed', 'accepted')
             GROUP BY user_id, metric
        `)) as Array<{ user_id: string; metric: string; monthly: number }>;
        const [who] = (await db.execute(sql`
            SELECT (SELECT COUNT(DISTINCT user_id) FROM sales_targets
                     WHERE month = ${monthFirst}::date AND status IN ('pushed', 'accepted'))::int AS with_target,
                   (SELECT COUNT(*) FROM users
                     WHERE is_active = TRUE AND role IN ('asm', 'inside_sales_rep'))::int AS reps
        `)) as Array<{ with_target: number; reps: number }>;
        // Company = Σ per person, so Blocks B / C and Block A pro-rate alike.
        const map = new Map<string, number>();
        const perUser = new Map<string, Map<string, number>>();
        for (const r of rows) {
            const monthly = Number(r.monthly);
            // calls_per_day is a per-person daily figure: × working days elapsed.
            const mtd = r.metric === "calls_per_day" ? monthly * elapsed : total > 0 ? (monthly * elapsed) / total : 0;
            map.set(r.metric, (map.get(r.metric) ?? 0) + mtd);
            const u = perUser.get(r.user_id) ?? new Map<string, number>();
            u.set(r.metric, (u.get(r.metric) ?? 0) + mtd);
            perUser.set(r.user_id, u);
        }
        return { map, perUser, withTarget: who?.with_target ?? 0, reps: who?.reps ?? 0, elapsed, total };
    } catch {
        return {
            map: new Map<string, number>(),
            perUser: new Map<string, Map<string, number>>(),
            withTarget: 0,
            reps: 0,
            elapsed: 0,
            total: 0,
        };
    }
}

export type BlockA = {
    rows: BlockARow[];
    targetsNote: string;
    /** Per-person MTD targets (user id → metric → target), for Blocks B / C. */
    userTargets: Map<string, Map<string, number>>;
};

export async function buildBlockA(
    db: Exec,
    periods: Periods,
    dash: { yesterday: SalesDashboard; last7: SalesDashboard; mtd: SalesDashboard; lastMonth: SalesDashboard },
    /** Invoiced but matched to no dealer, per period (ID 69); null = not measured. */
    unmatchedRevenue?: RowValues | null,
): Promise<BlockA> {
    const t = await companyTargets(db, periods.mtd.from, periods.mtd.to);
    // E-314 absent → the Sales-ready row is "Not measured yet", not a false 0.
    const hasSalesReady = await count(
        db,
        sql`SELECT COUNT(*) AS n FROM information_schema.columns
             WHERE table_name = 'dealer_leads' AND column_name = 'sales_ready_at'`,
    );
    const fromDash = (pick: (d: SalesDashboard) => number): RowValues => ({
        y: pick(dash.yesterday),
        d7: pick(dash.last7),
        mtd: pick(dash.mtd),
        lm: pick(dash.lastMonth),
    });
    const NONE: RowValues = { y: null, d7: null, mtd: null, lm: null };

    const [leadsIn, salesReady, assigned, engaged, hotToField, delivered, dealerApproved, won, kycDisbursed, scrapDeals, scrapKg] =
        await Promise.all([
            // dealer_leads.created_at is a NAIVE timestamp holding UTC wall-clock.
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(*) AS n FROM dealer_leads dl WHERE ${istRangeNaive(sql`dl.created_at`, p.from, p.to)}`,
            ),
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(*) AS n FROM dealer_leads dl WHERE ${inRange(sql`(to_jsonb(dl) ->> 'sales_ready_at')::timestamptz`, p)}`,
            ),
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(DISTINCT t.dealer_lead_id) AS n FROM lead_touchpoints t
                            WHERE t.from_owner_id IS NULL AND t.to_owner_id IS NOT NULL AND ${inRange(sql`t.performed_at`, p)}
                              AND NOT EXISTS (SELECT 1 FROM lead_touchpoints e
                                               WHERE e.dealer_lead_id = t.dealer_lead_id AND e.to_owner_id IS NOT NULL
                                                 AND e.performed_at < t.performed_at)`,
            ),
            // ID 59: NULL — "Not measured yet" — for a period in which no call
            // carries a measured duration, never a 0 that reads as "no real
            // conversations".
            perPeriod(db, periods, (p) => sql`SELECT ${engagedCallCount()} AS n FROM lead_touchpoints t WHERE ${inRange(sql`t.performed_at`, p)}`),
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(*) AS n FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                            WHERE t.touchpoint_type = 'asm_transfer' AND ${inRange(sql`t.performed_at`, p)}
                              AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}`,
            ),
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(*) AS n FROM lead_touchpoints t WHERE t.touchpoint_type = 'quote_dispatched' AND ${inRange(sql`t.performed_at`, p)}`,
            ),
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(*) AS n FROM dealer_lead_commercials c WHERE c.dealer_decision = 'approved' AND ${inRange(sql`c.dealer_decision_at`, p)}`,
            ),
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(DISTINCT h.dealer_lead_id) AS n FROM dealer_lead_status_history h
                            WHERE h.to_status = 'Won' AND ${inRange(sql`h.changed_at`, p)}`,
            ),
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(*) AS n FROM loan_sanctions s WHERE ${inRange(sql`s.disbursed_at`, p)}`,
            ),
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(DISTINCT al.request_id) AS n FROM buyback_activity_log al
                            WHERE al.action = 'dealer_accept' AND ${inRange(sql`al.created_at`, p)}`,
            ),
            scrapKgPerPeriod(db, periods),
        ]);

    const tgt = (metric: string) => (t.map.has(metric) ? Math.round(t.map.get(metric)!) : null);

    // "Dealers visited" against its target: each person's distinct dealers,
    // summed — what the personal targets (targets/service.ts) add up from.
    const visitedCompany = dash.mtd.totals.unique_visits;
    const visitedPerPerson = (dash.mtd.per_spoc ?? []).reduce((sum, b) => sum + b.totals.unique_visits, 0);
    const visitedDiffers = (dash.mtd.per_spoc ?? []).length > 0 && visitedPerPerson !== visitedCompany;

    const rows: BlockARow[] = [
        { group: "INTAKE", label: "Leads in", kind: "count", values: leadsIn, target: null },
        { group: "INTAKE", label: "Became sales-ready", kind: "count", values: hasSalesReady ? salesReady : NONE, target: null },
        { group: "INTAKE", label: "Assigned", kind: "count", values: assigned, target: null },
        { group: "EFFORT", label: "Calls made", kind: "count", values: fromDash((d) => d.totals.calls), target: tgt("calls_per_day") },
        { group: "EFFORT", label: "Dealers called", kind: "count", values: fromDash((d) => d.totals.dealers_called), target: null },
        { group: "EFFORT", label: "Engaged calls", kind: "count", values: engaged, target: null },
        { group: "EFFORT", label: "Hot handed to field", kind: "count", values: hotToField, target: tgt("hot_to_ground") },
        {
            group: "EFFORT",
            label: "Dealers visited",
            kind: "count",
            values: fromDash((d) => d.totals.unique_visits),
            target: tgt("dealer_visits"),
            targetBasisMtd: visitedDiffers ? visitedPerPerson : null,
        },
        { group: "EFFORT", label: "New dealers visited", kind: "count", values: fromDash((d) => d.totals.new_visits), target: tgt("new_dealer_visits") },
        { group: "COMMERCIALS", label: "Quotes created", kind: "count", values: fromDash((d) => d.outcome.quotes_issued), target: null },
        { group: "COMMERCIALS", label: "Quotes delivered", kind: "count", values: delivered, target: null },
        { group: "COMMERCIALS", label: "Dealer approved", kind: "count", values: dealerApproved, target: null },
        { group: "COMMERCIALS", label: "Marked Won", kind: "count", values: won, target: null },
        { group: "OUTCOME", label: "Converted", kind: "count", values: fromDash((d) => d.totals.converted), target: null },
        { group: "OUTCOME", label: "Batteries sold", kind: "count", values: fromDash((d) => d.outcome.batteries_to_dealers), target: tgt("batteries_sold") },
        { group: "OUTCOME", label: "Revenue", kind: "money", values: fromDash((d) => d.outcome.revenue), target: tgt("revenue") },
        { group: "OUTCOME", label: "KYC submitted", kind: "count", values: fromDash((d) => d.outcome.kyc_submitted), target: tgt("kyc_submitted") },
        { group: "OUTCOME", label: "KYC disbursed", kind: "count", values: kycDisbursed, target: tgt("kyc_disbursed") },
        { group: "OUTCOME", label: "Scrap deals", kind: "count", values: scrapDeals, target: tgt("scrap_deals") },
        // Kg over requests that completed pickup — scrapKgSourced(), the CEO
        // control tower's buyback tile. The two discipline rows wait for the
        // clocks (handover P3).
        { group: "OUTCOME", label: "Scrap sourced (kg)", kind: "count", values: scrapKg, target: null },
        { group: "DISCIPLINE", label: "First attempt within limit", kind: "percent", values: NONE, target: null },
        { group: "DISCIPLINE", label: "Time limits missed", kind: "count", values: NONE, target: null },
    ];

    const visitsNote =
        visitedDiffers && t.map.has("dealer_visits")
            ? ` Dealers visited: % of target counts each person's own dealers (${visitedPerPerson} in total), as their targets do; the figure shown counts a dealer once however many people visited.`
            : "";
    const targetsNote =
        t.total > 0
            ? `Month to date is ${t.elapsed} of ${t.total} working days, so targets are ${t.elapsed}/${t.total} of the monthly target. Targets set for ${t.withTarget} of ${t.reps} people.${visitsNote}`
            : "No targets are set for this month.";
    return { rows: withUnmatchedRevenue(rows, unmatchedRevenue), targetsNote, userTargets: t.perUser };
}
