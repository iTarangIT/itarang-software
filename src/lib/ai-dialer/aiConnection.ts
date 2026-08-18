// "Has the AI already had a real conversation with this dealer?" — the queries
// behind the hard block.
//
// Kept apart from exclusionFilter.ts, which is deliberately db-free so its guard
// tests need no mocks. That file owns the PREDICATES; this one owns the QUERIES.
//
// CONNECTED := ai_call_logs.transcript IS NOT NULL. See the long note in
// exclusionFilter.ts for why that is the definition and why it is evaluated live
// rather than denormalised onto dealer_leads.
//
// ⚠ Nothing here may be wired into the NeoDove push paths. An AI-connected lead
// is exactly the one the human calling team should receive.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/** Everything the "already contacted by AI" notice renders. */
export type AiConnectionPayload = {
    connected: boolean;
    callId: string | null;
    provider: string | null;
    calledAt: string | null;
    durationSeconds: number | null;
    summary: string | null;
    /** Qualified | Warm | Cold | Disqualified — null on a dropped_empty call. */
    band: string | null;
    /** complete | dropped_partial | dropped_empty */
    callStatus: string | null;
    intentScore: number | null;
    infoSignalsCount: number | null;
    recordingUrl: string | null;
    /** Total connected calls, so the notice can say "spoken to twice". */
    totalConnectedCalls: number;
    /** Lets the notice deep-link the existing campaign transcript drawer.
     *  Null for a manual one-off call, which the drawer cannot render. */
    campaignId: string | null;
    campaignName: string | null;
};

function rowsOf<T>(result: unknown): T[] {
    return (
        (result as { rows?: T[] }).rows ?? (result as T[])
    );
}

/**
 * Split a candidate queue into leads the AI may still call and leads it may not.
 *
 * One statement, ids passed as a jsonb array rather than a variadic IN-list —
 * the same shape audience.ts uses, and it keeps the bind-parameter count at one
 * regardless of queue size (createCampaign already chunks its INSERTs at 500 for
 * the 64k cap; this query would otherwise hit the same ceiling).
 *
 * Order is preserved for `dialable` so the caller's queue_position is unchanged.
 */
export async function partitionAiConnected(
    leadIds: string[],
): Promise<{ dialable: string[]; blockedAiConnected: string[] }> {
    if (leadIds.length === 0) return { dialable: [], blockedAiConnected: [] };

    const blocked = await aiConnectedSet(leadIds);
    const dialable: string[] = [];
    const blockedAiConnected: string[] = [];
    for (const id of leadIds) {
        if (blocked.has(id)) blockedAiConnected.push(id);
        else dialable.push(id);
    }
    return { dialable, blockedAiConnected };
}

/** Which of these leads the AI has already connected with. */
export async function aiConnectedSet(leadIds: string[]): Promise<Set<string>> {
    if (leadIds.length === 0) return new Set();

    const result = await db.execute(sql`
        SELECT DISTINCT acl.lead_id
          FROM ai_call_logs acl
         WHERE acl.transcript IS NOT NULL
           AND acl.lead_id IN (
                 SELECT value FROM jsonb_array_elements_text(${JSON.stringify(leadIds)}::jsonb)
               )
    `);
    return new Set(
        rowsOf<{ lead_id: string }>(result)
            .map((r) => r.lead_id)
            .filter((id): id is string => Boolean(id)),
    );
}

/**
 * Drop AI-connected leads from a follow-up batch, and clear their next_call_at.
 *
 * Shared by /api/cron/call and both call-schedulers, which all select on
 * `next_call_at IS NOT NULL`. That column is written ONLY by resolveNextCallAt()
 * on the transcript path, so every lead those crons see is AI-connected by
 * construction — this is a retirement of the AI follow-up loop, not an
 * occasional skip. See AI_FOLLOWUP_LOOP_RETIRES_CONNECTED.
 *
 * Clearing next_call_at is the load-bearing half. Refusing to dial while leaving
 * the timestamp set would make the cron re-select the same leads on every tick,
 * forever, and the "processed: 0" would look like nothing was wrong.
 *
 * Takes rows rather than ids and returns rows, so callers keep whatever shape
 * their own query produced — several of them use a bare
 * `db.select().from(dealerLeads)`, and adding a computed column to those is the
 * schema.ts mirroring landmine.
 */
