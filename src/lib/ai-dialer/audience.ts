// Audience resolution for campaign targeting.
//
// Extracted verbatim from /api/ai-dialer/preview (E-224) so the NeoDove push
// path targets the SAME lead set the AI dialer would, resolved by the SAME
// canonical-city logic. Duplicating this query was the alternative, and it
// would have guaranteed drift: the alias resolution below exists precisely
// because an earlier exact-text filter under-counted (tree showed Sonipat=53,
// the dialer queued 49), and a second copy would have re-introduced that class
// of bug on the NeoDove side only.
//
// The preview route is now a thin wrapper over this function; its response
// shape is unchanged.
//
// Region resolution:
//  - groupIds   → resolved to the union of their `regions` jsonb arrays
//  - states[]   → match any row in that state (no city constraint)
//  - cities[]   → match {state, city} pairs exactly
//  - pincodes[] → match any row with that pincode
//  Empty selection matches every callable lead.

import { db } from "@/lib/db";
import { regionGroups } from "@/lib/db/schema";
import { inArray, sql } from "drizzle-orm";
import { AI_DIALABLE_SQL } from "@/lib/ai-dialer/exclusionFilter";
import { INTENT_THRESHOLDS } from "@/lib/ai/scoring";

type RegionEntry = { state: string; cities?: string[] };

export type AudienceSelection = {
    states?: string[];
    cities?: { state: string; city: string }[];
    pincodes?: string[];
    groupIds?: string[];
    category?: "hot" | "warm" | "cold" | "all";
};

export type AudienceRow = {
    id: string;
    phone: string | null;
    current_status: string | null;
    final_intent_score: number | null;
    dealer_name: string | null;
    shop_name: string | null;
};

export type AudienceResult = {
    counts: { hot: number; warm: number; cold: number; all: number };
    excluded: { total: number; byReason: Record<string, number> };
    totalWithPhone: number;
    queueIds: string[];
    queue: AudienceRow[];
};

const NO_CALL_STATUSES = new Set([
    "converted",
    "not_interested",
    "dnc",
    "blacklisted",
]);

// Bucket by the analyzer's measured intent score, not by current_status text.
// Status text drifts across the system ("contacted", "callback_requested", …)
// and most dialed leads landed in WARM regardless of actual quality, which left
// users seeing Hot=0 · Warm=N · Cold=0. Uncalled leads score 0/null → cold,
// which matches the intuition that an uncalled lead is cold.
export function bucketOf(
    score: number | null | undefined,
): "hot" | "warm" | "cold" {
    const s = typeof score === "number" ? score : 0;
    if (s >= INTENT_THRESHOLDS.QUALIFIED) return "hot";
    if (s >= INTENT_THRESHOLDS.WARM) return "warm";
    return "cold";
}

