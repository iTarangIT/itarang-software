/**
 * Reports › Analyses — the three plain-table analyses from the 13 Oct call.
 * Server only. Each returns a GridResult (analysesShared.ts) with the checks
 * that prove its rows add up.
 *
 *   cohorts      A22  leads by creation month → converted in month 1 / 2 / 3 /
 *                     later, and of those who reordered, in which month.
 *   turnaround   A23  median and slowest 1 in 10 between the stages of a sale.
 *   ai_outcomes  A24  AI-scored leads: onboarding submitted and first invoice
 *                     within 30 / 60 days, by score band, handled-late apart.
 *
 * Orders are invoices matched to the dealer's lead (revenueSource.ts) that are
 * not void and not credit notes (REVENUE_IS_ORDER) — the same rule as Dealer
 * Health's order count.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchedUnion, REVENUE_IS_ORDER } from "@/lib/dashboard/revenueSource";
import { primeHolidayLog, workingDaysBetweenAsOfSql } from "@/lib/calendar/holidays";
import { medianAndP90 } from "@/lib/leads/clockRules";
import { hasLeadClocks } from "@/lib/leads/clocks";
import { leadKeyValidOn, leadsByGstinKey } from "@/lib/leads/gstinMatch";
import type { AnalysisCheck, AnalysisPeriod, GridResult, GridRow } from "./analysesShared";

const IST = "Asia/Kolkata";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const rowsOf = async <T>(q: SQL) => (await db.execute(q)) as unknown as T[];
const n = (v: unknown): number => Number(v ?? 0);

/** dealer_leads.created_at (UTC, no zone) as an IST day. */
const LEAD_DAY = sql`((dl.created_at) AT TIME ZONE 'UTC' AT TIME ZONE ${IST})::date`;

export type GridFilters = { from?: string | null; to?: string | null };

async function period(f: GridFilters, backDays: number, monthStart = false): Promise<AnalysisPeriod> {
    const [t] = await rowsOf<{ today: string; start: string }>(sql`
        SELECT (now() AT TIME ZONE ${IST})::date::text AS today,
               ${monthStart
                   ? sql`date_trunc('month', (now() AT TIME ZONE ${IST})::date - ${backDays}::int)::date::text`
                   : sql`((now() AT TIME ZONE ${IST})::date - ${backDays}::int)::text`} AS start`);
    const from = f.from && ISO.test(f.from) ? f.from : t.start;
    const to = f.to && ISO.test(f.to) ? f.to : t.today;
    return from <= to ? { from, to } : { from: to, to: from };
}

function check(label: string, rows: GridRow[], ok: (r: GridRow) => boolean, name: (r: GridRow) => string): AnalysisCheck {
    const bad = rows.filter((r) => !ok(r));
    return { label, holds: bad.length === 0, detail: bad.length ? `Breaks on ${bad.map(name).join(", ")}.` : "" };
}

/** Orders per lead: distinct invoice days, ranked. */
async function ordersCte(): Promise<SQL> {
    const src = await matchedUnion();
    return sql`
        SELECT x.dealer_lead_id AS id, x.invoice_date AS d,
               dense_rank() OVER (PARTITION BY x.dealer_lead_id ORDER BY x.invoice_date) AS rk
          FROM (SELECT DISTINCT COALESCE(r.dealer_lead_id, gk.dealer_lead_id) AS dealer_lead_id, r.invoice_date
                  FROM ${src} AS r
                  -- An invoice matched to an account with no source lead: the lead with its GSTIN (as dealCardActuals).
                  LEFT JOIN (${leadsByGstinKey()}) gk
                         ON r.dealer_lead_id IS NULL AND r.account_id IS NOT NULL AND gk.k = r.gstin_key
                        AND ${leadKeyValidOn("gk", sql`r.invoice_date`)}
                 WHERE ${REVENUE_IS_ORDER} AND COALESCE(r.dealer_lead_id, gk.dealer_lead_id) IS NOT NULL
                   AND r.invoice_date IS NOT NULL) x`;
}

// ─────────────────────────────── A22 Cohorts ────────────────────────────────