export async function retireAiConnectedFollowUps<T extends { id: string }>(
    candidates: T[],
    opts: { enabled: boolean; source: string },
): Promise<{ dialable: T[]; retired: number }> {
    if (!opts.enabled || candidates.length === 0) {
        return { dialable: candidates, retired: 0 };
    }

    const connected = await aiConnectedSet(candidates.map((c) => c.id));
    if (connected.size === 0) return { dialable: candidates, retired: 0 };

    const blockedIds = candidates
        .map((c) => c.id)
        .filter((id) => connected.has(id));

    await db.execute(sql`
        UPDATE dealer_leads
           SET next_call_at = NULL
         WHERE id IN (
                 SELECT value FROM jsonb_array_elements_text(${JSON.stringify(blockedIds)}::jsonb)
               )
    `);

    console.warn(
        `[${opts.source}] retired ${blockedIds.length} AI follow-up(s): the AI has already spoken to these dealers, so they go to the human queue`,
    );

    return {
        dialable: candidates.filter((c) => !connected.has(c.id)),
        retired: blockedIds.length,
    };
}

/**
 * The most recent connected AI call for one lead.
 *
 * Deliberately NOT a reuse of /api/ai-dialer/campaigns/[id]/leads/[leadId]/transcript:
 * that route runs five queries, needs a campaignId, and 404s when the lead is not
 * in the campaign — which is precisely the blocked-lead case this serves.
 */
export async function fetchAiConnection(
    leadId: string,
): Promise<AiConnectionPayload> {
    const result = await db.execute(sql`
        SELECT acl.call_id,
               acl.provider,
               acl.summary,
               acl.band,
               acl.call_status,
               acl.intent_score,
               acl.info_signals_count,
               acl.recording_url,
               acl.call_duration,
               COALESCE(acl.ended_at, acl.created_at) AS called_at,
               (SELECT COUNT(*)::int FROM ai_call_logs x
                 WHERE x.lead_id = ${leadId} AND x.transcript IS NOT NULL) AS total_connected,
               dcl.campaign_id,
               dc.name AS campaign_name
          FROM ai_call_logs acl
          LEFT JOIN LATERAL (
                SELECT campaign_id FROM dialer_campaign_leads
                 WHERE lead_id = ${leadId}
                 ORDER BY created_at DESC LIMIT 1
          ) dcl ON true
          LEFT JOIN dialer_campaigns dc ON dc.id = dcl.campaign_id
         WHERE acl.lead_id = ${leadId}
           AND acl.transcript IS NOT NULL
         ORDER BY COALESCE(acl.ended_at, acl.created_at) DESC
         LIMIT 1
    `);

    const row = rowsOf<{
        call_id: string | null;
        provider: string | null;
        summary: string | null;
        band: string | null;
        call_status: string | null;
        intent_score: number | null;
        info_signals_count: number | null;
        recording_url: string | null;
        call_duration: number | null;
        called_at: string | Date | null;
        total_connected: number | null;
        campaign_id: string | null;
        campaign_name: string | null;
    }>(result)[0];

    if (!row) {
        return {
            connected: false,
            callId: null,
            provider: null,
            calledAt: null,
            durationSeconds: null,
            summary: null,
            band: null,
            callStatus: null,
            intentScore: null,
            infoSignalsCount: null,
            recordingUrl: null,
            totalConnectedCalls: 0,
            campaignId: null,
            campaignName: null,
        };
    }

    return {
        connected: true,
        callId: row.call_id,
        provider: row.provider,
        // The recording is served through the existing self-healing proxy when
        // the stored URL is null — same fallback the transcript route uses, so a
        // call whose recording arrived late is still playable.
        recordingUrl:
            row.recording_url ??
            (row.call_id ? `/api/ai-dialer/recording/${row.call_id}` : null),
        calledAt:
            row.called_at instanceof Date
                ? row.called_at.toISOString()
                : (row.called_at ?? null),
        durationSeconds: row.call_duration,
        summary: row.summary,
        band: row.band,
        callStatus: row.call_status,
        intentScore: row.intent_score,
        infoSignalsCount: row.info_signals_count,
        totalConnectedCalls: row.total_connected ?? 1,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
    };
}
