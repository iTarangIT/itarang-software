// AI dialer → the area ASM. When the AI dialer qualifies a lead (or the dealer
// agrees to a callback / asks for a person) and nobody owns it yet, the lead
// goes to the ASM whose territory (asm_territories, E-118) covers its city.
// The rules are in territoryRules.ts; this file reads the lead, finds the
// candidates, picks one in turn and records the decision (lead_route_log,
// E-367). callbackLoop.handOffToOwner() calls it and does the assignment.
//
// Safe in every state of the database:
//   · switch off (app_settings['territory_routing'], ships OFF) → no routing;
//   · no E-367 → routing still works, tied ASMs are taken by name, no log;
//   · no city_aliases (E-108) → the lead's city is matched as written.
// Never throws: a failure here means the lead goes to the ISR round-robin.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { inferStateFromCity, normalizeCity, normalizeState } from "@/lib/scraper-enrichment";
import type { CallbackKind } from "./callbackBrief";
import {
    orderInTurn,
    placeKey,
    rankCandidates,
    routingApplies,
    type RouteRule,
    type TerritoryCandidate,
} from "./territoryRules";

export const TERRITORY_ROUTING_SETTINGS_KEY = "territory_routing";

function rows<T>(r: unknown): T[] {
    return ((r as { rows?: T[] }).rows ?? (r as T[])) || [];
}

// ── Settings ────────────────────────────────────────────────────────────────

export type TerritoryRoutingSettings = {
    /** Route AI-qualified leads and callbacks to the area ASM. Ships OFF. */
    enabled: boolean;
    updatedBy: string | null;
    updatedAt: string | null;
};

export async function getTerritoryRoutingSettings(): Promise<TerritoryRoutingSettings> {
    try {
        const r = rows<{ value: Record<string, unknown> | null; updated_at: string | null }>(
            await db.execute(sql`
                SELECT value, updated_at::text AS updated_at FROM app_settings
                 WHERE key = ${TERRITORY_ROUTING_SETTINGS_KEY} LIMIT 1
            `),
        )[0];
        const v = r?.value ?? {};
        return {
            enabled: v.enabled === true,
            updatedBy: typeof v.updated_by === "string" ? v.updated_by : null,
            updatedAt: r?.updated_at ?? null,
        };
    } catch {
        return { enabled: false, updatedBy: null, updatedAt: null };
    }
}

export async function setTerritoryRoutingSettings(input: {
    enabled: boolean;
    updatedBy: string;
}): Promise<TerritoryRoutingSettings> {
    const value = { enabled: input.enabled, updated_by: input.updatedBy };
    const now = new Date();
    await db
        .insert(appSettings)
        .values({ key: TERRITORY_ROUTING_SETTINGS_KEY, value, updated_at: now })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_at: now } });
    return getTerritoryRoutingSettings();
}

// ── Probe ───────────────────────────────────────────────────────────────────

let probe: { at: number; ok: boolean } | null = null;
/** E-367 applied here? */
export async function hasRouteLog(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.ok;
    let ok = false;
    try {
        ok = Boolean(
            rows<{ ok: boolean }>(
                await db.execute(sql`SELECT to_regclass('public.lead_route_log') IS NOT NULL AS ok`),
            )[0]?.ok,
        );
    } catch {
        ok = false;
    }
    probe = { at: Date.now(), ok };
    return ok;
}

// ── The lead's place ────────────────────────────────────────────────────────

export type LeadPlace = {
    /** Canonical state name, or null when it could not be worked out. */
    state: string | null;
    /** Canonical city name (for display / the log). */
    city: string | null;
    /** Every spelling of the city to match territory rows against. */
    cityKeys: string[];
};

