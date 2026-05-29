// Shapes shared by the /sales-insight dashboard, its list/export APIs, and
// the per-row drill-in drawer. Two heterogeneous lead sources are flattened
// into a single ConvertedRow so the table never has to switch on source.
//
//   ai_dialer  → dealer_leads rows where the last follow_up_history entry's
//                analysis.intent_score >= 75
//   b2b        → leads rows with converted_deal_id IS NOT NULL

export type LeadSource = "ai_dialer" | "b2b";

export type ConvertedRow = {
    // Prefixed id ("dl_<id>" | "ld_<id>") so the table can hold rows from
    // both sources without primary-key collisions and the drill-in router
    // can pick the right detail endpoint without a separate `source` param.
    id: string;
    source: LeadSource;
    display_name: string;
    // Last-10-digit normalised so deduplication across sources stays sane.
    phone: string;
    region: string | null;
    dealer_id: string | null;
    converted_at: string | null;
    intent_score: number | null;
    raw_ref: string;
    // When dedupe collapses two rows for the same phone into one, this
    // surfaces the dropped source so the drawer can still load it.
    also_in: LeadSource[];
};

export type ConvertedFilters = {
    from_date?: string | null;     // ISO date, inclusive
    to_date?: string | null;       // ISO date, inclusive
    region?: string | null;        // ILIKE match on state/city
    dealer_id?: string | null;     // exact match
    search?: string | null;        // ILIKE on display_name / phone
    page?: number;
    limit?: number;
};

export type Kpis = {
    total_converted: number;
    this_month_converted: number;
    avg_intent_score_ai: number | null;
    conversion_rate_pct: number | null; // converted / total leads across both sources
};

export type ConvertedListResponse = {
    success: true;
    rows: ConvertedRow[];
    total: number;
    page: number;
    limit: number;
    kpis: Kpis;
};
