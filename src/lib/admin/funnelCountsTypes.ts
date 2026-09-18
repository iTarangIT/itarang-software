/**
 * B10 — Admin funnel counts: wire types and vocabularies.
 *
 * CLIENT-SAFE: no `db` import. The Funnel tab imports from here; the builder
 * in ./funnelCounts re-exports everything (same split as salesDashboardTypes,
 * for the same reason — a "use client" import of a module that pulls in the
 * Postgres driver fails the page at compile time).
 */

export const FUNNEL_GROUP_BYS = ["none", "city", "state", "month", "dealer", "nbfc"] as const;
export type FunnelGroupBy = (typeof FUNNEL_GROUP_BYS)[number];

export const FUNNEL_GROUP_LABELS: Record<FunnelGroupBy, string> = {
    none: "Totals only",
    city: "City",
    state: "State",
    month: "Month",
    dealer: "Dealer",
    nbfc: "Financier (NBFC)",
};

export interface FunnelFilters {
    /** Inclusive IST calendar days, YYYY-MM-DD. */
    from: string;
    to: string;
    city?: string | null;
    state?: string | null;
    /** accounts.id — the canonical dealer id every table resolves to. */
    dealer_id?: string | null;
    /** nbfc_tenants.id. Applies to disbursed / rejected ONLY (see notes). */
    nbfc_id?: string | null;
    group_by: FunnelGroupBy;
}

export interface FunnelCounts {
    /** dealer_onboarding_applications.approved_at in range. */
    dealers_onboarded: number;
    /** Distinct leads whose KYC case entered admin_verification_queue in range. */
    kyc_shared: number;
    /** loan_sanctions.disbursed_at in range. */
    files_disbursed: number;
    /** loan_sanctions in status rejected, by updated_at, in range. */
    files_rejected: number;
    /** Extra, outside the spec's four: applications rejected in range. */
    onboarding_rejected: number;
}

export interface FunnelRow extends FunnelCounts {
    /** Stable group key: lower-cased city/state, YYYY-MM, accounts.id, tenant id. */
    key: string;
    /** What the table shows. */
    label: string;
}

export interface FunnelReason {
    /** Display spelling (first seen, trimmed). Blank reasons read "Not specified". */
    reason: string;
    count: number;
}

export interface FunnelOption {
    id: string;
    name: string;
}

export interface FunnelCountsResult {
    filters: FunnelFilters;
    totals: FunnelCounts;
    /** Loan rejections by reason; sums to totals.files_rejected. */
    rejection_reasons: FunnelReason[];
    /** Onboarding rejections by reason; sums to totals.onboarding_rejected. */
    onboarding_rejection_reasons: FunnelReason[];
    /** One row per group; empty when group_by = none. */
    rows: FunnelRow[];
    /** Caveats the screen must show, e.g. which counts a filter does not touch. */
    notes: string[];
    /** Pick-lists for the filter bar. */
    options: { dealers: FunnelOption[]; nbfcs: FunnelOption[] };
}