/** The canonical city + its state from the E-108 alias table; null when absent. */
async function aliasLookup(raw: string): Promise<{ city: string; state: string | null } | null> {
    try {
        const r = rows<{ city: string; state: string | null }>(
            await db.execute(sql`
                SELECT c.name AS city, s.name AS state
                  FROM cities c
                  LEFT JOIN states s ON s.code = c.state_code
                 WHERE c.id = (SELECT a.city_id FROM city_aliases a WHERE a.alias_lower = ${placeKey(raw)} LIMIT 1)
                    OR lower(c.name) = ${placeKey(raw)}
                 LIMIT 1
            `),
        )[0];
        return r ?? null;
    } catch {
        return null;
    }
}

/**
 * Work out a lead's state + city from what dealer_leads holds. The city goes
 * through the same normalisers every lead writer uses, then the DB alias table
 * (so "Bangalore" also matches a "Bengaluru" territory). A missing state is
 * inferred from the city.
 */
export async function resolveLeadPlace(raw: {
    state: string | null;
    city: string | null;
    location: string | null;
}): Promise<LeadPlace> {
    const rawCity = (raw.city ?? "").trim() || (raw.location ?? "").trim() || null;
    const city = rawCity ? normalizeCity(rawCity) ?? rawCity : null;
    const alias = city ? await aliasLookup(city) : null;
    const state =
        normalizeState(raw.state?.trim() || undefined) ??
        alias?.state ??
        inferStateFromCity(alias?.city ?? city) ??
        null;
    const cityKeys = [...new Set([rawCity, city, alias?.city].map(placeKey).filter(Boolean))];
    return { state: state || null, city: alias?.city ?? city, cityKeys };
}

/**
 * Canonical state + city for an asm_territories row, so admin typing ("bihar ",
 * "Bangalore") matches what the lead writers store. `unknownState` is true when
 * the states master (E-108) exists and does not know the state — the caller
 * refuses it, since a misspelt state would silently never match a lead.
 */
