// Daily Sales email v1.1 — Block A "Company" (tracker ID 9, handover P4-6,
// decided 26 / 29 Sep 2026; layout: canvas "Daily Sales email", EmailBlockA).
//
// Rows in five groups (Intake, Effort, Commercials, Outcome, Discipline),
// six columns: Yesterday · Day before · Same day last week · MTD · MTD target ·
// % of target (ID 188, the Sales Head's format: the last working day against
// the working day before it and the same weekday a week earlier, then the
// month). ID 188 (30 Oct): Last 7 days, Same period last month and Δ MTD,
// removed on 22 Oct without anyone asking, are back beside them. A row the
// CRM cannot measure yet is shown greyed as "Not measured yet" rather than
// dropped.
//
// Every figure the Sales dashboard also shows comes from the SAME builder
// (buildSalesDashboard) with the metric definitions of ID 59
// (src/lib/reports/metricDefinitions.ts), so Block A matches the dashboard for
// the same day. The rest are small direct queries, each fail-tolerant: a
// query that fails (e.g. a DB without E-314) turns its row "Not measured yet".
//
// Company MTD target = Σ pushed / accepted targets of the month, pro-rated by
// working days elapsed (Mon–Sat minus holidays, as the targets register does);
// "Targets sent to N of M people" says how complete that sum is (ID 157:
// pushed or accepted; drafts and pending approval stay out).

import { sql } from "drizzle-orm";
import type { SalesDashboard } from "@/lib/admin/salesDashboardTypes";
import { batteryReading, type BatteryReading } from "@/lib/admin/batteryReading";
import { engagedCall, firstMoveToField, transferCredit, wasHotAt } from "@/lib/reports/metricDefinitions";
import { monthEnd, workingDaysBetween } from "@/lib/targets/rules";
import { finalTargetSql } from "@/lib/targets/sql";
import { scrapKgSourced } from "@/lib/buyback/scrapKgSourced";
import { clockStats, limitsPassed } from "@/lib/leads/clocks";
import { istRangeNaive, istRangeTz } from "./window";
import { RAG_AMBER_MIN } from "./rag";
import { repeatVisits } from "@/lib/visits/freshRepeat";

export const NOT_MEASURED = "Not measured yet";

export type Period = { from: string; to: string };
/** ID 188 — the six windows Block A is counted over (salesDailyPeriods). */
export type Periods = {
    yesterday: Period;
    dayBefore: Period;
    sameDayLastWeek: Period;
    last7: Period;
    mtd: Period;
    lastMonth: Period;
};

/**
 * Value per period (y = Yesterday, prev = Day before, wk = Same day last week,
 * d7 = Last 7 days, lm = Same period last month); null = not measurable.
 */
export type RowValues = {
    y: number | null;
    prev: number | null;
    wk: number | null;
    d7: number | null;
    mtd: number | null;
    lm: number | null;
};

export type BlockARow = {
    group: "INTAKE" | "EFFORT" | "COMMERCIALS" | "OUTCOME" | "DISCIPLINE";
    label: string;
    kind: "count" | "money" | "percent" | "hours";
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
    /**
     * IDs 70 / 147 — "Batteries sold" only: how much of each period's figure is
     * known (batteryReading, the CEO tile's rule). An invoice with no item
     * lines read adds 0 whatever it sold, so the cell reads "—" when no
     * invoice in the period has lines and "N+" when only some do.
     */
    readings?: Record<keyof RowValues, BatteryReading>;
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
    if (kind === "hours") return `${v.toFixed(1)} h`;
    return Math.round(v).toLocaleString("en-IN");
}

export function pctOfTarget(mtd: number | null, target: number | null): number | null {
    if (mtd == null || target == null || target <= 0) return null;
    return Math.round((mtd / target) * 100);
}

/** MTD against the same span last month, in whole %; null when either is missing or last month is 0. */
export function deltaPct(mtd: number | null, lm: number | null): number | null {
    if (mtd == null || lm == null || lm === 0) return null;
    return Math.round(((mtd - lm) / lm) * 100);
}

