/**
 * NeoDove agent → CRM user map (review R-03, Reporting Review v1.0).
 *
 * THE PROBLEM. Every NeoDove call was written with performed_by = NULL, and
 * every per-rep surface (Sales dashboard, daily email, Funnel by Owner)
 * attributes calls on performed_by — so all CC dialling was invisible per rep,
 * the team total did not equal the sum of the reps, and Req #15's "calls per
 * day per inside-sales rep" could not be measured. The agent's NAME was always
 * there (lead_touchpoints.external_agent_name, E-226); only the link to a CRM
 * user was missing.
 *
 * THE FIX. An admin confirms, once per agent, which CRM user a NeoDove agent
 * is. Stored as one jsonb blob under app_settings['neodove_agent_map'] —
 * `{ agents: { "<agent key>": "<user id>" }, updated_by }` — so no migration.
 *   * live webhooks and CSV reconciliation look the agent up at write time
 *     (resolveAgentUserId);
 *   * saving a mapping re-points that agent's EXISTING calls in the same
 *     transaction, which is the backfill.
 *
 * No fallback to the lead's owner: the owner is who holds the lead, not who
 * dialled, and a call credited to the wrong rep looks right. Unmapped calls
 * stay NULL and are counted as "unattributed" on the Agents page until 0.
 *
 * Pure rules (key normalisation, parsing, suggestions): ./agentMapRules.ts.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { NEODOVE_ADMIN_ROLES, NEODOVE_ASSIGNEE_ROLES } from "@/lib/neodove/roles";
import {
    agentKey,
    MAX_AGENT_MAPPINGS,
    parseAgentMap,
    suggestUserId,
} from "@/lib/neodove/agentMapRules";

const SETTINGS_KEY = "neodove_agent_map";

/** SQL twin of agentKey(): trim, collapse whitespace, lower-case. */
const AGENT_KEY_SQL = sql.raw(
    `lower(regexp_replace(btrim(t.external_agent_name), '\\s+', ' ', 'g'))`,
);

/** Only NeoDove CALLS are attributed — not assignments or dial requests. */
const NEODOVE_CALL = sql.raw(
    `t.external_system = 'neodove' AND t.touchpoint_type = 'inside_sales_call'`,
);

/** Roles a NeoDove agent can be mapped to: everyone who works NeoDove leads. */
const MAPPABLE_ROLES = [...new Set([...NEODOVE_ASSIGNEE_ROLES, ...NEODOVE_ADMIN_ROLES])];

async function readMap(): Promise<Record<string, string>> {
    const rows = await db.execute<{ value: unknown }>(sql`
        SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} LIMIT 1
    `);
    return parseAgentMap((rows as unknown as { value: unknown }[])[0]?.value);
}

/**
 * The CRM user who made a NeoDove call, or null when the agent is unknown or
 * unmapped. NEVER throws: attribution is metadata, and failing to resolve it
 * must not lose the call itself — the webhook cannot be replayed.
 */
export async function resolveAgentUserId(
    agentName: string | null | undefined,
): Promise<string | null> {
    const k = agentKey(agentName);
    if (!k) return null;
    try {
        return (await readMap())[k] ?? null;
    } catch (e) {
        console.warn("[neodove/agentMap] could not read agent map — call left unattributed", {
            error: e instanceof Error ? e.message : String(e),
        });
        return null;
    }
}

export type NeodoveAgentRow = {
    /** Normalised key; what PUT takes back. */
    key: string;
    /** The name as NeoDove last sent it. */
    name: string;
    calls: number;
    unattributed: number;
    last_call_at: string | null;
    user_id: string | null;
    user_name: string | null;
    /** A name-based guess shown in the picker; never applied automatically. */
    suggested_user_id: string | null;
};

export type MappableUser = { user_id: string; name: string | null; role: string | null };

export type NeodoveAgentsSummary = {
    agents: NeodoveAgentRow[];
    users: MappableUser[];
    total_calls: number;
    unattributed_calls: number;
    /** Calls NeoDove sent with no agent name at all — cannot be mapped. */
    calls_without_agent: number;
};

