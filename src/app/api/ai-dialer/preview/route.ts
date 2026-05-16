/**
 * POST /api/ai-dialer/preview
 *
 * Server-side replacement for the modal's old client-side
 * "fetch 500 leads, filter in browser" path. Accepts a region selection
 * (loose states, specific state+city pairs, pincodes, saved group IDs)
 * plus an optional segment category, and returns the bucketed counts
 * (hot/warm/cold/all) plus the queue of dealer_leads.id values to dial.
 *
 * The returned queueIds is what the modal hands to /api/ai-dialer/start,
 * so the modal's "Start dialing" button doesn't need to know anything
 * about the underlying lead set — preview is the source of truth.
 *
 * Region resolution:
 *  - groupIds  → resolved to the union of their `regions` jsonb arrays.
 *  - states[]  → match any row in that state (no city constraint).
 *  - cities[]  → match {state, city} pairs exactly.
 *  - pincodes[] → match any row with that pincode.
 *  Empty selection (no filters) matches every callable lead.
 *
 * Status buckets mirror the modal's bucketOf() logic exactly, so the
 * counts the user sees can't drift from the client.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { regionGroups } from "@/lib/db/schema";
import { inArray, sql } from "drizzle-orm";

type RegionEntry = { state: string; cities?: string[] };

const NO_CALL_STATUSES = new Set(["converted", "not_interested", "dnc", "blacklisted"]);

// Bucket leads by the analyzer's measured intent score, not by current_status
// text. Status text drifts across the system ("contacted", "callback_requested",
// etc.) and most dialed leads landed in WARM regardless of actual quality,
// which left users seeing Hot=0 · Warm=N · Cold=0. Score-based buckets match
// what the analyzer measured and align with getLeadStatus() and the visual
// badge thresholds (≥75 = qualified/hot). Uncalled leads have score = 0/null
// → cold, which matches the user's intuition that an uncalled lead is cold.
function bucketOf(score: number | null | undefined): "hot" | "warm" | "cold" {
  const s = typeof score === "number" ? score : 0;
  if (s >= 75) return "hot";
  if (s >= 40) return "warm";
  return "cold";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      states: rawStates,
      cities: rawCities,
      pincodes: rawPincodes,
      groupIds: rawGroupIds,
      category,
    }: {
      states?: string[];
      cities?: { state: string; city: string }[];
      pincodes?: string[];
      groupIds?: string[];
      category?: "hot" | "warm" | "cold" | "all";
    } = body ?? {};

    const states = Array.isArray(rawStates) ? rawStates.filter((s) => typeof s === "string" && s.trim()) : [];
    const cities = Array.isArray(rawCities)
      ? rawCities.filter(
          (c) =>
            c && typeof c.state === "string" && c.state.trim() &&
            typeof c.city === "string" && c.city.trim(),
        )
      : [];
    const pincodes = Array.isArray(rawPincodes) ? rawPincodes.filter((p) => typeof p === "string" && p.trim()) : [];
    const groupIds = Array.isArray(rawGroupIds) ? rawGroupIds.filter((g) => typeof g === "string" && g) : [];

    // Resolve saved groups → fold into states/cities. Empty cities[] on a
    // group entry means "all cities in this state", so we promote it to
    // states[] instead of cities[].
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
    // /api/dealer-leads/regions/tree (city_aliases → cities → states). The
    // old exact-text filter (`dealer_leads.city = 'Sonipat'`) missed
    // alias-variant raw values ('sonipat', 'SONIPAT', 'Sonepat'), so the
    // tree showed Sonipat=53 but the dialer queued only 49. Filtering by
    // the canonical bucket closes that gap.
    //
    // The CTE mirrors the tree exactly: COALESCE(canon_state, 'Unknown')
    // and COALESCE(canon_city, INITCAP(TRIM(raw_city)), 'Unknown') so a
    // city not yet in the canonical seed still buckets by its raw text.
    const wantsRegionFilter =
      states.length > 0 || cities.length > 0 || pincodes.length > 0;

    // Build the JSON arrays for the filter as PostgreSQL params (safe from
    // injection — drizzle parameterizes via sql``). Using JSONB ANY()
    // matches without needing to expand variadic IN-lists.
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

    type PreviewRow = {
      id: string;
      phone: string | null;
      current_status: string | null;
      final_intent_score: number | null;
      dealer_name: string | null;
      shop_name: string | null;
    };
    const rows: PreviewRow[] =
      (result as { rows?: PreviewRow[] }).rows ??
      (result as unknown as PreviewRow[]);

    // Tally segments and apply the same NO_CALL filter the modal used to
    // apply client-side. Sort by intent score descending — hot leads dial
    // first within the chosen category. Track excluded-by-reason so the
    // UI can explain the gap between "total leads with phone" and
    // "dialable leads" (e.g. 53 total vs 49 dialable for Haryana).
    const counts = { hot: 0, warm: 0, cold: 0, all: 0 };
    const excludedByReason: Record<string, number> = {
      converted: 0,
      not_interested: 0,
      dnc: 0,
      blacklisted: 0,
    };
    const dialable = [] as typeof rows;
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

    const filtered = (() => {
      if (!category || category === "all") return dialable;
      return dialable.filter((r) => bucketOf(r.final_intent_score) === category);
    })();

    filtered.sort(
      (a, b) => (b.final_intent_score ?? 0) - (a.final_intent_score ?? 0),
    );

    return NextResponse.json({
      success: true,
      counts,
      excluded: {
        total: excludedTotal,
        byReason: excludedByReason,
      },
      totalWithPhone: rows.length,
      queueIds: filtered.map((r) => r.id),
      queue: filtered.map((r) => ({
        id: r.id,
        phone: r.phone,
        dealer_name: r.dealer_name,
        shop_name: r.shop_name,
        final_intent_score: r.final_intent_score,
        current_status: r.current_status,
      })),
    });
  } catch (err: any) {
    console.error("[AI DIALER] preview error:", err);
    return NextResponse.json(
      { success: false, error: err.message ?? "Preview failed" },
      { status: 500 },
    );
  }
}
