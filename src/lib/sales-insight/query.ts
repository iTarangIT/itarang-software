// Single source of truth for the unified converted-leads query. The list
// endpoint, the CSV export endpoint, and the KPI endpoint all build their
// SQL from here so a filter change in the UI maps identically across every
// surface — no risk of "the export includes rows that the table doesn't"
// or "KPIs reflect a different filter than the page".
//
// Why a raw SQL CTE-UNION instead of Drizzle's query builder: the two
// sources have completely different column shapes (dealer_leads stores
// the conversion event inside a jsonb array; leads has a flat
// converted_at column), so they need different SELECT projections that
// only line up after the UNION. Drizzle's typed builder can't model
// that without a lot of casting; raw SQL is shorter and clearer.

import { sql, type SQL } from "drizzle-orm";
import type { ConvertedFilters } from "./types";

export type BuiltQueries = {
    rowsSql: SQL;
    countSql: SQL;
    kpiSql: SQL;
    totalLeadsSql: SQL; // denominator for conversion rate
};

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Shared UNION-of-sources expression, parameterised on whether to apply
// the pagination clause. Lives behind a function so the count query, the
// list query, and the export query can reuse the exact same `base` CTE
// without copy-paste drift.
//
// Why DISTINCT ON (phone-last-10) ordered by source-pref then conversion
// date: a scraped dealer lead that later gets promoted into the leads
// table will appear in both sources. The only join key between them is
// the phone number (there's no FK), and `dealer_leads.phone` is
// normalised to 10 digits while `leads.phone` is varchar(20) and may
// carry a country prefix. Normalising both sides with RIGHT(...) of a
// digits-only string gives us a stable dedupe key. We prefer the B2B row
// because its downstream tables (deals, KYC, loan_applications) carry
// more useful data than the dialer-only row does on its own.
function unionBase(filters: ConvertedFilters): SQL {
    const fromDate = filters.from_date ?? null;
    const toDate = filters.to_date ?? null;
    const region = filters.region?.trim() || null;
    const dealerId = filters.dealer_id?.trim() || null;
    const search = filters.search?.trim() || null;

    const regionLike = region ? `%${region}%` : null;
    const searchLike = search ? `%${search}%` : null;

    return sql`
        WITH src_a AS (
            SELECT
                'dl_' || dl.id                                                     AS id,
                'ai_dialer'                                                        AS source,
                COALESCE(NULLIF(dl.shop_name, ''), NULLIF(dl.dealer_name, ''), '—') AS display_name,
                RIGHT(REGEXP_REPLACE(COALESCE(dl.phone, ''), '\\D', '', 'g'), 10)  AS phone,
                NULLIF(CONCAT_WS(', ', NULLIF(dl.city, ''), NULLIF(dl.state, '')), '') AS region,
                NULLIF(dl.dealer_id, '')                                           AS dealer_id,
                NULLIF(
                    (dl.follow_up_history ->
                        (jsonb_array_length(dl.follow_up_history) - 1))
                        ->> 'timestamp',
                    ''
                )::timestamptz                                                     AS converted_at,
                NULLIF(
                    (dl.follow_up_history ->
                        (jsonb_array_length(dl.follow_up_history) - 1))
                        -> 'analysis' ->> 'intent_score',
                    ''
                )::int                                                             AS intent_score,
                dl.id                                                              AS raw_ref
            FROM dealer_leads dl
            WHERE dl.follow_up_history IS NOT NULL
              AND jsonb_array_length(dl.follow_up_history) > 0
              AND COALESCE(
                    ((dl.follow_up_history ->
                        (jsonb_array_length(dl.follow_up_history) - 1))
                        -> 'analysis' ->> 'intent_score')::int,
                    0
                  ) >= 75
        ),
        src_b AS (
            SELECT
                'ld_' || l.id                                                      AS id,
                'b2b'                                                              AS source,
                COALESCE(NULLIF(l.business_name, ''), NULLIF(l.full_name, ''), NULLIF(l.owner_name, ''), '—') AS display_name,
                RIGHT(REGEXP_REPLACE(COALESCE(l.phone, l.mobile, ''), '\\D', '', 'g'), 10) AS phone,
                NULLIF(CONCAT_WS(', ', NULLIF(l.city, ''), NULLIF(l.state, '')), '') AS region,
                NULLIF(l.dealer_id, '')                                            AS dealer_id,
                COALESCE(l.converted_at, l.updated_at)                             AS converted_at,
                l.intent_score                                                     AS intent_score,
                l.id                                                               AS raw_ref
            FROM leads l
            WHERE l.converted_deal_id IS NOT NULL
        ),
        unioned AS (
            SELECT * FROM src_a
            UNION ALL
            SELECT * FROM src_b
        ),
        -- DISTINCT ON keeps the first row per phone-bucket; b2b wins because
        -- source = 'b2b' sorts before 'ai_dialer' alphabetically. The
        -- also_in list reattaches the dropped source so the drawer can
        -- still surface the AI dialer transcript on a B2B-winning row.
        deduped AS (
            SELECT DISTINCT ON (phone)
                u.*,
                (
                    SELECT COALESCE(array_agg(DISTINCT u2.source) FILTER (WHERE u2.source <> u.source), '{}')
                    FROM unioned u2
                    WHERE u2.phone = u.phone
                ) AS also_in
            FROM unioned u
            WHERE u.phone IS NOT NULL AND u.phone <> ''
            ORDER BY u.phone, u.source ASC, u.converted_at DESC NULLS LAST
        ),
        base AS (
            SELECT * FROM deduped
            WHERE (${fromDate}::timestamptz IS NULL OR converted_at >= ${fromDate}::timestamptz)
              AND (${toDate}::timestamptz   IS NULL OR converted_at <= ${toDate}::timestamptz)
              AND (${regionLike}::text       IS NULL OR region ILIKE ${regionLike}::text)
              AND (${dealerId}::text         IS NULL OR dealer_id = ${dealerId}::text)
              AND (${searchLike}::text       IS NULL OR display_name ILIKE ${searchLike}::text OR phone ILIKE ${searchLike}::text)
        )
    `;
}

