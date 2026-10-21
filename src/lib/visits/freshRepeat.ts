/**
 * Fresh / Repeat / New-to-iTarang visits (tracker ID 185) — the ONE
 * definition every screen, email and download uses.
 *
 * A VISIT is one person at one dealer on one IST day (VISIT_KEY), counting
 * ONLY lead_visits rows with visit_status = 'visited' (user decision, 21 Oct:
 * a scheduled, cancelled or no-show row is not a visit even when it carries
 * an actual_visit_date). Then:
 *
 *   New to iTarang   the dealer's first visit by ANYONE, ever (`fv`).
 *   Fresh            this person's first visit to this dealer, ever (`rv`) —
 *                    the rep's basis; a dealer new to iTarang is also fresh.
 *   Repeat           any later visit by the same person: visits − fresh.
 *
 * "Ever" means over the WHOLE table, not the report window: a first visit is
 * a property of the dealer (or the pair), not of the range being looked at.
 * Because Fresh, Repeat and the visit count all use VISITED_ROW, Fresh +
 * Repeat = Visits holds wherever they are shown together. (Targets "Dealer
 * visits" keeps its own rule — decided 21 Oct.)
 *
 * Usage, in a query over `lead_visits v`:
 *
 *     WITH ${freshRepeatCtes()},
 *          vis AS (SELECT v.asm_id, v.dealer_lead_id, v.actual_visit_date,
 *                         ${isNewToItarangSql()} AS is_new, ${isFreshSql()} AS is_fresh
 *                    FROM lead_visits v ${freshRepeatJoins()}
 *                   WHERE ${visitedRowSql()} AND …)
 *
 * Server-side SQL plus a few pure helpers (no I/O): client-safe to import.
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * One visit = one person, one dealer, one IST day. Counted as
 * COUNT(DISTINCT VISIT_KEY) over a CTE exposing asm_id / dealer_lead_id /
 * actual_visit_date.
 */
export const VISIT_KEY = sql`(asm_id, dealer_lead_id, actual_visit_date)`;

/** The status a lead_visits row must have to count as a visit (ID 185). */
export const VISITED_STATUS = "visited";

/** `<alias>.visit_status = 'visited' AND <alias>.actual_visit_date IS NOT NULL` — a row that is a visit. */
export function visitedRowSql(alias = "v"): SQL {
    return sql.raw(`${alias}.visit_status = '${VISITED_STATUS}' AND ${alias}.actual_visit_date IS NOT NULL`);
}

/** Subquery body: each dealer's first visited day by anyone — columns dealer_lead_id, first_d. */
export const FIRST_VISIT_BY_ANYONE_SQL: SQL = sql`
    SELECT dealer_lead_id, MIN(actual_visit_date) AS first_d
      FROM lead_visits
     WHERE visit_status = 'visited' AND actual_visit_date IS NOT NULL
     GROUP BY dealer_lead_id`;

/** Subquery body: each person's first visited day at each dealer — columns asm_id, dealer_lead_id, first_d. */
export const FIRST_VISIT_BY_REP_SQL: SQL = sql`
    SELECT asm_id, dealer_lead_id, MIN(actual_visit_date) AS first_d
      FROM lead_visits
     WHERE visit_status = 'visited' AND actual_visit_date IS NOT NULL
     GROUP BY asm_id, dealer_lead_id`;

/** `fv AS (…), rv AS (…)` — the two CTEs, to splice after WITH (add a comma before your own CTEs). */
export function freshRepeatCtes(): SQL {
    return sql`fv AS (${FIRST_VISIT_BY_ANYONE_SQL}),
        rv AS (${FIRST_VISIT_BY_REP_SQL})`;
}

/**
 * The LEFT JOINs onto fv / rv for a visit alias. With `inline`, the subqueries
 * are written in place (for a query that cannot take a WITH, e.g. one SELECT
 * inside a UNION).
 */
export function freshRepeatJoins(alias = "v", inline = false): SQL {
    const fv = inline ? sql`(${FIRST_VISIT_BY_ANYONE_SQL})` : sql`fv`;
    const rv = inline ? sql`(${FIRST_VISIT_BY_REP_SQL})` : sql`rv`;
    const v = sql.raw(alias);
    return sql`LEFT JOIN ${fv} fv ON fv.dealer_lead_id = ${v}.dealer_lead_id
              LEFT JOIN ${rv} rv ON rv.dealer_lead_id = ${v}.dealer_lead_id AND rv.asm_id IS NOT DISTINCT FROM ${v}.asm_id`;
}

/** This visit was the dealer's first by anyone ("New to iTarang"). Needs freshRepeatJoins. */
export function isNewToItarangSql(alias = "v"): SQL {
    return sql`(${sql.raw(alias)}.actual_visit_date = fv.first_d)`;
}

/** This visit was this person's first to the dealer ("Fresh"). Needs freshRepeatJoins. */
export function isFreshSql(alias = "v"): SQL {
    return sql`(${sql.raw(alias)}.actual_visit_date = rv.first_d)`;
}

/** A later visit by the same person ("Repeat"). Needs freshRepeatJoins. */
export function isRepeatSql(alias = "v"): SQL {
    return sql`(${sql.raw(alias)}.actual_visit_date > rv.first_d)`;
}

/** 'new' | 'fresh' | 'repeat' as SQL text, for detail columns. Needs freshRepeatJoins. */
export function visitKindSql(alias = "v"): SQL {
    return sql`(CASE WHEN ${isNewToItarangSql(alias)} THEN 'new' WHEN ${isFreshSql(alias)} THEN 'fresh' ELSE 'repeat' END)`;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export type VisitKind = "new" | "fresh" | "repeat";

/** Labels as the screens and downloads print them. */
export const VISIT_KIND_LABEL: Record<VisitKind, string> = {
    new: "New to iTarang",
    fresh: "Fresh (first visit by this person)",
    repeat: "Repeat",
};

/** The kind of one visit from its flags. A dealer new to iTarang is also the person's first, so "new" wins. */
export function visitKind(isNew: boolean | null | undefined, isFresh: boolean | null | undefined): VisitKind {
    if (isNew) return "new";
    if (isFresh) return "fresh";
    return "repeat";
}

/** Repeat visits = visits − fresh, never negative. */
export function repeatVisits(visits: number, fresh: number): number {
    return Math.max(0, (visits || 0) - (fresh || 0));
}

/** The Fresh / Repeat split of a visit count, with "of which new to iTarang". */
export function freshRepeatSplit(t: { visits: number; fresh_visits: number; new_visits?: number }): {
    visits: number;
    fresh: number;
    repeat: number;
    new_to_itarang: number | null;
} {
    const fresh = Math.min(t.fresh_visits || 0, t.visits || 0);
    return { visits: t.visits || 0, fresh, repeat: repeatVisits(t.visits, fresh), new_to_itarang: t.new_visits ?? null };
}