export async function cohorts(f: GridFilters): Promise<GridResult> {
    // Default: the last six creation months, this one included.
    const p = await period(f, 150, true);
    const orders = await ordersCte();
    const raw = await rowsOf<Record<string, string>>(sql`
        WITH base AS (
            SELECT dl.id, date_trunc('month', ${LEAD_DAY})::date AS cm,
                   CASE WHEN dl.lead_status = 'Converted' AND dl.closed_at IS NOT NULL
                        THEN date_trunc('month', (dl.closed_at AT TIME ZONE ${IST})::date)::date END AS conv_m
              FROM dealer_leads dl
             WHERE dl.is_active IS NOT FALSE AND ${LEAD_DAY} BETWEEN ${p.from}::date AND ${p.to}::date
        ),
        ord AS (${orders}),
        re AS (SELECT id, MIN(d) FILTER (WHERE rk = 2) AS d2 FROM ord GROUP BY id),
        m AS (
            SELECT b.cm, b.conv_m,
                   (EXTRACT(YEAR FROM age(b.conv_m, b.cm)) * 12 + EXTRACT(MONTH FROM age(b.conv_m, b.cm)))::int + 1 AS conv_i,
                   CASE WHEN b.conv_m IS NOT NULL AND re.d2 IS NOT NULL THEN
                        (EXTRACT(YEAR FROM age(date_trunc('month', re.d2)::date, b.cm)) * 12
                         + EXTRACT(MONTH FROM age(date_trunc('month', re.d2)::date, b.cm)))::int + 1 END AS re_i
              FROM base b LEFT JOIN re ON re.id = b.id
        )
        SELECT to_char(cm, 'YYYY-MM') AS month,
               COUNT(*)::text AS created,
               COUNT(*) FILTER (WHERE conv_i = 1)::text AS conv_1,
               COUNT(*) FILTER (WHERE conv_i = 2)::text AS conv_2,
               COUNT(*) FILTER (WHERE conv_i = 3)::text AS conv_3,
               COUNT(*) FILTER (WHERE conv_i > 3)::text AS conv_later,
               COUNT(conv_m)::text AS converted,
               COUNT(re_i)::text AS reordered,
               COUNT(*) FILTER (WHERE re_i <= 2)::text AS re_by_2,
               COUNT(*) FILTER (WHERE re_i = 3)::text AS re_3,
               COUNT(*) FILTER (WHERE re_i > 3)::text AS re_later
          FROM m GROUP BY cm ORDER BY cm`);
    const keys = ["created", "conv_1", "conv_2", "conv_3", "conv_later", "converted", "reordered", "re_by_2", "re_3", "re_later"];
    const rows: GridRow[] = raw.map((r) => {
        const row: GridRow = { month: r.month };
        for (const k of keys) row[k] = n(r[k]);
        row.conv_pct = n(r.created) ? (n(r.converted) / n(r.created)) * 100 : null;
        return row;
    });
    const total: GridRow = { month: "All months" };
    for (const k of keys) total[k] = rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    total.conv_pct = Number(total.created) ? (Number(total.converted) / Number(total.created)) * 100 : null;
    const all = [...rows, total];
    return {
        kind: "grid",
        period: p,
        columns: [
            { key: "month", label: "Created in", kind: "text" },
            { key: "created", label: "Leads", kind: "count" },
            { key: "conv_1", label: "Converted · month 1", kind: "count", hint: "Converted in the month the lead was created" },
            { key: "conv_2", label: "Month 2", kind: "count" },
            { key: "conv_3", label: "Month 3", kind: "count" },
            { key: "conv_later", label: "Later", kind: "count" },
            { key: "converted", label: "Converted", kind: "count" },
            { key: "conv_pct", label: "Conversion", kind: "pct" },
            { key: "reordered", label: "Reordered", kind: "count", hint: "Converted dealers with a second invoice on a later day" },
            { key: "re_by_2", label: "Reorder by month 2", kind: "count" },
            { key: "re_3", label: "Month 3", kind: "count" },
            { key: "re_later", label: "Later", kind: "count" },
        ],
        rows,
        total,
        checks: [
            check("Converted = month 1 + 2 + 3 + later, on every row", all,
                (r) => Number(r.conv_1) + Number(r.conv_2) + Number(r.conv_3) + Number(r.conv_later) === Number(r.converted), (r) => String(r.month)),
            check("Reordered = by month 2 + month 3 + later, and never more than converted", all,
                (r) => Number(r.re_by_2) + Number(r.re_3) + Number(r.re_later) === Number(r.reordered) && Number(r.reordered) <= Number(r.converted),
                (r) => String(r.month)),
        ],
    };
}

// ────────────────────────────── A23 Turnaround ──────────────────────────────

const STAGES = [
    { key: "s1", label: "New lead → first visit", unit: "working days" },
    { key: "s2", label: "First visit → first quote", unit: "working days" },
    { key: "s3", label: "First quote → first invoice (dispatch)", unit: "working days" },
    { key: "s4", label: "1st invoice → 2nd invoice", unit: "days" },
    { key: "s5", label: "2nd invoice → 3rd invoice", unit: "days" },
] as const;