export async function resolveAudience(
    selection: AudienceSelection,
): Promise<AudienceResult> {
    const states = Array.isArray(selection.states)
        ? selection.states.filter((s) => typeof s === "string" && s.trim())
        : [];
    const cities = Array.isArray(selection.cities)
        ? selection.cities.filter(
              (c) =>
                  c &&
                  typeof c.state === "string" &&
                  c.state.trim() &&
                  typeof c.city === "string" &&
                  c.city.trim(),
          )
        : [];
    const pincodes = Array.isArray(selection.pincodes)
        ? selection.pincodes.filter((p) => typeof p === "string" && p.trim())
        : [];
    const groupIds = Array.isArray(selection.groupIds)
        ? selection.groupIds.filter((g) => typeof g === "string" && g)
        : [];

    // Resolve saved groups → fold into states/cities. Empty cities[] on a group
    // entry means "all cities in this state", so promote it to states[].
    if (groupIds.length) {
        const groups = await db
            .select({ regions: regionGroups.regions })
            .from(regionGroups)
            .where(inArray(regionGroups.id, groupIds));
        for (const g of groups) {
            const entries = (g.regions as RegionEntry[] | null) ?? [];
            for (const e of entries) {
                if (!e?.state) continue;
                if (!Array.isArray(e.cities) || e.cities.length === 0) {
                    states.push(e.state);
                } else {
                    for (const c of e.cities) {
                        if (c) cities.push({ state: e.state, city: c });
                    }
                }
            }
        }
    }

    // Region matching uses the SAME canonical-city resolution as
    // /api/dealer-leads/regions/tree (city_aliases → cities → states). An exact
    // text filter (`dealer_leads.city = 'Sonipat'`) misses alias variants
    // ('sonipat', 'SONIPAT', 'Sonepat'). The CTE mirrors the tree exactly, so a
    // city not yet in the canonical seed still buckets by its raw text.
    const wantsRegionFilter =
        states.length > 0 || cities.length > 0 || pincodes.length > 0;

    // JSONB params rather than variadic IN-lists; drizzle parameterises sql``.
    const statesJson = JSON.stringify(states);
    const cityPairsJson = JSON.stringify(
        cities.map((c) => ({ state: c.state, city: c.city })),
    );
    const pincodesJson = JSON.stringify(pincodes);

    const result = await db.execute(sql`
      WITH resolved AS (
        SELECT
          dl.id,
          dl.phone,
          dl.pincode,
          dl.current_status,
          dl.final_intent_score,
          dl.dealer_name,
          dl.shop_name,
          c.name AS canon_city,
          COALESCE(s_from_city.name, s_direct.name) AS canon_state,
          dl.city AS raw_city
        FROM dealer_leads dl
        LEFT JOIN city_aliases ca ON ca.alias_lower = LOWER(TRIM(dl.city))
        LEFT JOIN cities c ON c.id = ca.city_id
        LEFT JOIN states s_from_city ON s_from_city.code = c.state_code
        LEFT JOIN states s_direct ON LOWER(s_direct.name) = LOWER(TRIM(dl.state))
        WHERE dl.phone IS NOT NULL AND dl.phone <> ''
          -- BRD §0.2 — never queue a lead Inside Sales / ASM are working.
          AND ${AI_DIALABLE_SQL}
      ),
      bucketed AS (
        SELECT
          id, phone, pincode, current_status, final_intent_score,
          dealer_name, shop_name,
          COALESCE(canon_state, 'Unknown') AS state_bucket,
          COALESCE(canon_city, NULLIF(INITCAP(TRIM(raw_city)), ''), 'Unknown') AS city_bucket
        FROM resolved
      )
      SELECT id, phone, current_status, final_intent_score, dealer_name, shop_name
      FROM bucketed
      WHERE
        CASE
          WHEN ${wantsRegionFilter} THEN
            state_bucket = ANY(
              SELECT jsonb_array_elements_text(${statesJson}::jsonb)
            )
            OR (
              jsonb_array_length(${cityPairsJson}::jsonb) > 0
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(${cityPairsJson}::jsonb) AS pair
                WHERE pair->>'state' = state_bucket
                  AND pair->>'city' = city_bucket
              )
            )
            OR pincode = ANY(
              SELECT jsonb_array_elements_text(${pincodesJson}::jsonb)
            )
          ELSE TRUE
        END
    `);

    const rows: AudienceRow[] =
        (result as { rows?: AudienceRow[] }).rows ??
        (result as unknown as AudienceRow[]);

    // Tally segments and apply the NO_CALL filter. Track excluded-by-reason so
    // the UI can explain the gap between "total leads with phone" and "dialable
    // leads" (e.g. 53 total vs 49 dialable for Haryana).
    const counts = { hot: 0, warm: 0, cold: 0, all: 0 };
    const excludedByReason: Record<string, number> = {
        converted: 0,
        not_interested: 0,
        dnc: 0,
        blacklisted: 0,
    };
    const dialable: AudienceRow[] = [];
    for (const r of rows) {
        const s = (r.current_status ?? "").toLowerCase().trim();
        if (NO_CALL_STATUSES.has(s)) {
            excludedByReason[s] = (excludedByReason[s] ?? 0) + 1;
            continue;
        }
        const b = bucketOf(r.final_intent_score);
        counts[b] += 1;
        counts.all += 1;
        dialable.push(r);
    }
    const excludedTotal = Object.values(excludedByReason).reduce(
        (a, b) => a + b,
        0,
    );

    const category = selection.category;
    const filtered =
        !category || category === "all"
            ? dialable
            : dialable.filter((r) => bucketOf(r.final_intent_score) === category);

    filtered.sort(
        (a, b) => (b.final_intent_score ?? 0) - (a.final_intent_score ?? 0),
    );

    return {
        counts,
        excluded: { total: excludedTotal, byReason: excludedByReason },
        totalWithPhone: rows.length,
        queueIds: filtered.map((r) => r.id),
        queue: filtered,
    };
}