export function buildConvertedQuery(filters: ConvertedFilters): BuiltQueries {
    const page = Math.max(DEFAULT_PAGE, Number(filters.page) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(filters.limit) || DEFAULT_LIMIT));
    const offset = (page - 1) * limit;

    const base = unionBase(filters);

    const rowsSql = sql`
        ${base}
        SELECT
            id,
            source,
            display_name,
            phone,
            region,
            dealer_id,
            converted_at,
            intent_score,
            raw_ref,
            also_in
        FROM base
        ORDER BY converted_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
    `;

    const countSql = sql`
        ${base}
        SELECT COUNT(*)::int AS count FROM base
    `;

    // KPIs derived from the same `base` so they always describe the same
    // filtered set as the table. avg_intent_score_ai only counts rows
    // whose surviving source is ai_dialer (B2B rows that absorbed an
    // ai_dialer row via dedupe don't carry an intent_score).
    const kpiSql = sql`
        ${base}
        SELECT
            COUNT(*)::int                                                          AS total_converted,
            COUNT(*) FILTER (
                WHERE converted_at >= date_trunc('month', NOW())
            )::int                                                                 AS this_month_converted,
            ROUND(AVG(intent_score) FILTER (WHERE intent_score IS NOT NULL))::int  AS avg_intent_score_ai
        FROM base
    `;

    // Denominator for the conversion-rate KPI — counts every lead that
    // could have converted. Total dealer_leads (regardless of intent
    // score) plus total leads (regardless of converted_deal_id).
    const totalLeadsSql = sql`
        SELECT (
            (SELECT COUNT(*) FROM dealer_leads) +
            (SELECT COUNT(*) FROM leads)
        )::int AS count
    `;

    return { rowsSql, countSql, kpiSql, totalLeadsSql };
}
