/**
 * B6 — Sales dashboard: visits, calls, hot / warm / cold with ageing, per rep.
 *
 * One builder, five sections, all read from tables that already exist:
 *
 *   A  snapshot   visits yesterday, calls yesterday, planned visits today and
 *                 in the next 7 days (granularity-independent)
 *   B  series     one row per day / week / month in [from, to]: total visits,
 *                 UNIQUE visits (distinct dealers), NEW visits (the dealer's
 *                 first-ever visit), calls
 *   C  averages   per calendar day over the range
 *   D  interest   hot / warm / cold counts with ageing buckets
 *   T  totals     the whole range in one row: visits, unique, new, calls,
 *                 converted (B7 — feeds the per-rep table and the CSV)
 *   O  outcome    what the effort produced: quotes issued, revenue, batteries
 *                 to dealers, KYC submitted (review R-10 — queryOutcome)
 *   E  per_spoc   A–D + T again, once per rep, when no spoc_id was asked for
 *
 * "Unique" and "new" are DIFFERENT columns and must stay so: unique = how many
 * distinct dealers were visited in the bucket; new = how many of those had never
 * been visited before (MIN(actual_visit_date) over the whole table, not just the
 * range — a first visit is a property of the dealer, not of the report window).
 *
 * TIMEZONE. The business runs on IST. `lead_visits` dates are plain `date`
 * columns already entered as IST calendar days, so they are compared as-is.
 * `lead_touchpoints.performed_at` is timestamptz and is shifted with
 * `AT TIME ZONE 'Asia/Kolkata'` BEFORE truncating to a day. "Today" is also
 * taken from Postgres in IST — never from the Node clock (see the scheduler
 * clock-skew note in the team memory: the app hosts have drifted before).
 *
 * WHO A REP IS, PER SECTION. A visit belongs to `lead_visits.asm_id`, a call to
 * `lead_touchpoints.performed_by`, a lead (for hot/warm/cold) to
 * `dealer_leads.current_owner_id`, and a conversion to
 * `dealer_leads.closing_owner_id` (who held it when it closed). The `spoc_id`
 * filter and the per-rep grouping use those columns respectively.
 *
 * WHAT A CALL IS. `inside_sales_call` and `ai_call` only — see the header of
 * src/lib/lifecycle/touchpointTypes.ts for why a priority-dial request is NOT
 * a call and must not inflate call volume.
 *
 * AGEING = HOW LONG THE LEAD HAS HELD ITS CURRENT RATING. Buckets are days
 * since `dealer_leads.interest_changed_at` (E-301, review R-05, metric M12),
 * stamped by a database trigger whenever interest_level changes. It used to be
 * `updated_at`, which moves on ANY edit or touchpoint, so a lead rated Hot a
 * month ago showed as 0–7 days the moment anyone touched it. Rows from before
 * E-301 carry a best-evidence backfill (see the migration header).
 *
 * Every count comes back from Postgres as text (bigint) and is Number()'d here.
 */