export const BLOCK_A_COLUMNS = [
    "Metric",
    "Yesterday",
    "Day before",
    "Same day last week",
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
            out.push([group, ...BLOCK_A_COLUMNS.slice(1).map(() => "")]);
        }
        const measured = r.values.mtd != null || r.values.y != null;
        if (!measured) {
            out.push([r.label, NOT_MEASURED, ...BLOCK_A_COLUMNS.slice(2).map(() => "")]);
            continue;
        }
        // "—" when a period's figure is unknown (no item lines read), so its
        // % of target and Δ are not worked out from a false 0 either.
        const unknown = (k: keyof RowValues) => r.readings?.[k].state === "unknown";
        const cell = (k: keyof RowValues) =>
            unknown(k) ? "—" : `${fmtValue(r.values[k], r.kind)}${r.readings?.[k].state === "partial" ? "+" : ""}`;
        const p = unknown("mtd") ? null : rowPctOfTarget(r);
        const d = unknown("mtd") || unknown("lm") ? null : deltaPct(r.values.mtd, r.values.lm);
        // A comparison period the CRM did not track yet reads "n/t", not a false 0.
        const past = (k: "prev" | "wk" | "d7" | "lm") => (r.values[k] == null ? "n/t" : cell(k));
        out.push([
            r.label,
            cell("y"),
            past("prev"),
            past("wk"),
            past("d7"),
            cell("mtd"),
            r.target == null ? "—" : fmtValue(r.target, r.kind),
            p == null ? "—" : `${p}%`,
            past("lm"),
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
    const any = [values.y, values.prev, values.wk, values.d7, values.mtd, values.lm].some((v) => v != null && v > 0);
    if (!any) return rows;
    const at = rows.findIndex((r) => r.label === "Revenue");
    const line: BlockARow = { group: "OUTCOME", label: UNMATCHED_REVENUE_LABEL, kind: "money", values, target: null };
    if (at < 0) return [...rows, line];
    return [...rows.slice(0, at + 1), line, ...rows.slice(at + 1)];
}

/** The one-line headline. */
export function blockAHeadline(rows: BlockARow[]): string {
    return blockAHeadlineParts(rows).join(" ");
}

/**
 * The headline as the business template lays it out: a "Yesterday: …"
 * sentence, then a "Month to date: …" one when any metric has a target. The
 * email bolds each part's text up to the first colon.
 */
export function blockAHeadlineParts(rows: BlockARow[]): string[] {
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
    const out = [`Yesterday: ${parts.join(" · ")}.`];
    if (withTarget.length) {
        out.push(
            behind.length
                ? `Month to date: behind target on ${behind.join(", ")}.`
                : `Month to date: every targeted metric at ${RAG_AMBER_MIN}% or more.`,
        );
    }
    return out;
}

/**
 * The one line under each metric name in the email (business template,
 * "Daily Sales email · Block A"). Worded for what each query actually counts,
 * so a reader can tell what a number is without asking.
 */
export const BLOCK_A_ROW_NOTES: Record<string, string> = {
    "Leads in": "Every new lead, whatever the source (bulk imports included)",
    "Became sales-ready": "AI-qualified, picked up in NeoDove, rep-created, claimed or assigned",
    Assigned: "Got a first owner",
    "Calls made": "Inside sales and NeoDove, AI calls excluded",
    "Dealers called": "Unique dealers",
    "Engaged calls": "Connected calls, each counted once",
    "Hot handed to field": "Hot when transferred to an ASM",
    "Dealers visited": "Unique dealers",
    Visits: "Completed visits; Fresh + Repeat",
    "Fresh visits": "The person's first visit to that dealer",
    "Repeat visits": "The person had visited that dealer before",
    "New dealers visited": "Of which new to iTarang: the dealer's first-ever visit",
    "Quotes created": "First quote per lead",
    "Quotes delivered": "Reached the dealer on WhatsApp or email",
    "Dealer approved": "Dealer said yes to the quote",
    "Marked Won": "Rep marked won; onboarding started",
    Converted: "Admin approved; dealer live",
    "Batteries sold": "Invoices matched to a dealer",
    Revenue: "Invoices matched to a dealer",
    "Revenue not matched to a dealer": "Invoiced, but no dealer matched yet",
    "First attempt within limit": "New owners who called or visited in time",
    "Time limits missed": "Any limit, all owners",
    "Hours to first attempt": "Median, working hours, new owners",
    "Hours to first attempt (slowest 1 in 10)": "Working hours, new owners",
};

/** One note per row of blockATableRows(rows) — null on group header rows. */
export function blockARowNotes(rows: BlockARow[]): Array<string | null> {
    const out: Array<string | null> = [];
    let group: string | null = null;
    for (const r of rows) {
        if (r.group !== group) {
            group = r.group;
            out.push(null);
        }
        out.push(readingNote(BLOCK_A_ROW_NOTES[r.label] ?? null, r.readings));
    }
    return out;
}

/**
 * The CEO "Batteries to dealers" tile's wording, for the month-to-date figure,
 * after the row's own note: "At least — x of y invoices have item lines", or
 * "No item lines read on the y invoices" when none has. Pure.
 */
export function readingNote(base: string | null, readings: BlockARow["readings"]): string | null {
    const m = readings?.mtd;
    if (!m || m.state === "complete") return base;
    const n = (v: number | null) => (v ?? 0).toLocaleString("en-IN");
    const line =
        m.state === "unknown"
            ? `No item lines read on the ${n(m.invoices)} invoices month to date`
            : `At least — ${n(m.with_lines)} of ${n(m.invoices)} invoices have item lines (month to date)`;
    return base ? `${base} · ${line}` : line;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A span as the template names it: "1–4 Sep" (or "1 Sep" for one day). Once
 * the "same period last month" header; since ID 188 the intro's MTD range.
 */
export function lastMonthColumnLabel(p: Period): string {
    const [, m, d1] = p.from.split("-").map(Number);
    const d2 = Number(p.to.slice(8, 10));
    const mon = MONTHS[m - 1] ?? "";
    return d1 === d2 ? `${d1} ${mon}` : `${d1}–${d2} ${mon}`;
}

// ─────────────────────────────── queries ────────────────────────────────────

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

async function count(db: Exec, q: ReturnType<typeof sql>): Promise<number | null> {
    try {
        const r = (await db.execute(q)) as Array<{ n: string | number | null }>;
        // A query that answers NULL is saying "not measurable in this period"
        // — kept as null, shown as "Not measured yet".
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
    const [y, prev, wk, d7, mtd, lm] = await Promise.all([
        one(periods.yesterday),
        one(periods.dayBefore),
        one(periods.sameDayLastWeek),
        one(periods.last7),
        one(periods.mtd),
        one(periods.lastMonth),
    ]);
    return { y, prev, wk, d7, mtd, lm };
}

/**
 * ID 86 — the owner clock and limit-passed figures per period (lead_clocks,
 * E-337, rebuilt hourly). All null when the clocks are not on this database,
 * so the rows keep reading "Not measured yet".
 */
async function clockRows(periods: Periods): Promise<{ inLimit: RowValues; missed: RowValues; median: RowValues; p90: RowValues }> {
    const ps = [periods.yesterday, periods.dayBefore, periods.sameDayLastWeek, periods.last7, periods.mtd, periods.lastMonth];
    // Never throws: a clock read failing must not cost the rest of the email.
    const [stats, missed] = await Promise.all([
        Promise.all(ps.map((p) => clockStats("owner", p.from, p.to))),
        Promise.all(ps.map((p) => limitsPassed(p.from, p.to))),
    ]).catch((e) => {
        console.warn("[sales-daily] lead clocks unavailable:", e instanceof Error ? e.message : e);
        return [ps.map(() => null), ps.map(() => null)] as const;
    });
    const row = (pick: (i: number) => number | null): RowValues => ({
        y: pick(0),
        prev: pick(1),
        wk: pick(2),
        d7: pick(3),
        mtd: pick(4),
        lm: pick(5),
    });
    return {
        inLimit: row((i) => stats[i]?.pct_in_limit ?? null),
        missed: row((i) => missed[i]),
        median: row((i) => stats[i]?.attempt_median_h ?? null),
        p90: row((i) => stats[i]?.attempt_p90_h ?? null),
    };
}

async function perPeriod(db: Exec, periods: Periods, make: (p: Period) => ReturnType<typeof sql>): Promise<RowValues> {
    const [y, prev, wk, d7, mtd, lm] = await Promise.all([
        count(db, make(periods.yesterday)),
        count(db, make(periods.dayBefore)),
        count(db, make(periods.sameDayLastWeek)),
        count(db, make(periods.last7)),
        count(db, make(periods.mtd)),
        count(db, make(periods.lastMonth)),
    ]);
    return { y, prev, wk, d7, mtd, lm };
}

/** Company MTD targets per metric, pro-rated, and how many people have one. */
export async function companyTargets(db: Exec, monthFirst: string, upTo: string) {
    try {
        // The one office calendar (holidays + office hours) — loadOfficeCalendar,
        // not a private holiday_calendar read.
        const { loadOfficeCalendar } = await import("@/lib/calendar/holidays");
        const { holidays: set, hours } = await loadOfficeCalendar();
        const total = workingDaysBetween(monthFirst, monthEnd(monthFirst), set, hours);
        const elapsed = workingDaysBetween(monthFirst, upTo, set, hours);
        const rows = (await db.execute(sql`
            SELECT user_id::text AS user_id, metric, SUM(${finalTargetSql(sql`sales_targets`)})::float8 AS monthly
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
    /** Working days of the month elapsed / in total (Mon–Sat minus holidays). */
    workingDays: { elapsed: number; total: number };
    /** Per-person MTD targets (user id → metric → target), for Blocks B / C. */
    userTargets: Map<string, Map<string, number>>;
};

export async function buildBlockA(
    db: Exec,
    periods: Periods,
    dash: Record<keyof Periods, SalesDashboard>,
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
        prev: pick(dash.dayBefore),
        wk: pick(dash.sameDayLastWeek),
        d7: pick(dash.last7),
        mtd: pick(dash.mtd),
        lm: pick(dash.lastMonth),
    });
    const NONE: RowValues = { y: null, prev: null, wk: null, d7: null, mtd: null, lm: null };
    const clocksPending = clockRows(periods);

    const [leadsIn, salesReady, assigned, engaged, hotToField, delivered, dealerApproved, won, kycDisbursed, scrapDeals, scrapKg] =
        await Promise.all([
            // dealer_leads.created_at is a NAIVE timestamp holding UTC wall-clock.
            // Same scope as the /leads list (is_active IS NOT FALSE), so Leads in
            // equals the Leads download for the same dates (ID 153: every source).
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(*) AS n FROM dealer_leads dl
                            WHERE dl.is_active IS NOT FALSE AND ${istRangeNaive(sql`dl.created_at`, p.from, p.to)}`,
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
            // ID 59 (3 Oct 2026): connected human calls — the predicate Block C
            // groups per caller (salesDailyBlocks.loadRepExtras), so the two
            // blocks of one email show the same count.
            perPeriod(db, periods, (p) => sql`SELECT COUNT(*) AS n FROM lead_touchpoints t WHERE ${engagedCall()} AND ${inRange(sql`t.performed_at`, p)}`),
            // HANDOVER-A31: only transfers someone is credited with (transferCredit) —
            // a bulk assign of an unowned lead is nobody's "Hot to field", so it is
            // in no Block C row and not in this total either (as Targets / scorecard).
            perPeriod(
                db,
                periods,
                (p) => sql`SELECT COUNT(DISTINCT t.dealer_lead_id) AS n FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                            WHERE ${firstMoveToField()} AND ${inRange(sql`t.performed_at`, p)}
                              AND ${transferCredit()} IS NOT NULL
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
                            WHERE h.to_status = 'Won' AND (to_jsonb(h) ->> 'won_undone_at') IS NULL AND ${inRange(sql`h.changed_at`, p)}`,
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

    const clocks = await clocksPending;
    const rows: BlockARow[] = [
        { group: "INTAKE", label: "Leads in", kind: "count", values: leadsIn, target: null },
        { group: "INTAKE", label: "Became sales-ready", kind: "count", values: hasSalesReady ? salesReady : NONE, target: null },
        { group: "INTAKE", label: "Assigned", kind: "count", values: assigned, target: null },
        { group: "EFFORT", label: "Calls made", kind: "count", values: fromDash((d) => d.totals.calls), target: tgt("calls_per_day") },
        { group: "EFFORT", label: "Dealers called", kind: "count", values: fromDash((d) => d.totals.dealers_called), target: null },
        { group: "EFFORT", label: "Engaged calls", kind: "count", values: engaged, target: null },
        { group: "EFFORT", label: "Hot handed to field", kind: "count", values: hotToField, target: tgt("hot_to_ground") },
        // ID 185: Visits = Fresh + Repeat on the rep's basis, visited rows only.
        { group: "EFFORT", label: "Visits", kind: "count", values: fromDash((d) => d.totals.visits), target: null },
        { group: "EFFORT", label: "Fresh visits", kind: "count", values: fromDash((d) => d.totals.fresh_visits), target: null },
        { group: "EFFORT", label: "Repeat visits", kind: "count", values: fromDash((d) => repeatVisits(d.totals.visits, d.totals.fresh_visits)), target: null },
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
        {
            group: "OUTCOME",
            label: "Batteries sold",
            kind: "count",
            values: fromDash((d) => d.outcome.batteries_to_dealers),
            target: tgt("batteries_sold"),
            // IDs 70 / 147: same "at least" reading as the CEO tile, from the
            // dashboards' own battery_lines coverage.
            readings: {
                y: batteryReading(dash.yesterday.outcome),
                prev: batteryReading(dash.dayBefore.outcome),
                wk: batteryReading(dash.sameDayLastWeek.outcome),
                d7: batteryReading(dash.last7.outcome),
                mtd: batteryReading(dash.mtd.outcome),
                lm: batteryReading(dash.lastMonth.outcome),
            },
        },
        { group: "OUTCOME", label: "Revenue", kind: "money", values: fromDash((d) => d.outcome.revenue), target: tgt("revenue") },
        { group: "OUTCOME", label: "KYC submitted", kind: "count", values: fromDash((d) => d.outcome.kyc_submitted), target: tgt("kyc_submitted") },
        { group: "OUTCOME", label: "KYC disbursed", kind: "count", values: kycDisbursed, target: tgt("kyc_disbursed") },
        { group: "OUTCOME", label: "Scrap deals", kind: "count", values: scrapDeals, target: tgt("scrap_deals") },
        // Kg over requests that completed pickup — scrapKgSourced(), the CEO
        // control tower's buyback tile.
        { group: "OUTCOME", label: "Scrap sourced (kg)", kind: "count", values: scrapKg, target: null },
        // ID 86 — the owner clock (lead_clocks): share of new owners whose
        // first call / visit came within the limit, and every limit passed.
        { group: "DISCIPLINE", label: "First attempt within limit", kind: "percent", values: clocks.inLimit, target: null },
        { group: "DISCIPLINE", label: "Time limits missed", kind: "count", values: clocks.missed, target: null },
        { group: "DISCIPLINE", label: "Hours to first attempt", kind: "hours", values: clocks.median, target: null },
        { group: "DISCIPLINE", label: "Hours to first attempt (slowest 1 in 10)", kind: "hours", values: clocks.p90, target: null },
    ];

    const visitsNote =
        visitedDiffers && t.map.has("dealer_visits")
            ? ` Dealers visited: % of target counts each person's own dealers (${visitedPerPerson} in total), as their targets do; the figure shown counts a dealer once however many people visited.`
            : "";
    const targetsNote =
        t.total > 0
            ? `Month to date is ${t.elapsed} of ${t.total} working days, so targets are ${t.elapsed}/${t.total} of the monthly target. Targets sent (accepted or not) to ${t.withTarget} of ${t.reps} people; drafts not yet sent are left out.${visitsNote}`
            : "No targets are set for this month.";
    return {
        rows: withUnmatchedRevenue(rows, unmatchedRevenue),
        targetsNote,
        workingDays: { elapsed: t.elapsed, total: t.total },
        userTargets: t.perUser,
    };
}
