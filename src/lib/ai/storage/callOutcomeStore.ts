// E-356 — persistence for the per-call outcome category and the callback
// records (ai_call_outcomes, lead_callbacks). Rules live in
// src/lib/ai-dialer/callCategory.ts; this file only reads and writes.
//
// Raw SQL, not in schema.ts, and every entry point is probed with to_regclass:
// a database without E-356 loses the outcome row and the callback record and
// nothing else — finalization, scoring and campaign advance never depend on
// these writes. Nothing here throws.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { phoneLookupVariants } from "@/lib/ai/phone";
import type { CallCategory, CallbackOwner } from "@/lib/ai-dialer/callCategory";

const PROBE_TTL_MS = 5 * 60 * 1000;
let probe: { at: number; ok: boolean } | null = null;

/** Does this database have E-356? Cached; a failed probe reads as "no". */
export async function hasCallOutcomeTables(): Promise<boolean> {
    if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.ok;
    try {
        const r = (await db.execute(sql`
            SELECT to_regclass('public.ai_call_outcomes') IS NOT NULL
               AND to_regclass('public.lead_callbacks') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        probe = { at: Date.now(), ok: !!r[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

function rows<T>(r: unknown): T[] {
    return ((r as { rows?: T[] }).rows ?? (r as T[])) || [];
}

// ── Which lead does a finished call belong to? ──────────────────────────────

/**
 * The dealer_leads id for a provider call, without trusting the webhook's phone
 * format. Bolna's webhook carries no lead id and its user_number is E.164
 * (+91…) while dealer_leads stores 10 digits, so the old `phone = $1` lookup
 * missed and the call returned before anything was written — a connected call
 * with no score. Order: the campaign row that placed the call, an AI callback
 * re-dial, then every stored variant of the phone.
 */
export async function resolveLeadIdForCall(callId: string | null | undefined, phone: string | null | undefined): Promise<string | null> {
    try {
        if (callId) {
            const c = rows<{ lead_id: string }>(await db.execute(sql`
                SELECT lead_id FROM dialer_campaign_leads WHERE bolna_call_id = ${callId}
                 ORDER BY created_at DESC LIMIT 1
            `));
            if (c[0]?.lead_id) return c[0].lead_id;
            if (await hasCallOutcomeTables()) {
                const cb = rows<{ lead_id: string }>(await db.execute(sql`
                    SELECT lead_id FROM lead_callbacks WHERE last_call_id = ${callId} LIMIT 1
                `));
                if (cb[0]?.lead_id) return cb[0].lead_id;
            }
        }
        if (phone) {
            const variants = phoneLookupVariants(phone);
            if (variants.length > 0) {
                const l = rows<{ id: string }>(await db.execute(sql`
                    SELECT id FROM dealer_leads WHERE phone IN ${variants}
                     ORDER BY created_at DESC LIMIT 1
                `));
                if (l[0]?.id) return l[0].id;
            }
        }
    } catch (e) {
        console.warn("[callOutcomeStore] lead lookup failed:", e instanceof Error ? e.message : e);
    }
    return null;
}

// ── ai_call_outcomes ─────────────────────────────────────────────────────────

export type CallOutcomeRow = {
    callId: string;
    provider: "bolna" | "elevenlabs";
    leadId: string | null;
    campaignId: string | null;
    campaignLeadId: string | null;
    category: CallCategory;
    connected: boolean;
    campaignStatus: string | null;
    band: string | null;
    intentScore: number | null;
    callbackOwner: CallbackOwner | null;
    callbackTopic: string | null;
    callbackDueAt: Date | null;
    wantsHuman: boolean;
    retryAt: Date | null;
    summary: string | null;
    ruleVersion: string;
};

/** Upsert on call_id — a re-finalize or a re-score rewrites the same row. */
export async function recordCallOutcome(r: CallOutcomeRow): Promise<void> {
    if (!r.callId || !(await hasCallOutcomeTables())) return;
    try {
        await db.execute(sql`
            INSERT INTO ai_call_outcomes (
                call_id, provider, lead_id, campaign_id, campaign_lead_id, category, connected,
                campaign_status, band, intent_score, callback_owner, callback_topic, callback_due_at,
                wants_human, will_retry, retry_at, summary, rule_version
            ) VALUES (
                ${r.callId}, ${r.provider}, ${r.leadId}, ${r.campaignId}, ${r.campaignLeadId}, ${r.category}, ${r.connected},
                ${r.campaignStatus}, ${r.band}, ${r.intentScore}, ${r.callbackOwner}, ${r.callbackTopic},
                ${r.callbackDueAt ? r.callbackDueAt.toISOString() : null}::timestamptz,
                ${r.wantsHuman}, ${!!r.retryAt}, ${r.retryAt ? r.retryAt.toISOString() : null}::timestamptz,
                ${r.summary}, ${r.ruleVersion}
            )
            ON CONFLICT (call_id) DO UPDATE SET
                lead_id          = COALESCE(EXCLUDED.lead_id, ai_call_outcomes.lead_id),
                campaign_id      = COALESCE(EXCLUDED.campaign_id, ai_call_outcomes.campaign_id),
                campaign_lead_id = COALESCE(EXCLUDED.campaign_lead_id, ai_call_outcomes.campaign_lead_id),
                category         = EXCLUDED.category,
                connected        = EXCLUDED.connected,
                campaign_status  = COALESCE(EXCLUDED.campaign_status, ai_call_outcomes.campaign_status),
                band             = EXCLUDED.band,
                intent_score     = EXCLUDED.intent_score,
                callback_owner   = EXCLUDED.callback_owner,
                callback_topic   = EXCLUDED.callback_topic,
                callback_due_at  = EXCLUDED.callback_due_at,
                wants_human      = EXCLUDED.wants_human,
                will_retry       = EXCLUDED.will_retry OR ai_call_outcomes.will_retry,
                retry_at         = COALESCE(EXCLUDED.retry_at, ai_call_outcomes.retry_at),
                summary          = COALESCE(EXCLUDED.summary, ai_call_outcomes.summary),
                rule_version     = EXCLUDED.rule_version,
                updated_at       = now()
        `);
    } catch (e) {
        console.warn("[callOutcomeStore] outcome not recorded:", e instanceof Error ? e.message : e);
    }
}

// ── lead_callbacks ───────────────────────────────────────────────────────────

export type OpenCallback = {
    id: string;
    lead_id: string;
    owner_type: CallbackOwner;
    status: string;
    due_at: string;
    attempts: number;
    last_call_id: string | null;
    campaign_id: string | null;
    provider: string | null;
};

/**
 * Open (or refresh) the lead's callback. One open callback per lead (partial
 * unique index): a second request updates it — the newer time, the newer
 * words — and a sales request upgrades an AI one, never the reverse.
 * Returns the row and whether it was newly opened.
 */
export async function upsertOpenCallback(input: {
    leadId: string;
    sourceCallId: string;
    campaignId: string | null;
    provider: "bolna" | "elevenlabs";
    owner: CallbackOwner;
    topic: string | null;
    category: CallCategory;
    requestedText: string | null;
    dueAt: Date;
    summary: string | null;
    transcriptExcerpt: string | null;
}): Promise<{ id: string; created: boolean; owner: CallbackOwner } | null> {
    if (!(await hasCallOutcomeTables())) return null;
    try {
        const due = input.dueAt.toISOString();
        const updated = rows<{ id: string; owner_type: CallbackOwner }>(await db.execute(sql`
            UPDATE lead_callbacks
               SET owner_type = CASE WHEN owner_type = 'sales' THEN 'sales' ELSE ${input.owner} END,
                   topic = COALESCE(${input.topic}, topic),
                   category = ${input.category},
                   requested_text = COALESCE(NULLIF(${input.requestedText ?? ""}, ''), requested_text),
                   due_at = ${due}::timestamptz,
                   status = 'open',
                   source_call_id = ${input.sourceCallId},
                   campaign_id = COALESCE(${input.campaignId}, campaign_id),
                   provider = COALESCE(${input.provider}, provider),
                   summary = COALESCE(${input.summary}, summary),
                   transcript_excerpt = COALESCE(${input.transcriptExcerpt}, transcript_excerpt),
                   updated_at = now()
             WHERE lead_id = ${input.leadId} AND status IN ('open', 'dialing')
            RETURNING id, owner_type
        `));
        if (updated[0]) return { id: updated[0].id, created: false, owner: updated[0].owner_type };

        const inserted = rows<{ id: string }>(await db.execute(sql`
            INSERT INTO lead_callbacks (
                lead_id, source_call_id, campaign_id, provider, owner_type, topic, category,
                requested_text, due_at, summary, transcript_excerpt
            ) VALUES (
                ${input.leadId}, ${input.sourceCallId}, ${input.campaignId}, ${input.provider}, ${input.owner},
                ${input.topic}, ${input.category}, ${input.requestedText}, ${due}::timestamptz,
                ${input.summary}, ${input.transcriptExcerpt}
            )
            ON CONFLICT DO NOTHING
            RETURNING id
        `));
        if (inserted[0]) return { id: inserted[0].id, created: true, owner: input.owner };
        return null; // lost a race with a concurrent writer — theirs stands
    } catch (e) {
        console.warn("[callOutcomeStore] callback not recorded:", e instanceof Error ? e.message : e);
        return null;
    }
}

/** The open AI callback this provider call was placed for, if any. */
export async function findCallbackByCallId(callId: string): Promise<OpenCallback | null> {
    if (!callId || !(await hasCallOutcomeTables())) return null;
    try {
        const r = rows<OpenCallback>(await db.execute(sql`
            SELECT id, lead_id, owner_type, status, due_at::text AS due_at, attempts, last_call_id,
                   campaign_id, provider
              FROM lead_callbacks
             WHERE last_call_id = ${callId} AND status IN ('open', 'dialing')
             LIMIT 1
        `));
        return r[0] ?? null;
    } catch {
        return null;
    }
}

/** Close one callback. */
export async function closeCallback(
    id: string,
    status: "done" | "cancelled" | "expired",
    note: string,
    by: string | null = null,
): Promise<void> {
    try {
        await db.execute(sql`
            UPDATE lead_callbacks
               SET status = ${status}, completed_at = now(), completed_by = ${by},
                   completion_note = ${note}, updated_at = now()
             WHERE id = ${id} AND status IN ('open', 'dialing')
        `);
    } catch (e) {
        console.warn("[callOutcomeStore] callback not closed:", e instanceof Error ? e.message : e);
    }
}

/** An AI re-dial that did not reach the dealer — back to open at a later time. */
export async function reopenCallback(id: string, dueAt: Date): Promise<void> {
    try {
        await db.execute(sql`
            UPDATE lead_callbacks
               SET status = 'open', due_at = ${dueAt.toISOString()}::timestamptz, updated_at = now()
             WHERE id = ${id} AND status IN ('open', 'dialing')
        `);
    } catch (e) {
        console.warn("[callOutcomeStore] callback not reopened:", e instanceof Error ? e.message : e);
    }
}

/**
 * A person worked the lead (a logged call / visit / WhatsApp chat) or it was
 * closed: its open SALES callback is done. AI callbacks are left alone unless
 * the lead is closed — a rep working the lead also cancels a pending robot
 * re-dial, because the AI must not call a lead a person is handling.
 */
export async function settleCallbacksForLeadWork(
    leadId: string,
    actorId: string | null,
    opts: { terminal: boolean; note: string },
): Promise<number> {
    if (!(await hasCallOutcomeTables())) return 0;
    try {
        const r = rows<{ id: string }>(await db.execute(sql`
            UPDATE lead_callbacks
               SET status = CASE WHEN owner_type = 'sales' THEN 'done' ELSE 'cancelled' END,
                   completed_at = now(), completed_by = ${actorId},
                   completion_note = ${opts.note}, updated_at = now()
             WHERE lead_id = ${leadId} AND status IN ('open', 'dialing')
               AND (owner_type = 'sales' OR ${opts.terminal} OR status = 'open')
            RETURNING id
        `));
        return r.length;
    } catch (e) {
        console.warn("[callOutcomeStore] callbacks not settled:", e instanceof Error ? e.message : e);
        return 0;
    }
}

/** The lead's open callback, for the lead page. null on no E-356 / none open. */
export async function openCallbackForLead(leadId: string): Promise<{
    id: string;
    owner_type: CallbackOwner;
    status: string;
    topic: string | null;
    category: string | null;
    requested_text: string | null;
    due_at: string;
    overdue: boolean;
    attempts: number;
    summary: string | null;
    source_call_id: string | null;
    created_at: string;
} | null> {
    if (!(await hasCallOutcomeTables())) return null;
    try {
        const r = rows<NonNullable<Awaited<ReturnType<typeof openCallbackForLead>>>>(await db.execute(sql`
            SELECT id, owner_type, status, topic, category, requested_text, due_at::text AS due_at,
                   (due_at < now()) AS overdue,
                   attempts, summary, source_call_id, created_at::text AS created_at
              FROM lead_callbacks
             WHERE lead_id = ${leadId} AND status IN ('open', 'dialing')
             LIMIT 1
        `));
        return r[0] ?? null;
    } catch {
        return null;
    }
}