import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
    BUSINESS_TYPE_UNSET,
    BusinessTypeSchema,
    isBusinessTypeFilter,
} from "@/lib/leads/businessType";
import { dealerLeadByGstin, GSTIN_KEY } from "@/lib/leads/gstinMatch";
import { matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import {
    INTEREST_LEVELS,
    SALES_DASHBOARD_GRANULARITIES,
    SALES_DASHBOARD_MAX_DAYS,
    type InterestLevel,
    type InterestRow,
    type InterestSection,
    type SalesAverages,
    type SalesDashboard,
    type SalesDashboardFilters,
    type SalesDashboardGranularity,
    type SalesDashboardInput,
    type SalesDashboardSections,
    type SalesSeriesRow,
    type SalesOutcome,
    type SalesSnapshot,
    type SalesSpocBlock,
    type SalesTotals,
} from "./salesDashboardTypes";

// Wire types + vocabularies live in ./salesDashboardTypes (client-safe, no db
// import — the screen components read them from there). Re-exported so server
// callers keep one import.
export * from "./salesDashboardTypes";

// ─────────────────────────────── Params ─────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Query-string contract shared by the admin and ASM routes. Everything is
 * optional: no range = the last 30 IST calendar days ending today.
 */
export const SalesDashboardParamsSchema = z.object({
    from: z.string().regex(ISO_DATE, "from must be YYYY-MM-DD").optional(),
    to: z.string().regex(ISO_DATE, "to must be YYYY-MM-DD").optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    spoc_id: z.string().trim().min(1).max(64).optional(),
    business_type: z
        .union([BusinessTypeSchema, z.literal(BUSINESS_TYPE_UNSET)])
        .optional(),
    granularity: z.enum(SALES_DASHBOARD_GRANULARITIES).default("day"),
});
export type SalesDashboardParams = z.infer<typeof SalesDashboardParamsSchema>;

/** Read the params off a URL; throws a ZodError the route turns into a 400. */
export function parseSalesDashboardParams(url: URL): SalesDashboardParams {
    const p = url.searchParams;
    const get = (k: string) => {
        const v = p.get(k)?.trim();
        return v ? v : undefined;
    };
    return SalesDashboardParamsSchema.parse({
        from: get("from"),
        to: get("to"),
        city: get("city"),
        state: get("state"),
        spoc_id: get("spoc_id"),
        business_type: get("business_type"),
        granularity: get("granularity"),
    });
}

// ─────────────────────────────── Fragments ──────────────────────────────────

const CALL_TYPES = sql`('inside_sales_call', 'ai_call')`;
/** A scheduled visit that has not happened yet and was not called off. */
const OPEN_VISIT = sql`v.visit_status NOT IN ('visited', 'cancelled', 'no_show')`;
const IST = "Asia/Kolkata";
const AGEING_BASIS = "dealer_leads.interest_changed_at";

const num = (v: unknown): number => Number(v ?? 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * City / state / business type, all on the joined `dl` alias. City and state
 * compare trimmed and case-folded so "nashik" and "Nashik" are one place; an
 * unknown value simply matches nothing, which the spec wants read as zeros.
 * business_type is emitted ONLY when asked for — the column is outside
 * schema.ts (E-296) and naming it unconditionally would fail on a host that
 * lacks it.
 */
function leadScope(f: SalesDashboardFilters): SQL {
    const parts: SQL[] = [];
    if (f.city) parts.push(sql` AND lower(trim(dl.city)) = lower(trim(${f.city}))`);
    if (f.state) parts.push(sql` AND lower(trim(dl.state)) = lower(trim(${f.state}))`);
    if (f.business_type && isBusinessTypeFilter(f.business_type)) {
        parts.push(
            f.business_type === BUSINESS_TYPE_UNSET
                ? sql` AND dl.business_type IS NULL`
                : sql` AND dl.business_type = ${f.business_type}`,
        );
    }
    return parts.length ? sql.join(parts, sql``) : sql``;
}

/** `AND <col> = spoc` when a rep is pinned; nothing otherwise. */
function spocClause(col: SQL, f: SalesDashboardFilters): SQL {
    return f.spoc_id ? sql` AND ${col} = ${f.spoc_id}` : sql``;
}

/**
 * The SELECT-list expression for the grouping key. Per-rep runs group on the
 * real column; whole-team runs group on a constant NULL so the same query
 * shape yields exactly one group.
 */
function spocKey(col: SQL, bySpoc: boolean): SQL {
    return bySpoc ? sql`${col}::text` : sql`NULL::text`;
}

// ─────────────────────────────── Queries ────────────────────────────────────

/** Today as an IST calendar day, from Postgres. */
async function istToday(): Promise<string> {
    const rows = await db.execute<{ today: string }>(sql`
        SELECT (now() AT TIME ZONE ${IST})::date::text AS today
    `);
    return String((rows as unknown as { today: string }[])[0]!.today);
}

type SnapshotRow = {
    spoc: string | null;
    visits_yesterday: string;
    calls_yesterday: string;
    planned_today: string;
    planned_7: string;
};

async function querySnapshot(
    f: SalesDashboardFilters,
    today: string,
    bySpoc: boolean,
): Promise<Map<string | null, SalesSnapshot>> {
    const rows = await db.execute<SnapshotRow>(sql`
        WITH v AS (
            SELECT ${spocKey(sql`v.asm_id`, bySpoc)} AS spoc,
                   v.actual_visit_date, v.scheduled_date, v.visit_status
              FROM lead_visits v
              JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
             WHERE (
                       v.actual_visit_date = ${today}::date - 1
                    OR (v.scheduled_date >= ${today}::date
                        AND v.scheduled_date < ${today}::date + 7)
                   )
                   ${leadScope(f)} ${spocClause(sql`v.asm_id`, f)}
        ),
        c AS (
            SELECT ${spocKey(sql`t.performed_by`, bySpoc)} AS spoc
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type IN ${CALL_TYPES}
               -- coarse bound first (indexable), exact IST day second
               AND t.performed_at >= (${today}::date - 2)::timestamp
               AND (t.performed_at AT TIME ZONE ${IST})::date = ${today}::date - 1
               ${leadScope(f)} ${spocClause(sql`t.performed_by`, f)}
        ),
        parts AS (
            SELECT spoc,
                   COUNT(*) FILTER (WHERE actual_visit_date = ${today}::date - 1) AS visits_yesterday,
                   0::bigint AS calls_yesterday,
                   COUNT(*) FILTER (WHERE scheduled_date = ${today}::date AND ${OPEN_VISIT}) AS planned_today,
                   COUNT(*) FILTER (WHERE scheduled_date >= ${today}::date
                                      AND scheduled_date < ${today}::date + 7
                                      AND ${OPEN_VISIT}) AS planned_7
              FROM v GROUP BY spoc
            UNION ALL
            SELECT spoc, 0, COUNT(*), 0, 0 FROM c GROUP BY spoc
        )
        SELECT spoc,
               SUM(visits_yesterday)::text AS visits_yesterday,
               SUM(calls_yesterday)::text  AS calls_yesterday,
               SUM(planned_today)::text    AS planned_today,
               SUM(planned_7)::text        AS planned_7
          FROM parts
         GROUP BY spoc
    `);
    const out = new Map<string | null, SalesSnapshot>();
    for (const r of rows as unknown as SnapshotRow[]) {
        out.set(r.spoc, {
            visits_yesterday: num(r.visits_yesterday),
            calls_yesterday: num(r.calls_yesterday),
            planned_visits_today: num(r.planned_today),
            planned_visits_next_7_days: num(r.planned_7),
        });
    }
    return out;
}

type SeriesRow = {
    spoc: string | null;
    bucket: string;
    visits: string;
    unique_visits: string;
    new_visits: string;
    calls: string;
};

/**
 * One row per (rep, bucket). Buckets come from generate_series so a quiet week
 * is a row of zeros, not a missing row — a chart with gaps reads as broken.
 * For whole-team runs the rep key is a single NULL group.
 */
async function querySeries(
    f: SalesDashboardFilters,
    granularity: SalesDashboardGranularity,
    bySpoc: boolean,
): Promise<Map<string | null, SalesSeriesRow[]>> {
    const step = `1 ${granularity}`;
    const spocs = bySpoc
        ? sql`SELECT DISTINCT spoc FROM agg`
        : sql`SELECT NULL::text AS spoc`;

    const rows = await db.execute<SeriesRow>(sql`
        WITH buckets AS (
            SELECT gs::date AS bucket
              FROM generate_series(
                       date_trunc(${granularity}, ${f.from}::date::timestamp)::date,
                       ${f.to}::date,
                       ${step}::interval
                   ) gs
        ),
        -- First-ever visit per dealer, over the WHOLE table on purpose.
        fv AS (
            SELECT dealer_lead_id, MIN(actual_visit_date) AS first_d
              FROM lead_visits
             WHERE actual_visit_date IS NOT NULL
             GROUP BY dealer_lead_id
        ),
        vis AS (
            SELECT ${spocKey(sql`v.asm_id`, bySpoc)} AS spoc,
                   date_trunc(${granularity}, v.actual_visit_date::timestamp)::date AS bucket,
                   v.dealer_lead_id,
                   (v.actual_visit_date = fv.first_d) AS is_new
              FROM lead_visits v
              JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
              LEFT JOIN fv ON fv.dealer_lead_id = v.dealer_lead_id
             WHERE v.actual_visit_date >= ${f.from}::date
               AND v.actual_visit_date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(sql`v.asm_id`, f)}
        ),
        calls AS (
            SELECT ${spocKey(sql`t.performed_by`, bySpoc)} AS spoc,
                   date_trunc(${granularity},
                              (t.performed_at AT TIME ZONE ${IST})::date::timestamp)::date AS bucket
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type IN ${CALL_TYPES}
               AND t.performed_at >= (${f.from}::date - 1)::timestamp
               AND t.performed_at <  (${f.to}::date + 2)::timestamp
               AND (t.performed_at AT TIME ZONE ${IST})::date >= ${f.from}::date
               AND (t.performed_at AT TIME ZONE ${IST})::date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(sql`t.performed_by`, f)}
        ),
        agg AS (
            SELECT spoc, bucket,
                   COUNT(*)                                            AS visits,
                   COUNT(DISTINCT dealer_lead_id)                      AS unique_visits,
                   COUNT(DISTINCT dealer_lead_id) FILTER (WHERE is_new) AS new_visits,
                   0::bigint                                           AS calls
              FROM vis GROUP BY spoc, bucket
            UNION ALL
            SELECT spoc, bucket, 0, 0, 0, COUNT(*) FROM calls GROUP BY spoc, bucket
        ),
        spocs AS (${spocs})
        SELECT s.spoc,
               b.bucket::text                     AS bucket,
               COALESCE(SUM(a.visits), 0)::text        AS visits,
               COALESCE(SUM(a.unique_visits), 0)::text AS unique_visits,
               COALESCE(SUM(a.new_visits), 0)::text    AS new_visits,
               COALESCE(SUM(a.calls), 0)::text         AS calls
          FROM spocs s
         CROSS JOIN buckets b
          LEFT JOIN agg a ON a.spoc IS NOT DISTINCT FROM s.spoc AND a.bucket = b.bucket
         GROUP BY s.spoc, b.bucket
         ORDER BY s.spoc, b.bucket
    `);
    const out = new Map<string | null, SalesSeriesRow[]>();
    for (const r of rows as unknown as SeriesRow[]) {
        const list = out.get(r.spoc) ?? [];
        list.push({
            bucket: String(r.bucket),
            visits: num(r.visits),
            unique_visits: num(r.unique_visits),
            new_visits: num(r.new_visits),
            calls: num(r.calls),
        });
        out.set(r.spoc, list);
    }
    return out;
}

/**
 * Section C from the DAILY series (not from the requested granularity — a
 * weekly bucket's "unique" is not the sum of its days' uniques, so the per-day
 * mean must be taken from per-day rows).
 */
function averagesFromDaily(daily: SalesSeriesRow[], daysInRange: number): SalesAverages {
    const d = Math.max(1, daysInRange);
    const sum = (k: keyof Omit<SalesSeriesRow, "bucket">) =>
        daily.reduce((acc, r) => acc + r[k], 0);
    return {
        days_in_range: daysInRange,
        avg_visits_per_day: round2(sum("visits") / d),
        avg_unique_per_day: round2(sum("unique_visits") / d),
        avg_new_per_day: round2(sum("new_visits") / d),
        avg_calls_per_day: round2(sum("calls") / d),
    };
}

type InterestDbRow = {
    spoc: string | null;
    interest_level: string;
    total: string;
    age_0_7: string;
    age_8_14: string;
    age_15_30: string;
    age_30_plus: string;
};

/**
 * Section D. Active, open leads only: a Converted or Lost lead's temperature is
 * history, and counting it would make "hot" read as a backlog that is not
 * there. Ageing = days since AGEING_BASIS, measured in IST calendar days.
 * COALESCE to created_at is defensive only — the trigger stamps every rating
 * and E-301 backfilled every existing one.
 */
async function queryInterest(
    f: SalesDashboardFilters,
    today: string,
    bySpoc: boolean,
): Promise<Map<string | null, InterestRow[]>> {
    const rows = await db.execute<InterestDbRow>(sql`
        WITH l AS (
            SELECT ${spocKey(sql`dl.current_owner_id`, bySpoc)} AS spoc,
                   dl.interest_level,
                   (${today}::date
                    - (COALESCE(dl.interest_changed_at, dl.created_at) AT TIME ZONE ${IST})::date) AS age
              FROM dealer_leads dl
             WHERE dl.interest_level IN ('hot', 'warm', 'cold')
               AND dl.is_active IS NOT FALSE
               AND dl.lead_status IS DISTINCT FROM 'Converted'
               AND dl.lead_status IS DISTINCT FROM 'Lost'
               ${leadScope(f)} ${spocClause(sql`dl.current_owner_id`, f)}
        )
        SELECT spoc, interest_level,
               COUNT(*)::text                                        AS total,
               COUNT(*) FILTER (WHERE age <= 7)::text                AS age_0_7,
               COUNT(*) FILTER (WHERE age BETWEEN 8 AND 14)::text    AS age_8_14,
               COUNT(*) FILTER (WHERE age BETWEEN 15 AND 30)::text   AS age_15_30,
               COUNT(*) FILTER (WHERE age > 30)::text                AS age_30_plus
          FROM l
         GROUP BY spoc, interest_level
    `);
    const out = new Map<string | null, InterestRow[]>();
    for (const r of rows as unknown as InterestDbRow[]) {
        const list = out.get(r.spoc) ?? [];
        list.push({
            interest_level: r.interest_level as InterestLevel,
            total: num(r.total),
            age_0_7: num(r.age_0_7),
            age_8_14: num(r.age_8_14),
            age_15_30: num(r.age_15_30),
            age_30_plus: num(r.age_30_plus),
        });
        out.set(r.spoc, list);
    }
    return out;
}

type TotalsRow = {
    spoc: string | null;
    visits: string;
    unique_visits: string;
    new_visits: string;
    calls: string;
    dealers_called: string;
    converted: string;
    new_hot: string;
    hot_converted: string;
};

/**
 * Section T. Same shape as the snapshot query: three sources (visits, calls,
 * conversions) each grouped on their own rep column, unioned, then summed.
 * `unique_visits` is COUNT(DISTINCT) over the whole range, which is why it is
 * not derived from the series.
 *
 * MOVEMENT (review R-09). Hot / warm / cold in `interest` are a snapshot of
 * open leads as of now — the same number for any range. These two respond to
 * the range:
 *   new_hot        leads whose rating became Hot in the range
 *                  (interest_changed_at, E-301) and are still Hot, keyed on
 *                  current_owner_id. A lead that turned Hot and then cooled
 *                  again in the range is not counted: there is no rating
 *                  history, only the latest change.
 *   hot_converted  conversions in the range (same rule as `converted`) whose
 *                  rating was Hot when they closed — interest_level is not
 *                  cleared on conversion, so it is the rating they closed at.
 */
async function queryTotals(
    f: SalesDashboardFilters,
    bySpoc: boolean,
): Promise<Map<string | null, SalesTotals>> {
    const rows = await db.execute<TotalsRow>(sql`
        WITH fv AS (
            SELECT dealer_lead_id, MIN(actual_visit_date) AS first_d
              FROM lead_visits
             WHERE actual_visit_date IS NOT NULL
             GROUP BY dealer_lead_id
        ),
        vis AS (
            SELECT ${spocKey(sql`v.asm_id`, bySpoc)} AS spoc,
                   v.dealer_lead_id,
                   (v.actual_visit_date = fv.first_d) AS is_new
              FROM lead_visits v
              JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
              LEFT JOIN fv ON fv.dealer_lead_id = v.dealer_lead_id
             WHERE v.actual_visit_date >= ${f.from}::date
               AND v.actual_visit_date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(sql`v.asm_id`, f)}
        ),
        calls AS (
            SELECT ${spocKey(sql`t.performed_by`, bySpoc)} AS spoc, t.dealer_lead_id
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type IN ${CALL_TYPES}
               AND t.performed_at >= (${f.from}::date - 1)::timestamp
               AND t.performed_at <  (${f.to}::date + 2)::timestamp
               AND (t.performed_at AT TIME ZONE ${IST})::date >= ${f.from}::date
               AND (t.performed_at AT TIME ZONE ${IST})::date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(sql`t.performed_by`, f)}
        ),
        conv AS (
            SELECT ${spocKey(sql`dl.closing_owner_id`, bySpoc)} AS spoc,
                   (lower(dl.interest_level) = 'hot') AS was_hot
              FROM dealer_leads dl
             WHERE dl.lead_status = 'Converted'
               AND dl.closed_at IS NOT NULL
               AND (dl.closed_at AT TIME ZONE ${IST})::date >= ${f.from}::date
               AND (dl.closed_at AT TIME ZONE ${IST})::date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(sql`dl.closing_owner_id`, f)}
        ),
        newhot AS (
            SELECT ${spocKey(sql`dl.current_owner_id`, bySpoc)} AS spoc
              FROM dealer_leads dl
             WHERE lower(dl.interest_level) = 'hot'
               AND dl.is_active IS NOT FALSE
               AND dl.interest_changed_at IS NOT NULL
               AND (dl.interest_changed_at AT TIME ZONE ${IST})::date >= ${f.from}::date
               AND (dl.interest_changed_at AT TIME ZONE ${IST})::date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(sql`dl.current_owner_id`, f)}
        ),
        parts AS (
            SELECT spoc,
                   COUNT(*)                                             AS visits,
                   COUNT(DISTINCT dealer_lead_id)                       AS unique_visits,
                   COUNT(DISTINCT dealer_lead_id) FILTER (WHERE is_new) AS new_visits,
                   0::bigint AS calls, 0::bigint AS dealers_called, 0::bigint AS converted,
                   0::bigint AS new_hot, 0::bigint AS hot_converted
              FROM vis GROUP BY spoc
            UNION ALL
            SELECT spoc, 0, 0, 0, COUNT(*), COUNT(DISTINCT dealer_lead_id), 0, 0, 0 FROM calls GROUP BY spoc
            UNION ALL
            SELECT spoc, 0, 0, 0, 0, 0, COUNT(*), 0, COUNT(*) FILTER (WHERE was_hot) FROM conv GROUP BY spoc
            UNION ALL
            SELECT spoc, 0, 0, 0, 0, 0, 0, COUNT(*), 0 FROM newhot GROUP BY spoc
        )
        SELECT spoc,
               SUM(visits)::text         AS visits,
               SUM(unique_visits)::text  AS unique_visits,
               SUM(new_visits)::text     AS new_visits,
               SUM(calls)::text          AS calls,
               SUM(dealers_called)::text AS dealers_called,
               SUM(converted)::text      AS converted,
               SUM(new_hot)::text        AS new_hot,
               SUM(hot_converted)::text  AS hot_converted
          FROM parts
         GROUP BY spoc
    `);
    const out = new Map<string | null, SalesTotals>();
    for (const r of rows as unknown as TotalsRow[]) {
        out.set(r.spoc, {
            visits: num(r.visits),
            unique_visits: num(r.unique_visits),
            new_visits: num(r.new_visits),
            calls: num(r.calls),
            dealers_called: num(r.dealers_called),
            converted: num(r.converted),
            new_hot: num(r.new_hot),
            hot_converted: num(r.hot_converted),
        });
    }
    return out;
}

const EMPTY_TOTALS: SalesTotals = {
    visits: 0,
    unique_visits: 0,
    new_visits: 0,
    calls: 0,
    dealers_called: 0,
    converted: 0,
    new_hot: 0,
    hot_converted: 0,
};

type OutcomeRow = {
    spoc: string | null;
    quotes_issued: string;
    revenue: string;
    batteries_to_dealers: string;
    kyc_submitted: string;
};

/**
 * Section O (review R-10) — see SalesOutcome for definitions. Kept out of
 * queryTotals' positional UNION: four more columns there would be four more
 * chances to shift a value into the wrong slot.
 *
 * Revenue, batteries and KYC key on dealer_leads.current_owner_id of the lead
 * whose GSTIN matches (gstinMatch.ts), and the lead scope (city / state /
 * business type) applies to THAT lead. Quotes key on who created them.
 */
async function queryOutcome(
    f: SalesDashboardFilters,
    bySpoc: boolean,
): Promise<Map<string | null, SalesOutcome>> {
    const invoices = await matchedUnion();
    const owner = sql`dl.current_owner_id`;
    const rows = await db.execute<OutcomeRow>(sql`
        WITH quotes AS (
            SELECT ${spocKey(sql`c.created_by`, bySpoc)} AS spoc, COUNT(*) AS n
              FROM dealer_lead_commercials c
              JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
             WHERE c.event_type IN ('quote_issue', 'quote_revision')
               AND (c.created_at AT TIME ZONE ${IST})::date >= ${f.from}::date
               AND (c.created_at AT TIME ZONE ${IST})::date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(sql`c.created_by`, f)}
             GROUP BY 1
        ),
        revenue AS (
            SELECT ${spocKey(owner, bySpoc)} AS spoc, COALESCE(SUM(r.total), 0) AS n
              FROM ${invoices} AS r
              JOIN dealer_leads dl ON dl.id = r.dealer_lead_id
             WHERE ${REVENUE_NOT_VOID}
               AND r.invoice_date >= ${f.from}::date
               AND r.invoice_date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(owner, f)}
             GROUP BY 1
        ),
        batteries AS (
            SELECT ${spocKey(owner, bySpoc)} AS spoc, COUNT(*) AS n
              FROM inventory i
              JOIN accounts a ON a.id = i.dealer_id
              JOIN ${dealerLeadByGstin(GSTIN_KEY(sql`a.gstin`))} m ON TRUE
              JOIN dealer_leads dl ON dl.id = m.dealer_lead_id
             WHERE i.asset_type = 'battery'
               AND i.allocated_to_dealer_at IS NOT NULL
               AND (i.allocated_to_dealer_at AT TIME ZONE ${IST})::date >= ${f.from}::date
               AND (i.allocated_to_dealer_at AT TIME ZONE ${IST})::date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(owner, f)}
             GROUP BY 1
        ),
        kyc AS (
            -- One lead, one file, however many queue rows — the funnel report's
            -- rule (funnelCounts.ts kycSharedQuery).
            SELECT ${spocKey(owner, bySpoc)} AS spoc, COUNT(*) AS n
              FROM (SELECT lead_id, MIN(created_at) AS first_at
                      FROM admin_verification_queue GROUP BY lead_id) q
              JOIN leads l ON l.id::text = q.lead_id
              JOIN accounts a ON a.id = l.dealer_id
              JOIN ${dealerLeadByGstin(GSTIN_KEY(sql`a.gstin`))} m ON TRUE
              JOIN dealer_leads dl ON dl.id = m.dealer_lead_id
             WHERE (q.first_at AT TIME ZONE ${IST})::date >= ${f.from}::date
               AND (q.first_at AT TIME ZONE ${IST})::date <= ${f.to}::date
               ${leadScope(f)} ${spocClause(owner, f)}
             GROUP BY 1
        ),
        spocs AS (
            SELECT spoc FROM quotes UNION SELECT spoc FROM revenue
            UNION SELECT spoc FROM batteries UNION SELECT spoc FROM kyc
        )
        SELECT s.spoc,
               COALESCE(qu.n, 0)::text AS quotes_issued,
               COALESCE(rv.n, 0)::text AS revenue,
               COALESCE(ba.n, 0)::text AS batteries_to_dealers,
               COALESCE(ky.n, 0)::text AS kyc_submitted
          FROM spocs s
          LEFT JOIN quotes    qu ON qu.spoc IS NOT DISTINCT FROM s.spoc
          LEFT JOIN revenue   rv ON rv.spoc IS NOT DISTINCT FROM s.spoc
          LEFT JOIN batteries ba ON ba.spoc IS NOT DISTINCT FROM s.spoc
          LEFT JOIN kyc       ky ON ky.spoc IS NOT DISTINCT FROM s.spoc
    `);
    const out = new Map<string | null, SalesOutcome>();
    for (const r of rows as unknown as OutcomeRow[]) {
        out.set(r.spoc, {
            quotes_issued: num(r.quotes_issued),
            revenue: round2(num(r.revenue)),
            batteries_to_dealers: num(r.batteries_to_dealers),
            kyc_submitted: num(r.kyc_submitted),
        });
    }
    return out;
}

const EMPTY_OUTCOME: SalesOutcome = {
    quotes_issued: 0,
    revenue: 0,
    batteries_to_dealers: 0,
    kyc_submitted: 0,
};

/** Always hot, warm, cold in that order, zero-filled. */
function completeInterest(rows: InterestRow[] | undefined): InterestSection {
    const by = new Map((rows ?? []).map((r) => [r.interest_level, r]));
    return {
        rows: INTEREST_LEVELS.map(
            (level) =>
                by.get(level) ?? {
                    interest_level: level,
                    total: 0,
                    age_0_7: 0,
                    age_8_14: 0,
                    age_15_30: 0,
                    age_30_plus: 0,
                },
        ),
        ageing_basis: AGEING_BASIS,
    };
}

const EMPTY_SNAPSHOT: SalesSnapshot = {
    visits_yesterday: 0,
    calls_yesterday: 0,
    planned_visits_today: 0,
    planned_visits_next_7_days: 0,
};

async function userNames(
    ids: string[],
): Promise<Map<string, { name: string | null; role: string | null }>> {
    const out = new Map<string, { name: string | null; role: string | null }>();
    if (!ids.length) return out;
    const rows = await db.execute<{ id: string; name: string | null; role: string | null }>(sql`
        SELECT id::text AS id, name, role
          FROM users
         WHERE id::text IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const r of rows as unknown as { id: string; name: string | null; role: string | null }[]) {
        out.set(r.id, { name: r.name, role: r.role });
    }
    return out;
}

// ─────────────────────────────── Dates ──────────────────────────────────────

function addDays(iso: string, n: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(from: string, to: string): number {
    const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
    const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
    return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Fill in the range defaults and validate it. Exported so the verify script and
 * the routes resolve the window identically.
 */
export function resolveSalesDashboardFilters(
    p: SalesDashboardParams,
    today: string,
): SalesDashboardFilters {
    const to = p.to ?? today;
    const from = p.from ?? addDays(to, -29);
    if (from > to) throw new RangeError("`from` must not be after `to`.");
    const days = daysBetweenInclusive(from, to);
    if (days > SALES_DASHBOARD_MAX_DAYS) {
        throw new RangeError(`Range is ${days} days; the maximum is ${SALES_DASHBOARD_MAX_DAYS}.`);
    }
    return {
        from,
        to,
        city: p.city ?? null,
        state: p.state ?? null,
        spoc_id: p.spoc_id ?? null,
        business_type: p.business_type ?? null,
        granularity: p.granularity,
    };
}

// ─────────────────────────────── Builder ────────────────────────────────────

/**
 * Build every section for one filter set. Sections A–D describe the whole
 * scope (or the one rep, when spoc_id is set); E repeats them per rep and is
 * `null` when a rep was pinned.
 *
 * The per-rep pass runs the same three queries once more with GROUP BY on the
 * rep column, so the cost is a fixed 6–7 statements regardless of team size.
 */
export async function buildSalesDashboard(
    input: SalesDashboardInput,
): Promise<SalesDashboard> {
    const today = await istToday();
    const f = resolveSalesDashboardFilters(
        {
            from: input.from || undefined,
            to: input.to || undefined,
            city: input.city ?? undefined,
            state: input.state ?? undefined,
            spoc_id: input.spoc_id ?? undefined,
            business_type: isBusinessTypeFilter(input.business_type) ? input.business_type : undefined,
            granularity: input.granularity,
        },
        today,
    );
    const daysInRange = daysBetweenInclusive(f.from, f.to);
    const bySpoc = !f.spoc_id;

    // Whole-scope pass (A–D). The daily series doubles as the source of C; when
    // the caller asked for days it IS the series, otherwise the requested
    // granularity is a second, cheap query.
    const [snapshotAll, dailyAll, interestAll, totalsAll, outcomeAll] = await Promise.all([
        querySnapshot(f, today, false),
        querySeries(f, "day", false),
        queryInterest(f, today, false),
        queryTotals(f, false),
        queryOutcome(f, false),
    ]);
    const seriesAll =
        f.granularity === "day" ? dailyAll : await querySeries(f, f.granularity, false);

    const whole: SalesDashboardSections = {
        snapshot: snapshotAll.get(null) ?? EMPTY_SNAPSHOT,
        series: seriesAll.get(null) ?? [],
        averages: averagesFromDaily(dailyAll.get(null) ?? [], daysInRange),
        interest: completeInterest(interestAll.get(null)),
        totals: totalsAll.get(null) ?? EMPTY_TOTALS,
        outcome: outcomeAll.get(null) ?? EMPTY_OUTCOME,
    };

    let perSpoc: SalesSpocBlock[] | null = null;
    if (bySpoc) {
        const [snapshotBy, dailyBy, interestBy, totalsBy, outcomeBy] = await Promise.all([
            querySnapshot(f, today, true),
            querySeries(f, "day", true),
            queryInterest(f, today, true),
            queryTotals(f, true),
            queryOutcome(f, true),
        ]);
        const seriesBy =
            f.granularity === "day" ? dailyBy : await querySeries(f, f.granularity, true);

        const ids = new Set<string>();
        for (const m of [snapshotBy, dailyBy, interestBy, seriesBy, totalsBy, outcomeBy]) {
            for (const k of m.keys()) if (k) ids.add(k);
        }
        const names = await userNames([...ids]);

        perSpoc = [...ids]
            .map((id): SalesSpocBlock => ({
                spoc_id: id,
                name: names.get(id)?.name ?? null,
                role: names.get(id)?.role ?? null,
                snapshot: snapshotBy.get(id) ?? EMPTY_SNAPSHOT,
                series: seriesBy.get(id) ?? [],
                averages: averagesFromDaily(dailyBy.get(id) ?? [], daysInRange),
                interest: completeInterest(interestBy.get(id)),
                totals: totalsBy.get(id) ?? EMPTY_TOTALS,
                outcome: outcomeBy.get(id) ?? EMPTY_OUTCOME,
            }))
            // Busiest first, then by name so ties are stable.
            .sort(
                (a, b) =>
                    b.totals.visits + b.totals.calls - (a.totals.visits + a.totals.calls) ||
                    (a.name ?? "").localeCompare(b.name ?? ""),
            );
    }

    return { filters: f, as_of_date: today, ...whole, per_spoc: perSpoc };
}

// ─────────────────────────────── CSV ────────────────────────────────────────

export interface SalesCsvColumn<R> {
    header: string;
    value: (row: R) => string;
}

export interface SalesCsvSheet {
    columns: SalesCsvColumn<Record<string, unknown>>[];
    rows: Record<string, unknown>[];
    /** Without extension or timestamp — csvResponse adds both. */
    filename: string;
}

const s = (v: unknown) => (v == null ? "" : String(v));

/**
 * `?format=csv` — the rows the screen's main table shows, nothing more.
 *
 * Whole-team view (per_spoc present): one row per rep, the columns of the
 * per-rep table. Pinned-rep views (ASM / ISR / admin with spoc_id): one row
 * per bucket, the columns of the series table. "Same rows as the table" is
 * the contract, so the CSV never carries a section the screen does not.
 */
export function salesDashboardCsv(d: SalesDashboard): SalesCsvSheet {
    const range = `${d.filters.from}_${d.filters.to}`;
    if (d.per_spoc) {
        const level = (b: SalesSpocBlock, l: InterestLevel) =>
            b.interest.rows.find((r) => r.interest_level === l)?.total ?? 0;
        const rows = d.per_spoc.map((b) => ({
            name: b.name ?? b.spoc_id,
            role: b.role ?? "",
            visits: b.totals.visits,
            unique_visits: b.totals.unique_visits,
            new_visits: b.totals.new_visits,
            calls: b.totals.calls,
            hot: level(b, "hot"),
            warm: level(b, "warm"),
            cold: level(b, "cold"),
            converted: b.totals.converted,
            quotes_issued: b.outcome.quotes_issued,
            batteries_to_dealers: b.outcome.batteries_to_dealers,
            revenue: b.outcome.revenue,
            kyc_submitted: b.outcome.kyc_submitted,
        }));
        return {
            filename: `sales-dashboard-by-rep-${range}`,
            columns: [
                { header: "Rep", value: (r) => s(r.name) },
                { header: "Role", value: (r) => s(r.role) },
                { header: "Visits", value: (r) => s(r.visits) },
                { header: "Unique Dealers", value: (r) => s(r.unique_visits) },
                { header: "New Dealers", value: (r) => s(r.new_visits) },
                { header: "Calls", value: (r) => s(r.calls) },
                { header: "Hot", value: (r) => s(r.hot) },
                { header: "Warm", value: (r) => s(r.warm) },
                { header: "Cold", value: (r) => s(r.cold) },
                { header: "Converted", value: (r) => s(r.converted) },
                { header: "Quotes Issued", value: (r) => s(r.quotes_issued) },
                { header: "Batteries to Dealers", value: (r) => s(r.batteries_to_dealers) },
                { header: "Revenue (INR)", value: (r) => s(r.revenue) },
                { header: "KYC Submitted", value: (r) => s(r.kyc_submitted) },
            ],
            rows,
        };
    }
    return {
        filename: `sales-dashboard-${d.filters.granularity}-${range}`,
        columns: [
            { header: "Bucket", value: (r) => s(r.bucket) },
            { header: "Visits", value: (r) => s(r.visits) },
            { header: "Unique Dealers", value: (r) => s(r.unique_visits) },
            { header: "New Dealers", value: (r) => s(r.new_visits) },
            { header: "Calls", value: (r) => s(r.calls) },
        ],
        rows: d.series.map((r) => ({ ...r })),
    };
}
