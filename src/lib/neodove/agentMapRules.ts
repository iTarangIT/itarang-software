/**
 * Pure rules for the NeoDove agent → CRM user map (review R-03). No I/O, so
 * they are unit-tested (__tests__/agentMapRules.test.ts); the DB half lives in
 * ./agentMap.ts.
 *
 * WHY A MAP AND NOT A NAME MATCH. NeoDove's webhook names the agent who dialled
 * ("NIDHI PATHAK") but has no user id, and NeoDove has no read API for its
 * users. The CRM accounts carry first names only ("Nidhi"). Matching on names
 * would work today and silently misattribute the day a second Nidhi joins —
 * and a call credited to the wrong rep is worse than one credited to nobody,
 * because it looks right. So a human confirms each agent once, and the name is
 * only ever used to SUGGEST.
 */

/** Hard ceiling on stored entries — the map is free text a human builds. */
export const MAX_AGENT_MAPPINGS = 200;

/**
 * The lookup key for an agent name: trimmed, inner whitespace collapsed,
 * lower-cased. NeoDove sends the same person as "NIDHI PATHAK" and
 * "Nidhi Pathak" depending on the payload, and both must hit one entry. The SQL
 * backfill uses the same expression (see AGENT_KEY_SQL in agentMap.ts).
 */
export function agentKey(name: string | null | undefined): string | null {
    if (typeof name !== "string") return null;
    const k = name.trim().replace(/\s+/g, " ").toLowerCase();
    return k.length ? k : null;
}

/**
 * Read the stored map, dropping anything malformed. Keys are re-normalised so a
 * hand-edited row cannot create two entries for one agent.
 */
export function parseAgentMap(value: unknown): Record<string, string> {
    const raw =
        value && typeof value === "object"
            ? (value as { agents?: unknown }).agents
            : undefined;
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [name, userId] of Object.entries(raw as Record<string, unknown>)) {
        const k = agentKey(name);
        if (!k || typeof userId !== "string" || !userId.trim()) continue;
        out[k] = userId.trim();
        if (Object.keys(out).length >= MAX_AGENT_MAPPINGS) break;
    }
    return out;
}

/**
 * A SUGGESTION only, never applied without a click: the single active user
 * whose full name, or first name, equals the agent's full name or first name.
 * More than one candidate → no suggestion; guessing between two people is the
 * exact failure the map exists to prevent.
 */
export function suggestUserId(
    agentName: string,
    users: { user_id: string; name: string | null }[],
): string | null {
    const full = agentKey(agentName);
    if (!full) return null;
    const first = full.split(" ")[0];
    const hits = users.filter((u) => {
        const n = agentKey(u.name);
        if (!n) return false;
        return n === full || n === first || n.split(" ")[0] === first;
    });
    return hits.length === 1 ? hits[0].user_id : null;
}
