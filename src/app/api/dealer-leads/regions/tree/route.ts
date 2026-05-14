/**
 * GET /api/dealer-leads/regions/tree
 *
 * Returns the state → city tree of every dialable dealer_leads row
 * (non-empty phone), with lead counts at each level. Used by the AI
 * dialer modal's region selector to populate cascading dropdowns and
 * show "Uttar Pradesh (842) > Ghaziabad (320)" style counts.
 *
 * Canonicalization (E-108): dealer_leads.city / .state are joined against
 * the city_aliases / cities / states reference tables. Junk values
 * ("MARS Mysore Auto Rickshaw Service", "M28", "KRS Rd") that don't
 * resolve to a canonical city collapse under "Unknown" for that state.
 * Aliases (Mysore→Mysuru, Bangalore→Bengaluru, Bombay→Mumbai) resolve to
 * the canonical name, so users see one bucket per real city regardless
 * of the spelling the scraper happened to write.
 *
 * Rows whose state ALSO can't be resolved bucket under Unknown/Unknown —
 * the dialer can still target them as "everything unmapped" if needed.
 *
 * Implementation note: COALESCE/NULLIF expressions referenced in GROUP BY
 * need to use the column aliases, which Drizzle's chained .groupBy() can't
 * express cleanly. Raw SQL keeps SELECT and GROUP BY consistent.
 */

import { db } from "@/lib/db";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { sql } from "drizzle-orm";

export const UNKNOWN_STATE = "Unknown";
export const UNKNOWN_CITY = "Unknown";

interface RawRow {
  state: string;
  city: string;
  count: number;
  pincode_count: number;
}

export const GET = withErrorHandler(async () => {
  const result = await db.execute(sql`
    WITH resolved AS (
      SELECT
        dl.pincode,
        -- Canonical city via the alias table. dl.city of "Bangalore",
        -- "bengaluru", or "BLR" all resolve to the same cities row.
        -- Junk values (e.g. "MARS Mysore Auto Rickshaw Service", "M28")
        -- don't match any alias_lower and leave canon_city NULL.
        c.name AS canon_city,
        -- Prefer the state derived from the canonical city's FK so
        -- "Bengaluru" always lands under Karnataka even if dl.state was
        -- corrupted. Fall back to a direct dl.state alias match.
        COALESCE(s_from_city.name, s_direct.name) AS canon_state
      FROM dealer_leads dl
      LEFT JOIN city_aliases ca ON ca.alias_lower = LOWER(TRIM(dl.city))
      LEFT JOIN cities c ON c.id = ca.city_id
      LEFT JOIN states s_from_city ON s_from_city.code = c.state_code
      LEFT JOIN states s_direct ON LOWER(s_direct.name) = LOWER(TRIM(dl.state))
      WHERE dl.phone IS NOT NULL AND dl.phone <> ''
    )
    SELECT
      state_bucket AS state,
      city_bucket  AS city,
      COUNT(*)::int AS count,
      COUNT(DISTINCT pincode)::int AS pincode_count
    FROM (
      SELECT
        COALESCE(canon_state, ${UNKNOWN_STATE}) AS state_bucket,
        COALESCE(canon_city,  ${UNKNOWN_CITY})  AS city_bucket,
        pincode
      FROM resolved
    ) buckets
    GROUP BY state_bucket, city_bucket
    ORDER BY COUNT(*) DESC
  `);

  // postgres-js returns rows on the result itself (it's an array-like).
  // Normalize so this works whether we get an array or a {rows} wrapper.
  const rows: RawRow[] =
    (result as any).rows ?? (result as unknown as RawRow[]);

  // Collapse flat rows into the nested state → cities[] shape consumed
  // by the region selector. Sort by total leads descending so the most
  // populated state lands at the top.
  const byState = new Map<
    string,
    {
      state: string;
      leadCount: number;
      cities: { city: string; leadCount: number; pincodeCount: number }[];
    }
  >();

  for (const r of rows) {
    let entry = byState.get(r.state);
    if (!entry) {
      entry = { state: r.state, leadCount: 0, cities: [] };
      byState.set(r.state, entry);
    }
    entry.leadCount += r.count;
    entry.cities.push({
      city: r.city,
      leadCount: r.count,
      pincodeCount: r.pincode_count,
    });
  }

  const tree = Array.from(byState.values()).sort(
    (a, b) => b.leadCount - a.leadCount,
  );
  for (const s of tree) {
    s.cities.sort((a, b) => b.leadCount - a.leadCount);
  }

  return successResponse(tree);
});
