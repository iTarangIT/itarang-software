/**
 * B6/B7 — the sales dashboard's wire types and vocabularies.
 *
 * CLIENT-SAFE: no `db` import. The screen components import from HERE, never
 * from ./salesDashboard, because that module imports the Postgres driver and
 * anything that pulls it into a "use client" bundle fails at compile time
 * ("import { performance } from 'perf_hooks'"). ./salesDashboard re-exports
 * everything below so server code has one import.
 */

export const SALES_DASHBOARD_GRANULARITIES = ["day", "week", "month"] as const;
export type SalesDashboardGranularity = (typeof SALES_DASHBOARD_GRANULARITIES)[number];

/** Longest range the endpoints accept — a year of daily rows is plenty. */
export const SALES_DASHBOARD_MAX_DAYS = 366;

/** What a caller hands the builder: the window is optional (defaults apply). */
export interface SalesDashboardInput {
    from?: string | null;
    to?: string | null;
    city?: string | null;
    state?: string | null;
    spoc_id?: string | null;
    business_type?: string | null;
    granularity: SalesDashboardGranularity;
}

export interface SalesDashboardFilters {
    /** Inclusive IST calendar day, YYYY-MM-DD. */
    from: string;
    /** Inclusive IST calendar day, YYYY-MM-DD. */
    to: string;
    city?: string | null;
    state?: string | null;
    /** users.id of one rep. Present → sections A–D are that rep's; E is omitted. */
    spoc_id?: string | null;
    /** A BUSINESS_TYPES value or "unset" (E-296). */
    business_type?: string | null;
    granularity: SalesDashboardGranularity;
}

export interface SalesSnapshot {
    /** lead_visits.actual_visit_date = yesterday (IST). */
    visits_yesterday: number;
    /** inside_sales_call + ai_call touchpoints performed yesterday (IST). */
    calls_yesterday: number;
    /** scheduled_date = today and the visit is still open. */
    planned_visits_today: number;
    /** scheduled_date in [today, today + 7) and still open. */
    planned_visits_next_7_days: number;
}

export interface SalesSeriesRow {
    /** First IST calendar day of the bucket, YYYY-MM-DD. */
    bucket: string;
    visits: number;
    /** Distinct dealers visited in the bucket. */
    unique_visits: number;
    /** Dealers whose FIRST-EVER visit fell in the bucket. */
    new_visits: number;
    calls: number;
}

export interface SalesAverages {
    /** Calendar days in [from, to]. */
    days_in_range: number;
    avg_visits_per_day: number;
    /** Mean of the per-day distinct-dealer counts. */
    avg_unique_per_day: number;
    avg_new_per_day: number;
    avg_calls_per_day: number;
}

export const INTEREST_LEVELS = ["hot", "warm", "cold"] as const;
export type InterestLevel = (typeof INTEREST_LEVELS)[number];

export interface InterestRow {
    interest_level: InterestLevel;
    total: number;
    age_0_7: number;
    age_8_14: number;
    age_15_30: number;
    age_30_plus: number;
}

export interface InterestSection {
    rows: InterestRow[];
    /** The column the ageing buckets are measured from. */
    ageing_basis: string;
}

/** Section T — the range as one row. `unique_visits` is distinct dealers over
 *  the WHOLE range (not a sum of per-bucket uniques). */
export interface SalesTotals {
    visits: number;
    unique_visits: number;
    new_visits: number;
    calls: number;
    /**
     * Distinct dealers with at least one call in the range (B8 "count of
     * dealers called"). CC-team calls will be included once the call-centre
     * role exists (ticket A2).
     */
    dealers_called: number;
    /** Leads that reached Converted in the range (closed_at, IST). */
    converted: number;
}

export interface SalesDashboardSections {
    snapshot: SalesSnapshot;
    series: SalesSeriesRow[];
    averages: SalesAverages;
    interest: InterestSection;
    totals: SalesTotals;
}

export interface SalesSpocBlock extends SalesDashboardSections {
    spoc_id: string;
    name: string | null;
    role: string | null;
}

export interface SalesDashboard extends SalesDashboardSections {
    /** The filters actually applied, with defaults filled in. */
    filters: SalesDashboardFilters;
    /** IST calendar day the snapshot is relative to. */
    as_of_date: string;
    /** Section E. `null` when spoc_id was given (there is nothing to split). */
    per_spoc: SalesSpocBlock[] | null;
}