export async function canonicalTerritoryPlace(input: {
    state: string;
    city: string | null;
}): Promise<{ state: string; city: string | null; unknownState: boolean }> {
    const place = await resolveLeadPlace({ state: input.state, city: input.city, location: null });
    const state = place.state ?? input.state.trim();
    const city = input.city?.trim() ? place.city ?? input.city.trim() : null;
    let unknownState = false;
    try {
        const r = rows<{ name: string }>(
            await db.execute(sql`
                SELECT name FROM states
                 WHERE lower(name) = ${placeKey(state)} OR lower(code) = ${placeKey(state)}
                 LIMIT 1
            `),
        );
        if (r[0]) return { state: r[0].name, city, unknownState: false };
        const any = rows<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM states`));
        unknownState = Number(any[0]?.n) > 0;
    } catch {
        unknownState = false; // no states master here — accept as typed
    }
    return { state, city, unknownState };
}

/** Other active ASMs already covering exactly this state + city (for the "shared in turn" warning). */
export async function overlappingAsms(input: {
    state: string;
    city: string | null;
    exceptAsmId: string;
    exceptTerritoryId?: string | null;
}): Promise<string[]> {
    try {
        const r = rows<{ name: string | null }>(
            await db.execute(sql`
                SELECT DISTINCT COALESCE(u.name, u.email) AS name
                  FROM asm_territories t
                  JOIN users u ON u.id::text = t.asm_id
                 WHERE u.is_active = TRUE AND t.asm_id <> ${input.exceptAsmId}
                   AND (${input.exceptTerritoryId ?? null}::text IS NULL OR t.territory_id::text <> ${input.exceptTerritoryId ?? null})
                   AND lower(trim(t.state)) = ${placeKey(input.state)}
                   AND lower(trim(COALESCE(t.city, ''))) = ${placeKey(input.city)}
                   AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
            `),
        );
        return r.map((x) => x.name ?? "another ASM");
    } catch {
        return [];
    }
}

// ── Routing ─────────────────────────────────────────────────────────────────

type Executor = { execute: (query: SQL) => Promise<unknown> };

/**
 * Every active ASM territory row that could cover this place: same state, and
 * either the whole state or one of the lead's city spellings. Read-only — the
 * verify script calls it too. `logged` adds each ASM's last territory lead
 * (the turn order), which needs E-367.
 */
export async function findTerritoryCandidates(
    exec: Executor,
    place: LeadPlace,
    logged: boolean,
): Promise<TerritoryCandidate[]> {
    if (!place.state) return [];
    const cityKeys = place.cityKeys.length > 0 ? place.cityKeys : [""];
    const lastRouted = logged
        ? sql`(SELECT max(l.created_at)::text FROM lead_route_log l
                WHERE l.chosen_user_id = u.id::text
                  AND l.rule IN ('territory_city', 'territory_state'))`
        : sql`NULL::text`;
    const found = rows<{
        asm_id: string;
        name: string | null;
        territory_id: string;
        territory_city: string | null;
        last_routed_at: string | null;
    }>(
        await exec.execute(sql`
            SELECT u.id::text AS asm_id, u.name, t.territory_id::text AS territory_id,
                   NULLIF(trim(t.city), '') AS territory_city,
                   ${lastRouted} AS last_routed_at
              FROM asm_territories t
              JOIN users u ON u.id::text = t.asm_id
             WHERE LOWER(u.role) = 'asm' AND u.is_active = TRUE
               AND lower(trim(t.state)) = ${placeKey(place.state)}
               AND (NULLIF(trim(t.city), '') IS NULL
                    OR lower(trim(t.city)) IN (${sql.join(cityKeys.map((k) => sql`${k}`), sql`, `)}))
               AND (t.active_from IS NULL OR t.active_from <= CURRENT_DATE)
               AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
        `),
    );
    return found.map((r) => ({
        asmId: r.asm_id,
        name: r.name,
        territoryId: r.territory_id,
        territoryCity: r.territory_city,
        lastRoutedAt: r.last_routed_at,
    }));
}

export type RouteDecision = {
    /** The ASM the lead should go to, or null → fall back to the ISRs. */
    target: { id: string; name: string | null; role: string } | null;
    rule: "territory_city" | "territory_state" | null;
    place: LeadPlace | null;
    territoryId: string | null;
    /** The lead_route_log row that claimed this turn (null without E-367). */
    logId: string | null;
    /** Why there is no target — for the logs. */
    skipped?: "off" | "complaint" | "no_lead" | "no_location" | "no_territory" | "error";
};

const NONE = (skipped: RouteDecision["skipped"], place: LeadPlace | null = null): RouteDecision => ({
    target: null,
    rule: null,
    place,
    territoryId: null,
    logId: null,
    skipped,
});

/**
 * Pick the ASM for an unowned lead. The pick and its log row happen in one
 * transaction under an advisory lock on the place, so two calls finishing
 * together for Patna cannot both land on the same ASM. Never throws.
 */
export async function routeToTerritoryAsm(input: {
    leadId: string;
    kind: CallbackKind;
}): Promise<RouteDecision> {
    try {
        if (!routingApplies(input.kind)) return NONE("complaint");
        if (!(await getTerritoryRoutingSettings()).enabled) return NONE("off");

        const lead = rows<{ state: string | null; city: string | null; location: string | null }>(
            await db.execute(sql`
                SELECT state, city, location FROM dealer_leads WHERE id = ${input.leadId}
            `),
        )[0];
        if (!lead) return NONE("no_lead");
        const place = await resolveLeadPlace(lead);
        if (!place.state) return NONE("no_location", place);

        const logged = await hasRouteLog();

        return await db.transaction(async (tx) => {
            await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtext(${`asm-route:${placeKey(place.state)}|${placeKey(place.city)}`}))`,
            );
            const candidates = await findTerritoryCandidates(tx, place, logged);
            const { rule, tied } = rankCandidates(candidates, place.cityKeys);
            const chosen = orderInTurn(tied)[0];
            if (!rule || !chosen) return NONE("no_territory", place);

            let logId: string | null = null;
            if (logged) {
                logId =
                    rows<{ id: string }>(
                        await tx.execute(sql`
                            INSERT INTO lead_route_log
                                (lead_id, kind, rule, state, city, territory_id, chosen_user_id, candidates)
                            VALUES (${input.leadId}, ${input.kind}, ${rule}, ${place.state}, ${place.city},
                                    ${chosen.territoryId}::uuid, ${chosen.asmId},
                                    ${JSON.stringify(tied.map((t) => ({ id: t.asmId, name: t.name, last: t.lastRoutedAt })))}::jsonb)
                            RETURNING id::text AS id
                        `),
                    )[0]?.id ?? null;
            }
            return {
                target: { id: chosen.asmId, name: chosen.name, role: "asm" },
                rule,
                place,
                territoryId: chosen.territoryId,
                logId,
            };
        });
    } catch (e) {
        console.warn("[territoryRouting] route failed:", e instanceof Error ? e.message : e);
        return NONE("error");
    }
}

