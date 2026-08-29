/**
 * The SQL half of the shared queue filters — see ./queueFilters for the shape.
 *
 * ONE BUILDER FOR BOTH QUEUES. The Inside Sales and ASM query builders each
 * assemble their rows, their "Showing 1–N of T" count, their tab badges and now
 * their CSV export from the same fragments; a filter written out four times per
 * dashboard is four chances for the list and the number above it to disagree.
 * That is the drift the ISR builder's own `extraFilters` helper was extracted to
 * stop, and this is the same argument one level up.
 *
 * ⚠ ONLY `dl` IS ASSUMED. The one thing the two queues do not share is which
 * date a range means — the rep asks when a lead ARRIVED, the ASM asks when it is
 * being VISITED — so the date column is passed in by the caller rather than
 * hard-coded here.
 */
import { sql, type SQL } from "drizzle-orm";
import type { QueueFilters } from "./queueFilters";
import type { QueueSort } from "./queueSort";
import { LEAD_STATUS } from "@/lib/lifecycle/transitions";

/** Every field optional and nullable — routes pass whatever the request carried. */
export type QueueFilterInput = Partial<Record<keyof QueueFilters, string | null>>;

/** YYYY-MM-DD, enforced before the value reaches a `::date` cast. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(v: string | null | undefined): string | null {
    const s = (v ?? "").trim();
    return s === "" ? null : s;
}

/**
 * The AND-clauses these filters add. Returns `[]` when nothing is set, so a
 * caller that spreads them into an existing WHERE is unaffected by an empty
 * filter set.
 *
 * @param dateColumn the column a `from`/`to` range applies to, e.g.
 *   sql`dl.created_at`. An expression is fine — the ASM queue ranges over
 *   COALESCE(actual, scheduled) so a logged visit and a planned one both match.
 */
export function queueFilterClauses(f: QueueFilterInput, dateColumn: SQL): SQL[] {
    const parts: SQL[] = [];

    const status = clean(f.status);
    if (status) parts.push(sql` AND dl.lead_status = ${status}`);

    // Lower-cased on BOTH sides. The column is free text with three writers (the
    // AI scorer, the rep's editor, a bulk upload) and "Warm" and "warm" are the
    // same answer to the question being asked.
    const interest = clean(f.interest);
    if (interest) {
        parts.push(sql` AND lower(dl.interest_level) = ${interest.toLowerCase()}`);
    }

    // Exact, not ILIKE: the options come from a DISTINCT over this very column
    // (see the queues' region facets), so a substring match could only ever add
    // rows the user did not pick — "Panipat" quietly also selecting "Panipat
    // Rural".
    const state = clean(f.state);
    if (state) parts.push(sql` AND dl.state = ${state}`);

    const city = clean(f.city);
    if (city) parts.push(sql` AND dl.city = ${city}`);

    const from = clean(f.from);
    if (from && ISO_DATE.test(from)) {
        parts.push(sql` AND ${dateColumn} >= ${from}::date`);
    }

    // INCLUSIVE of the end date, expressed as < next midnight rather than
    // <= the date. `created_at` is a timestamp, so `<= '2026-08-20'::date` means
    // "before 2026-08-20 00:00" and silently excludes everything created ON the
    // day the user picked — the most common way a date filter lies.
    const to = clean(f.to);
    if (to && ISO_DATE.test(to)) {
        parts.push(sql` AND ${dateColumn} < (${to}::date + INTERVAL '1 day')`);
    }

    return parts;
}

/**
 * The state → city tree of the leads a queue actually holds.
 *
 * Shared because both queues need the identical GROUP BY and both must drop the
 * junk: `dealer_leads.state` and `.city` are free text written by scrapers and
 * bulk uploads, and an option list containing "" or "  " offers a filter that
 * matches nothing and cannot be told apart from one that matches everything.
 *
 * @param scope the tab's own WHERE clause, so the options describe the list the
 *   user is looking at rather than every lead in the database.
 * @param joins any joins that `scope` references (the ASM tabs reach into the
 *   latest-visit lateral).
 */
