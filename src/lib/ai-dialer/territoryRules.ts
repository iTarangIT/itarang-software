// Territory routing — the pure parts (no database), so they can be unit-tested.
// src/lib/ai-dialer/territoryRouting.ts does the I/O.
//
// The rule, as decided with the business (2 Nov 2026):
//   · A lead the AI dialer qualified, or that agreed to a callback / asked for
//     a person, goes to the ASM whose territory covers the lead's place.
//     Complaints are not routed (they stay with the ISR / admin flow).
//   · A city mapping (Patna, Bihar) beats a whole-state mapping (Bihar).
//   · Several ASMs still tied → they take turns: whoever got a territory lead
//     longest ago (never = first) goes next.
//   · Nobody covers the place, or the lead has no state → the caller falls back
//     to the ISR round-robin (E-362 callback owners).

import type { CallbackKind } from "./callbackBrief";

export type RouteRule = "territory_city" | "territory_state" | "isr_round_robin" | "unassigned";

/** One asm_territories row that matched the lead's state, joined to its active ASM. */
export type TerritoryCandidate = {
    asmId: string;
    name: string | null;
    territoryId: string;
    /** NULL = the mapping covers the whole state. */
    territoryCity: string | null;
    /** The ASM's last territory-routed lead (lead_route_log), ISO; null = never. */
    lastRoutedAt: string | null;
};

/** Routing applies to everything except complaints. */
export function routingApplies(kind: CallbackKind): boolean {
    return kind === "qualified" || kind === "sales";
}

/** Case / whitespace-insensitive key for comparing place names. */
export function placeKey(s: string | null | undefined): string {
    return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Keep the best-ranked candidates for this city: city mappings that name one of
 * the lead's city spellings beat whole-state mappings. An ASM with both a city
 * row and a state row counts once, at the city rank. Rows naming a different
 * city are dropped (the SQL already filters them; this is the safety net).
 */
export function rankCandidates(
    candidates: TerritoryCandidate[],
    cityKeys: string[],
): { rule: "territory_city" | "territory_state" | null; tied: TerritoryCandidate[] } {
    const keys = new Set(cityKeys.map(placeKey).filter(Boolean));
    const cityRows = candidates.filter((c) => c.territoryCity && keys.has(placeKey(c.territoryCity)));
    const stateRows = candidates.filter((c) => !c.territoryCity || !placeKey(c.territoryCity));
    const pick = cityRows.length > 0 ? cityRows : stateRows;
    const rule = cityRows.length > 0 ? "territory_city" : stateRows.length > 0 ? "territory_state" : null;
    const seen = new Set<string>();
    const tied: TerritoryCandidate[] = [];
    for (const c of pick) {
        if (seen.has(c.asmId)) continue;
        seen.add(c.asmId);
        tied.push(c);
    }
    return { rule, tied };
}

/**
 * Turn order among tied ASMs: never-routed first, then the one whose last
 * territory lead is oldest; name, then id, break exact ties so the order is
 * stable.
 */
export function orderInTurn(tied: TerritoryCandidate[]): TerritoryCandidate[] {
    const t = (c: TerritoryCandidate) => (c.lastRoutedAt ? new Date(c.lastRoutedAt).getTime() : -Infinity);
    return [...tied].sort(
        (a, b) =>
            t(a) - t(b) ||
            (a.name ?? "").localeCompare(b.name ?? "") ||
            a.asmId.localeCompare(b.asmId),
    );
}

/** The place words for a human ("Patna", "Bihar"). */
export function placeLabel(state: string | null, city: string | null, rule: RouteRule): string {
    if (rule === "territory_city" && city) return city;
    return state ?? city ?? "";
}