/** The ASM pick did not stick (the assignment was refused): give the turn back. */
export async function discardRoute(logId: string | null): Promise<void> {
    if (!logId) return;
    try {
        await db.execute(sql`DELETE FROM lead_route_log WHERE id = ${logId}::uuid`);
    } catch {
        /* the log is advisory */
    }
}

/** Record a non-territory outcome (ISR fallback / nobody) for the audit + "Not covered" list. */
export async function logRoute(input: {
    leadId: string;
    kind: CallbackKind;
    rule: Extract<RouteRule, "isr_round_robin" | "unassigned">;
    place: LeadPlace | null;
    chosenUserId: string | null;
}): Promise<void> {
    if (!routingApplies(input.kind)) return;
    try {
        if (!(await getTerritoryRoutingSettings()).enabled) return;
        if (!(await hasRouteLog())) return;
        await db.execute(sql`
            INSERT INTO lead_route_log (lead_id, kind, rule, state, city, chosen_user_id)
            VALUES (${input.leadId}, ${input.kind}, ${input.rule},
                    ${input.place?.state ?? null}, ${input.place?.city ?? null}, ${input.chosenUserId})
        `);
    } catch (e) {
        console.warn("[territoryRouting] log failed:", e instanceof Error ? e.message : e);
    }
}

// ── Admin reads ─────────────────────────────────────────────────────────────

export type RouteLogRow = {
    id: string;
    lead_id: string;
    lead_name: string | null;
    kind: string;
    rule: RouteRule;
    state: string | null;
    city: string | null;
    chosen_user_id: string | null;
    chosen_name: string | null;
    chosen_role: string | null;
    created_at: string;
};

export type UncoveredPlace = { state: string | null; city: string | null; leads: number; last_at: string };

/** The last N routing decisions and the places with no ASM (last 30 days). */
export async function routingOverview(limit = 50): Promise<{
    logReady: boolean;
    recent: RouteLogRow[];
    uncovered: UncoveredPlace[];
}> {
    if (!(await hasRouteLog())) return { logReady: false, recent: [], uncovered: [] };
    const recent = rows<RouteLogRow>(
        await db.execute(sql`
            SELECT l.id::text AS id, l.lead_id, COALESCE(dl.shop_name, dl.dealer_name, dl.phone) AS lead_name,
                   l.kind, l.rule, l.state, l.city, l.chosen_user_id,
                   u.name AS chosen_name, u.role AS chosen_role, l.created_at::text AS created_at
              FROM lead_route_log l
              LEFT JOIN dealer_leads dl ON dl.id = l.lead_id
              LEFT JOIN users u ON u.id::text = l.chosen_user_id
             ORDER BY l.created_at DESC
             LIMIT ${limit}
        `),
    );
    const uncovered = rows<UncoveredPlace>(
        await db.execute(sql`
            SELECT state, city, count(DISTINCT lead_id)::int AS leads, max(created_at)::text AS last_at
              FROM lead_route_log
             WHERE rule IN ('isr_round_robin', 'unassigned')
               AND created_at >= now() - interval '30 days'
             GROUP BY state, city
             ORDER BY leads DESC, last_at DESC
             LIMIT 20
        `),
    );
    return { logReady: true, recent, uncovered };
}