export async function listNeodoveAgents(): Promise<NeodoveAgentsSummary> {
    const [map, agentRows, totals, userRows] = await Promise.all([
        readMap(),
        db.execute<{
            key: string;
            name: string;
            calls: string;
            unattributed: string;
            last_call_at: string | null;
        }>(sql`
            SELECT ${AGENT_KEY_SQL} AS key,
                   (array_agg(t.external_agent_name ORDER BY t.performed_at DESC))[1] AS name,
                   COUNT(*)::text AS calls,
                   COUNT(*) FILTER (WHERE t.performed_by IS NULL)::text AS unattributed,
                   MAX(t.performed_at) AS last_call_at
              FROM lead_touchpoints t
             WHERE ${NEODOVE_CALL}
               AND NULLIF(btrim(t.external_agent_name), '') IS NOT NULL
             GROUP BY 1
             ORDER BY COUNT(*) DESC
        `),
        db.execute<{ total: string; unattributed: string; no_agent: string }>(sql`
            SELECT COUNT(*)::text AS total,
                   COUNT(*) FILTER (WHERE t.performed_by IS NULL)::text AS unattributed,
                   COUNT(*) FILTER (
                       WHERE NULLIF(btrim(t.external_agent_name), '') IS NULL
                   )::text AS no_agent
              FROM lead_touchpoints t
             WHERE ${NEODOVE_CALL}
        `),
        db.execute<MappableUser>(sql`
            SELECT u.id::text AS user_id, u.name, u.role
              FROM users u
             WHERE LOWER(u.role) IN (${sql.join(MAPPABLE_ROLES.map((r) => sql`${r}`), sql`, `)})
               AND u.is_active = TRUE
             ORDER BY u.name ASC NULLS LAST
        `),
    ]);

    const users = userRows as unknown as MappableUser[];
    const nameOf = new Map(users.map((u) => [u.user_id, u.name]));
    const agents = (agentRows as unknown as {
        key: string;
        name: string;
        calls: string;
        unattributed: string;
        last_call_at: string | null;
    }[]).map((r) => {
        const userId = map[r.key] ?? null;
        return {
            key: r.key,
            name: r.name,
            calls: Number(r.calls),
            unattributed: Number(r.unattributed),
            last_call_at: r.last_call_at ? new Date(r.last_call_at).toISOString() : null,
            user_id: userId,
            // A mapped user who has since been deactivated drops out of `users`.
            user_name: userId ? (nameOf.get(userId) ?? null) : null,
            suggested_user_id: userId ? null : suggestUserId(r.name, users),
        };
    });

    const t = (totals as unknown as { total: string; unattributed: string; no_agent: string }[])[0];
    return {
        agents,
        users,
        total_calls: Number(t?.total ?? 0),
        unattributed_calls: Number(t?.unattributed ?? 0),
        calls_without_agent: Number(t?.no_agent ?? 0),
    };
}

export class AgentMapError extends Error {}

/**
 * Map (or, with userId = null, unmap) one NeoDove agent, and re-point that
 * agent's existing calls in the same transaction. Returns how many calls moved.
 *
 * Re-pointing touches only NeoDove call rows for THIS agent that are either
 * unattributed or attributed to the agent's PREVIOUS mapping — so correcting a
 * wrong mapping fixes history, and nothing a human logged is ever rewritten.
 */
export async function setNeodoveAgentMapping(
    agentName: string,
    userId: string | null,
    updatedBy: string,
): Promise<{ moved: number }> {
    const k = agentKey(agentName);
    if (!k) throw new AgentMapError("Agent name is empty.");

    return db.transaction(async (tx) => {
        if (userId) {
            const ok = await tx.execute<{ n: string }>(sql`
                SELECT COUNT(*)::text AS n FROM users
                 WHERE id::text = ${userId} AND is_active = TRUE
            `);
            if (Number((ok as unknown as { n: string }[])[0]?.n ?? 0) === 0) {
                throw new AgentMapError("That user does not exist or is inactive.");
            }
        }

        // FOR UPDATE: two admins saving at once must not drop each other's entry.
        const cur = await tx.execute<{ value: unknown }>(sql`
            SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY} FOR UPDATE
        `);
        const map = parseAgentMap((cur as unknown as { value: unknown }[])[0]?.value);
        const previous = map[k] ?? null;

        // An unchanged mapping skips the settings write but NOT the re-point
        // below: calls that arrived unattributed while the mapping existed
        // (e.g. written by a deploy that predates this file) are picked up by
        // simply saving the same link again.
        if (previous !== userId) {
            if (userId) map[k] = userId;
            else delete map[k];
            if (Object.keys(map).length > MAX_AGENT_MAPPINGS) {
                throw new AgentMapError(`At most ${MAX_AGENT_MAPPINGS} agents can be mapped.`);
            }

            const value = { agents: map, updated_by: updatedBy };
            const now = new Date();
            await tx
                .insert(appSettings)
                .values({ key: SETTINGS_KEY, value, updated_at: now })
                .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_at: now } });
        }

        const moved = await tx.execute<{ n: string }>(sql`
            WITH m AS (
                UPDATE lead_touchpoints t
                   SET performed_by = ${userId}
                 WHERE ${NEODOVE_CALL}
                   AND ${AGENT_KEY_SQL} = ${k}
                   AND (t.performed_by IS NULL
                        ${previous ? sql`OR t.performed_by = ${previous}` : sql``})
                RETURNING 1
            )
            SELECT COUNT(*)::text AS n FROM m
        `);
        return { moved: Number((moved as unknown as { n: string }[])[0]?.n ?? 0) };
    });
}
