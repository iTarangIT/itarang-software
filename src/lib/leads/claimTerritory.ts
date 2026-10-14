/**
 * Tracker ID 45 — where an ASM's claim sits against the ASM's territory
 * (asm_territories, Admin › Settings › Territories). One rule for the claim
 * itself (claimLead marks the touchpoint) and for the Sales Head's "Claimed
 * outside territory" card, which re-reads it against TODAY's territories so
 * setting one up clears the claims it covers.
 *
 *   territory_not_set  the ASM has no active territory row — nothing to be
 *                      outside of; a configuration gap, not a stray claim
 *   no_location        the lead has no state (or no city, where the ASM's only
 *                      rows in that state are city-level) — cannot be placed
 *   in                 the lead's state (and city, for a city-level row) match
 *   outside            everything else — the claims the card is for
 *
 * Matching is exact on state / city, as the claim search and the ASM queue's
 * territory tabs match (src/app/api/leads/claim-search, lib/asm/queryBuilder).
 */
import { sql, type SQL } from "drizzle-orm";

export const CLAIM_TERRITORY_STATUSES = ["territory_not_set", "no_location", "in", "outside"] as const;
export type ClaimTerritoryStatus = (typeof CLAIM_TERRITORY_STATUSES)[number];

/** Markers written into the claim touchpoint's remarks. "[outside territory]" predates the others. */
export const CLAIM_TERRITORY_MARKER: Record<Exclude<ClaimTerritoryStatus, "in">, string> = {
    outside: "[outside territory]",
    no_location: "[no location]",
    territory_not_set: "[territory not set]",
};

/**
 * The status as a SQL text scalar. `asmId` is the claimer (text), `dl` the
 * dealer_leads alias. Its own alias is `cterr`, so callers may use `t`.
 */
export function claimTerritoryStatusSql(asmId: SQL, dl: SQL = sql`dl`): SQL {
    const active = sql`(cterr.active_from IS NULL OR cterr.active_from <= CURRENT_DATE)
                   AND (cterr.active_to IS NULL OR cterr.active_to >= CURRENT_DATE)`;
    return sql`(CASE
        WHEN NOT EXISTS (SELECT 1 FROM asm_territories cterr WHERE cterr.asm_id = ${asmId} AND ${active})
            THEN 'territory_not_set'
        WHEN NULLIF(trim(${dl}.state), '') IS NULL
            THEN 'no_location'
        WHEN EXISTS (SELECT 1 FROM asm_territories cterr
                      WHERE cterr.asm_id = ${asmId} AND ${active}
                        AND cterr.state = ${dl}.state AND (cterr.city IS NULL OR cterr.city = ${dl}.city))
            THEN 'in'
        WHEN NULLIF(trim(${dl}.city), '') IS NULL
             AND EXISTS (SELECT 1 FROM asm_territories cterr
                          WHERE cterr.asm_id = ${asmId} AND ${active} AND cterr.state = ${dl}.state)
            THEN 'no_location'
        ELSE 'outside'
    END)`;
}