export async function turnaround(f: GridFilters): Promise<GridResult> {
    const p = await period(f, 179);
    // ID 85 #6: each stage's days use the holidays as they stood when it ended.
    await primeHolidayLog();
    const orders = await ordersCte();
    // A date (visit, invoice) is read as office opening, 10:00 IST, that day.
    const at10 = (d: SQL) => sql`((${d}) + TIME '10:00') AT TIME ZONE ${IST}`;
    const raw = await rowsOf<{ s1: number | null; s2: number | null; s3: number | null; s4: number | null; s5: number | null }>(sql`
        WITH leads AS (
            SELECT dl.id, (dl.created_at AT TIME ZONE 'UTC') AS created
              FROM dealer_leads dl
             WHERE dl.is_active IS NOT FALSE AND ${LEAD_DAY} BETWEEN ${p.from}::date AND ${p.to}::date
        ),
        fv AS (SELECT v.dealer_lead_id AS id, MIN(v.actual_visit_date) AS d FROM lead_visits v
                WHERE v.visit_status = 'visited' AND v.actual_visit_date IS NOT NULL GROUP BY 1),
        fq AS (SELECT c.dealer_lead_id AS id, MIN(c.created_at) AS at FROM dealer_lead_commercials c
                WHERE c.event_type = 'quote_issue' GROUP BY 1),
        ord AS (${orders}),
        b AS (SELECT id, MIN(d) FILTER (WHERE rk = 1) AS b1, MIN(d) FILTER (WHERE rk = 2) AS b2,
                     MIN(d) FILTER (WHERE rk = 3) AS b3 FROM ord GROUP BY id),
        j AS (
            SELECT l.created, fv.d AS v1, fq.at AS q1, b.b1, b.b2, b.b3
              FROM leads l LEFT JOIN fv ON fv.id = l.id LEFT JOIN fq ON fq.id = l.id LEFT JOIN b ON b.id = l.id
        )
        SELECT
            CASE WHEN v1 IS NOT NULL AND ${at10(sql`v1`)} >= created
                 THEN ${workingDaysBetweenAsOfSql(sql`created`, at10(sql`v1`))} END AS s1,
            CASE WHEN v1 IS NOT NULL AND q1 IS NOT NULL AND q1 >= ${at10(sql`v1`)} - INTERVAL '10 hours'
                 THEN ${workingDaysBetweenAsOfSql(at10(sql`v1`), sql`q1`)} END AS s2,
            CASE WHEN q1 IS NOT NULL AND b1 IS NOT NULL AND ${at10(sql`b1`)} >= q1 - INTERVAL '10 hours'
                 THEN ${workingDaysBetweenAsOfSql(sql`q1`, at10(sql`b1`))} END AS s3,
            (b2 - b1) AS s4,
            (b3 - b2) AS s5
          FROM j`);
    const rows: GridRow[] = STAGES.map((s) => {
        const vals = raw.map((r) => r[s.key]).filter((v): v is number => v != null).map(Number);
        const { median, p90 } = medianAndP90(vals);
        return { stage: s.label, unit: s.unit, leads: vals.length, median, p90 };
    });
    return {
        kind: "grid",
        period: p,
        columns: [
            { key: "stage", label: "Stage", kind: "text" },
            { key: "unit", label: "Counted in", kind: "text" },
            { key: "leads", label: "Leads that got there", kind: "count" },
            { key: "median", label: "Median", kind: "days" },
            { key: "p90", label: "Slowest 1 in 10", kind: "days" },
        ],
        rows,
        total: { stage: `${raw.length} leads created in the period`, unit: "", leads: raw.length, median: null, p90: null },
        checks: [
            check("No stage is negative (out-of-order dates are left out)", rows, (r) => r.median == null || Number(r.median) >= 0, (r) => String(r.stage)),
            check("Median never above the slowest 1 in 10", rows, (r) => r.median == null || Number(r.median) <= Number(r.p90), (r) => String(r.stage)),
        ],
    };
}

// ────────────────────────────── A24 AI outcomes ─────────────────────────────

const BANDS = ["81-100", "61-80", "41-60", "21-40", "0-20"] as const;