export function regionFacetQuery(scope: SQL, joins: SQL = sql``): SQL {
    return sql`
        SELECT dl.state AS state,
               dl.city  AS city,
               COUNT(*)::text AS n
          FROM dealer_leads dl
          ${joins}
         WHERE ${scope}
           AND dl.state IS NOT NULL
           AND btrim(dl.state) <> ''
         GROUP BY dl.state, dl.city
         ORDER BY dl.state ASC, dl.city ASC NULLS LAST
    `;
}

/** Fold the facet rows into the `[{ state, cities }]` the selects consume. */
export function foldRegionFacets(
    rows: { state: string | null; city: string | null }[],
): { state: string; cities: string[] }[] {
    const byState = new Map<string, Set<string>>();
    for (const r of rows) {
        const state = (r.state ?? "").trim();
        if (!state) continue;
        const cities = byState.get(state) ?? new Set<string>();
        const city = (r.city ?? "").trim();
        // A lead with a state but no city keeps its state in the list — the
        // state filter still selects it, and dropping the state because one of
        // its rows has no city would hide leads from a whole region.
        if (city) cities.add(city);
        byState.set(state, cities);
    }
    return [...byState.entries()]
        .map(([state, cities]) => ({
            state,
            cities: [...cities].sort((a, b) => a.localeCompare(b)),
        }))
        .sort((a, b) => a.state.localeCompare(b.state));
}

// ─── Sort ───────────────────────────────────────────────────────────────────

/**
 * Pipeline order for `dl.lead_status`, as a CASE expression. Alphabetical would
 * put "Awaiting Decision" before "Assigned" — a sort by stage has to follow the
 * stages.
 */
function statusRankSql(): SQL {
    const whens = LEAD_STATUS.map((s, i) => sql`WHEN ${s} THEN ${i}`);
    return sql`(CASE dl.lead_status ${sql.join(whens, sql` `)} ELSE ${LEAD_STATUS.length} END)`;
}

/**
 * Warmth order for `dl.interest_level`. lower() on the column for the same
 * reason the filter lower()s it — three writers, mixed case.
 */
const INTEREST_RANK_SQL = sql`(CASE lower(dl.interest_level)
    WHEN 'cold' THEN 1
    WHEN 'warm' THEN 2
    WHEN 'hot' THEN 3
    WHEN 'order_placed' THEN 4
    ELSE 5 END)`;

/**
 * The ORDER BY for a queue, given the user's sort and the tab's own order.
 *
 * @param sort   validated by readQueueSort — the direction is interpolated
 *               RAW, which is only safe because it is one of two known words.
 * @param tabOrder the tab's default order COLUMNS (no `ORDER BY` keyword),
 *               kept as the tiebreak so rows with the same state/city still
 *               come out in the order the tab was designed around.
 *
 * NULLS LAST in both directions: an unset city is "not sortable", not the
 * first or last name in the alphabet.
 */
export function queueSortOrder(sort: QueueSort | undefined, tabOrder: SQL): SQL {
    if (!sort || !sort.sort) return sql`ORDER BY ${tabOrder}`;
    const dir = sql.raw(sort.dir === "desc" ? "DESC" : "ASC");
    let expr: SQL;
    switch (sort.sort) {
        case "status":
            // The rank never IS NULL (ELSE branch), so an unknown/NULL status
            // sinks by rank rather than by NULLS placement.
            expr = statusRankSql();
            break;
        case "interest":
            expr = INTEREST_RANK_SQL;
            break;
        case "state":
            expr = sql`NULLIF(btrim(dl.state), '')`;
            break;
        case "city":
            expr = sql`NULLIF(btrim(dl.city), '')`;
            break;
    }
    return sql`ORDER BY ${expr} ${dir} NULLS LAST, ${tabOrder}`;
}