export async function aiOutcomes(f: GridFilters): Promise<GridResult> {
    const p = await period(f, 179);
    const orders = await ordersCte();
    const clocks = await hasLeadClocks();
    const late = clocks
        ? sql`EXISTS (SELECT 1 FROM lead_clocks c WHERE c.dealer_lead_id = dl.id
                       AND c.clock IN ('lead', 'owner', 'hot_owner', 'transfer') AND c.limit_passed_at IS NOT NULL)`
        : sql`NULL::boolean`;
    const raw = await rowsOf<Record<string, string | null>>(sql`
        WITH ord AS (${orders}),
        first_order AS (SELECT id, MIN(d) AS d FROM ord GROUP BY id),
        base AS (
            SELECT CASE
                       WHEN dl.final_intent_score <= 20 THEN '0-20'
                       WHEN dl.final_intent_score <= 40 THEN '21-40'
                       WHEN dl.final_intent_score <= 60 THEN '41-60'
                       WHEN dl.final_intent_score <= 80 THEN '61-80'
                       ELSE '81-100' END AS band,
                   ${late} AS late,
                   (dl.created_at AT TIME ZONE 'UTC') AS created,
                   (oa.submitted_at AT TIME ZONE 'UTC') AS submitted,
                   ((fo.d + TIME '10:00') AT TIME ZONE ${IST}) AS invoiced
              FROM dealer_leads dl
              LEFT JOIN dealer_onboarding_applications oa ON oa.id = dl.dealer_onboarding_application_id
              LEFT JOIN first_order fo ON fo.id = dl.id
             WHERE dl.is_active IS NOT FALSE
               AND COALESCE(dl.final_intent_score, 0) > 0
               AND ${LEAD_DAY} BETWEEN ${p.from}::date AND ${p.to}::date
        )
        SELECT band, COALESCE(late, false) AS late,
               COUNT(*)::text AS leads,
               COUNT(*) FILTER (WHERE created <= now() - INTERVAL '30 days')::text AS ripe30,
               COUNT(*) FILTER (WHERE created <= now() - INTERVAL '60 days')::text AS ripe60,
               COUNT(*) FILTER (WHERE submitted IS NOT NULL AND submitted <= created + INTERVAL '30 days')::text AS onb30,
               COUNT(*) FILTER (WHERE submitted IS NOT NULL AND submitted <= created + INTERVAL '60 days')::text AS onb60,
               COUNT(*) FILTER (WHERE invoiced IS NOT NULL AND invoiced <= created + INTERVAL '30 days')::text AS inv30,
               COUNT(*) FILTER (WHERE invoiced IS NOT NULL AND invoiced <= created + INTERVAL '60 days')::text AS inv60
          FROM base GROUP BY 1, 2`);
    const pct = (a: number, b: number) => (b ? (a / b) * 100 : null);
    const rows: GridRow[] = [];
    for (const band of BANDS) {
        for (const isLate of [false, true]) {
            const r = raw.find((x) => x.band === band && String(x.late) === String(isLate));
            const leads = n(r?.leads);
            if (!leads && isLate) continue;
            rows.push({
                band: `${band.replace("-", "–")}${isLate ? " · handled late" : ""}`,
                leads,
                onb30: pct(n(r?.onb30), n(r?.ripe30) || leads),
                onb60: pct(n(r?.onb60), n(r?.ripe60) || leads),
                inv30: pct(n(r?.inv30), n(r?.ripe30) || leads),
                inv60: pct(n(r?.inv60), n(r?.ripe60) || leads),
                _onb30: n(r?.onb30),
                _onb60: n(r?.onb60),
                _inv30: n(r?.inv30),
                _inv60: n(r?.inv60),
            });
        }
    }
    const total: GridRow = {
        band: "All AI-scored leads",
        leads: rows.reduce((s, r) => s + Number(r.leads), 0),
        onb30: null,
        onb60: null,
        inv30: null,
        inv60: null,
    };
    // Outcome within 60 days can only be ≥ within 30 days; in-time rows only say something about the score.
    const onTime = rows.filter((r) => !String(r.band).includes("late") && Number(r.leads) > 0);
    const inversions: string[] = [];
    for (let i = 0; i + 1 < onTime.length; i++) {
        const a = Number(onTime[i].onb60 ?? 0);
        const b = Number(onTime[i + 1].onb60 ?? 0);
        if (a < b) inversions.push(`${onTime[i].band} below ${onTime[i + 1].band}`);
    }
    return {
        kind: "grid",
        period: p,
        columns: [
            { key: "band", label: "AI score band", kind: "text" },
            { key: "leads", label: "Leads", kind: "count" },
            { key: "onb30", label: "Onboarding submitted ≤ 30 d", kind: "pct", hint: "Of the leads at least 30 days old" },
            { key: "onb60", label: "≤ 60 d", kind: "pct", hint: "Of the leads at least 60 days old" },
            { key: "inv30", label: "First invoice ≤ 30 d", kind: "pct" },
            { key: "inv60", label: "≤ 60 d", kind: "pct" },
        ],
        rows: rows.map(({ _onb30, _onb60, _inv30, _inv60, ...r }) => r),
        total,
        checks: [
            check("Within 60 days is never below within 30 days", rows,
                (r) => Number(r._onb60) >= Number(r._onb30) && Number(r._inv60) >= Number(r._inv30), (r) => String(r.band)),
            {
                label: "Among leads handled in time, a higher band onboards at least as well (60 days)",
                holds: inversions.length === 0,
                detail: inversions.length ? `Breaks: ${inversions.join("; ")}.` : "",
            },
            ...(clocks ? [] : [{ label: "Handled late is measured", holds: false, detail: "Lead clocks (E-337) are not on this database." }]),
        ],
    };
}
