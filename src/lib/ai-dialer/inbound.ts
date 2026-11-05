// Inbound on the Vobiz number (Priya KPI tracker task 9) — the I/O half.
//
//   lookupInbound()         caller number → lead (the one Priya dialled most
//                           recently, when several share the number), its open
//                           callback and its last outbound outcome
//   recordInboundInit()     the conversation-initiation webhook logs the call
//   handleInboundPostCall() the post-call webhook for an INBOUND conversation:
//                           logged on the lead (ai_call_logs, a touchpoint, a
//                           v3 disposition) and on its open callback, and the
//                           follow-up booked (inboundContext.inboundFollowUp)
//   sweepMissedInbound()    an init with no post-call after 3 minutes was not
//                           answered: an ISR returns it within 10 minutes
//
// Inbound calls never touch a campaign row: the outbound finalizer used to
// process them as a campaign dial (closing a queued row of a lead in a live
// campaign, and advancing that campaign). Nothing here throws.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emit } from "@/lib/notifications/emit";
import { SYSTEM_PARTY } from "@/lib/notifications/provenance";
import { openCallbackForLead, upsertOpenCallback, setCallbackTimeNotSet } from "@/lib/ai/storage/callOutcomeStore";
import { recordDialDisposition, hasDialDispositionTables } from "@/lib/ai/storage/dialDisposition";
import { writeAiCallTouchpoint } from "@/lib/ai/storage/callTouchpoint";
import { classifyCallEnd, dealerSpoke } from "./campaignLeadStatus";
import { buildCallbackBrief, type CallbackKind } from "./callbackBrief";
import { callbackDueDetail } from "./callCategory";
import { parseFlag } from "./dispositionV3";
import {
    callerKey,
    inboundBranch,
    inboundFollowUp,
    INBOUND_RETURN_MS,
    type InboundBranch,
    type InboundFollowUp,
    type InboundMatch,
} from "./inboundContext";

/** No post-call this long after the init: the call was not answered. */
export const INBOUND_MISSED_AFTER_MS = 3 * 60_000;

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

let probe: { at: number; ok: boolean } | null = null;
export async function hasInboundTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.ok;
    try {
        const r = await db.execute(sql`SELECT to_regclass('public.inbound_calls') IS NOT NULL AS ok`);
        probe = { at: Date.now(), ok: !!rowsOf<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * The lead behind a caller number, with what the agent needs. Matched on the
 * last ten digits; when several leads share the number, the one Priya dialled
 * last wins, then the most recently updated.
 */
export async function lookupInbound(callerPhone: string): Promise<InboundMatch> {
    const empty: InboundMatch = { lead: null, openCallback: null, lastOutcome: null };
    const key = callerKey(callerPhone);
    if (!key) return empty;
    try {
        const v3 = await hasDialDispositionTables();
        const lead = rowsOf<{
            id: string;
            shop_name: string | null;
            dealer_name: string | null;
            language: string | null;
            city: string | null;
        }>(
            await db.execute(sql`
                SELECT dl.id, dl.shop_name, dl.dealer_name, dl.language, dl.city
                  FROM dealer_leads dl
                 WHERE right(regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g'), 10) = ${key}
                 ORDER BY (SELECT max(x.started_at) FROM dialer_campaign_leads x WHERE x.lead_id = dl.id) DESC NULLS LAST,
                          dl.updated_at DESC NULLS LAST
                 LIMIT 1
            `),
        )[0];
        if (!lead) return empty;
        const cb = await openCallbackForLead(lead.id);
        const last = v3
            ? rowsOf<{ l1: string; l2: string; l3: string | null; dialled_at: string }>(
                  await db.execute(sql`
                      SELECT l1, l2, l3, dialled_at::text AS dialled_at FROM ai_dial_dispositions
                       WHERE lead_id = ${lead.id} AND direction = 'outbound'
                       ORDER BY dialled_at DESC LIMIT 1
                  `),
              )[0]
            : undefined;
        const brief = (cb?.brief ?? null) as { timeNotSet?: boolean } | null;
        return {
            lead: {
                id: lead.id,
                shopName: lead.shop_name,
                dealerName: lead.dealer_name,
                language: lead.language,
                city: lead.city,
            },
            openCallback: cb
                ? {
                      id: cb.id,
                      kind: cb.kind,
                      dueAt: new Date(cb.due_at),
                      timeNotSet: cb.time_not_set ?? brief?.timeNotSet === true,
                      assignedName: cb.assigned_name,
                      requestedText: cb.requested_text,
                  }
                : null,
            lastOutcome: last
                ? { l1: last.l1, l2: last.l2, l3: last.l3, at: new Date(last.dialled_at) }
                : null,
        };
    } catch (err) {
        console.error("[inbound] lookup failed:", err instanceof Error ? err.message : err);
        return empty;
    }
}

/** Log the call the moment ElevenLabs asks for its context. */
export async function recordInboundInit(input: {
    callSid: string | null;
    callerPhone: string;
    match: InboundMatch;
    branch: InboundBranch;
}): Promise<void> {
    try {
        if (!(await hasInboundTable())) return;
        await db.execute(sql`
            INSERT INTO inbound_calls (call_sid, caller_phone, phone_key, lead_id, callback_id, branch)
            VALUES (${input.callSid}, ${input.callerPhone}, ${callerKey(input.callerPhone)},
                    ${input.match.lead?.id ?? null}, ${input.match.openCallback?.id ?? null}, ${input.branch})
        `);
    } catch (err) {
        console.error("[inbound] init not logged:", err instanceof Error ? err.message : err);
    }
}

// ── After the call ───────────────────────────────────────────────────────────

export type InboundPostCall = {
    conversationId: string;
    callSid: string | null;
    callerPhone: string | null;
    status: string;
    transcript: string | null;
    recordingUrl: string | null;
    duration: number | null;
    startedAt: Date | null;
    endedAt: Date | null;
    agentId: string | null;
    terminationReason: string | null;
    answeredBy: string | null;
    callResult: string | null;
    callbackAgreed: string | null;
    callbackTime: string | null;
    callLanguage: string | null;
    summary: string | null;
};

type InboundRow = { id: string; lead_id: string | null; callback_id: string | null; branch: string; handled_at: string | null };

/** The inbound_calls row for this conversation: by id, call sid, or the caller's recent unmatched init. */
async function findInboundRow(call: InboundPostCall): Promise<InboundRow | null> {
    if (!(await hasInboundTable())) return null;
    const key = callerKey(call.callerPhone);
    const r = rowsOf<InboundRow>(
        await db.execute(sql`
            SELECT id, lead_id, callback_id, branch, handled_at::text AS handled_at FROM inbound_calls
             WHERE conversation_id = ${call.conversationId}
                OR (${call.callSid}::text IS NOT NULL AND call_sid = ${call.callSid})
                OR (conversation_id IS NULL AND phone_key = ${key} AND created_at > now() - interval '30 minutes')
             ORDER BY (conversation_id = ${call.conversationId}) DESC NULLS LAST, created_at DESC
             LIMIT 1
        `),
    );
    return r[0] ?? null;
}

/**
 * The post-call webhook for an inbound conversation. Idempotent per
 * conversation: a second delivery finds the row handled and stops.
 */
export async function handleInboundPostCall(call: InboundPostCall, now: Date = new Date()): Promise<void> {
    try {
        let row = await findInboundRow(call);
        if (row?.handled_at) return;
        const match = row?.lead_id
            ? await lookupInbound(call.callerPhone ?? "")
            : call.callerPhone
              ? await lookupInbound(call.callerPhone)
              : { lead: null, openCallback: null, lastOutcome: null };
        const branch = (row?.branch as InboundBranch | undefined) ?? inboundBranch(match, now);
        if (!row && (await hasInboundTable())) {
            // No init webhook (not configured yet): log it now.
            await recordInboundInit({ callSid: call.callSid, callerPhone: call.callerPhone ?? "", match, branch });
            row = await findInboundRow(call);
        }

        const callEnd = classifyCallEnd({
            providerStatus: call.status,
            transcript: call.transcript,
            terminationReason: call.terminationReason,
            durationSecs: call.duration,
            answeredBy: call.answeredBy,
            callResult: call.callResult,
        });
        const answered = callEnd.status === "completed" && dealerSpoke(call.transcript);
        const leadId = match.lead?.id ?? null;

        // The call log (the lead's call history) — never a campaign row.
        const { upsertAiCallLog } = await import("@/lib/ai/elevenlabs/finalizeCall");
        await upsertAiCallLog({
            callId: call.conversationId,
            leadId,
            startedAt: call.startedAt,
            endedAt: call.endedAt,
            agentId: call.agentId,
            status: call.status || "completed",
            transcript: call.transcript,
            summary: call.summary,
            recordingUrl: call.recordingUrl,
            duration: call.duration,
            phone: call.callerPhone,
            intentScore: null,
            intentReason: null,
            nextAction: null,
            callStatus: answered ? "inbound" : "inbound_missed",
        });

        const { d: v3 } = await recordDialDisposition({
            dialKey: call.conversationId,
            leadId,
            phone: call.callerPhone,
            direction: "inbound",
            dialledAt: call.startedAt,
            evidence: {
                callEnd,
                answeredBy: call.answeredBy,
                callResult: call.callResult,
                callbackAgreed: call.callbackAgreed,
                callLanguage: call.callLanguage,
                terminationReason: call.terminationReason,
                durationSecs: call.duration,
                transcript: call.transcript,
                dealerSpoke: dealerSpoke(call.transcript),
            },
        });

        if (!leadId) {
            await alertUnknownCaller(call.callerPhone ?? "unknown number", answered);
            await markHandled(row?.id ?? null, { conversationId: call.conversationId, answered, leadId: null, callbackId: null, returnDueAt: answered ? null : new Date(now.getTime() + INBOUND_RETURN_MS) });
            return;
        }

        await writeAiCallTouchpoint({
            v3,
            leadId,
            provider: "elevenlabs",
            callId: call.conversationId,
            transcript: call.transcript,
            providerStatus: call.status || "completed",
            callEndStatus: callEnd.status,
            callOutcome: callEnd.outcome,
            durationSec: call.duration,
            recordingUrl: call.recordingUrl,
            summary: `Inbound — the dealer called us (${branch.replace(/_/g, " ")})${call.summary ? `. ${call.summary}` : ""}`,
        });

        const agreed = parseFlag(call.callbackAgreed);
        const { defaultRetryWindow } = await import("@/lib/queue/campaignTracker");
        const window = await defaultRetryWindow();
        const when = call.callbackTime
            ? callbackDueDetail({ owner: "sales", callbackWhen: call.callbackTime, transcript: call.transcript, now, window })
            : null;
        const followUp = inboundFollowUp({
            branch,
            answered,
            callResult: call.callResult,
            callbackAgreed: agreed,
            agreedAt: when?.timeSet ? when.at : null,
            now,
        });
        const callbackId = await applyFollowUp({ leadId, match, followUp, call, answered, now });
        await markHandled(row?.id ?? null, {
            conversationId: call.conversationId,
            answered,
            leadId,
            callbackId,
            returnDueAt: followUp.kind === "return_call" || followUp.kind === "call_now" ? followUp.dueAt : null,
        });
    } catch (err) {
        console.error("[inbound] post-call failed:", err instanceof Error ? err.message : err);
    }
}

async function markHandled(
    rowId: string | null,
    v: { conversationId: string | null; answered: boolean; leadId: string | null; callbackId: string | null; returnDueAt: Date | null },
): Promise<void> {
    if (!rowId) return;
    await db.execute(sql`
        UPDATE inbound_calls
           SET conversation_id = COALESCE(${v.conversationId}, conversation_id),
               answered = ${v.answered},
               lead_id = COALESCE(${v.leadId}, lead_id),
               callback_id = COALESCE(${v.callbackId}, callback_id),
               return_due_at = ${v.returnDueAt ? v.returnDueAt.toISOString() : null}::timestamptz,
               handled_at = now(), updated_at = now()
         WHERE id = ${rowId}
    `);
}

/**
 * Put the inbound on the lead's callback task. A dealer ringing back lands on
 * the SAME open callback (re-dated, noted); with none open, one is opened and
 * handed to a person like any AI callback (callbackLoop.handOffToOwner).
 * Returns the callback id.
 */
async function applyFollowUp(input: {
    leadId: string;
    match: InboundMatch;
    followUp: InboundFollowUp;
    call: InboundPostCall;
    answered: boolean;
    now: Date;
}): Promise<string | null> {
    const { leadId, match, followUp, call } = input;
    const note = {
        at: input.now.toISOString(),
        conversation_id: call.conversationId,
        answered: input.answered,
        follow_up: followUp.kind,
        summary: call.summary ?? null,
    };
    const open = match.openCallback;
    const kind: CallbackKind = followUp.kind === "complaint" ? "complaint" : (open?.kind as CallbackKind) ?? "sales";
    const dueAt =
        followUp.kind === "return_call" || followUp.kind === "call_now" || followUp.kind === "rebook"
            ? followUp.dueAt
            : open?.dueAt ?? new Date(input.now.getTime() + INBOUND_RETURN_MS);

    if (open) {
        // Same task. A confirmed slot keeps its time; anything else re-dates it
        // and re-arms the reminder and the 30-minute escalation.
        const redate = followUp.kind !== "confirmed";
        await db.execute(sql`
            UPDATE lead_callbacks
               SET last_call_id = ${call.conversationId},
                   brief = jsonb_set(COALESCE(brief, '{}'::jsonb), '{inbound}',
                                     COALESCE(brief -> 'inbound', '[]'::jsonb) || ${JSON.stringify([note])}::jsonb),
                   ${redate ? sql`due_at = ${dueAt.toISOString()}::timestamptz, reminded_at = NULL, escalated_at = NULL,` : sql``}
                   ${followUp.kind === "complaint" ? sql`kind = 'complaint',` : sql``}
                   updated_at = now()
             WHERE id = ${open.id}
        `);
        if (followUp.kind === "rebook") await setCallbackTimeNotSet(open.id, false);
        return open.id;
    }

    const requested =
        followUp.kind === "return_call"
            ? "The dealer called the AI number and the call was not answered — call him back."
            : followUp.kind === "complaint"
              ? "The dealer called the AI number with a complaint."
              : "The dealer called the AI number back.";
    const cb = await upsertOpenCallback({
        leadId,
        sourceCallId: call.conversationId,
        campaignId: null,
        provider: "elevenlabs",
        owner: "sales",
        topic: followUp.kind === "complaint" ? "complaint" : null,
        category: "callback_sales",
        requestedText: requested,
        dueAt,
        summary: call.summary,
        transcriptExcerpt: call.transcript ? call.transcript.slice(-1500) : null,
    });
    if (!cb) return null;
    const { handOffToOwner } = await import("./callbackLoop");
    const brief = buildCallbackBrief({
        kind,
        shop: match.lead?.shopName ?? match.lead?.dealerName ?? null,
        city: match.lead?.city ?? null,
        leadPhone: call.callerPhone,
        callbackWhen: requested,
        dueAt,
        transcript: call.transcript,
        summary: call.summary,
        timeSet: followUp.kind === "rebook",
    });
    await handOffToOwner({ leadId, callbackId: cb.id, kind, dueAt, brief, notify: cb.created });
    // After the hand-off, which writes the whole brief.
    await db.execute(sql`
        UPDATE lead_callbacks
           SET brief = jsonb_set(COALESCE(brief, '{}'::jsonb), '{inbound}',
                                 COALESCE(brief -> 'inbound', '[]'::jsonb) || ${JSON.stringify([note])}::jsonb),
               last_call_id = ${call.conversationId}
         WHERE id = ${cb.id}
    `).catch((e) => console.warn("[inbound] note not written:", e instanceof Error ? e.message : e));
    return cb.id;
}

/** A number we do not know rang the AI line: the callback owners (else the Sales Head) call it back. */
async function alertUnknownCaller(phone: string, answered: boolean): Promise<void> {
    try {
        const { getCallbackLoopSettings } = await import("./callbackLoop");
        const { ownerIds } = await getCallbackLoopSettings();
        const to = ownerIds.length
            ? ownerIds.map((userId) => ({ audience: { kind: "user" as const, userId }, as: { party: "admin" as const, label: "iTarang Sales" }, href: "/leads" }))
            : [{ audience: { kind: "roles" as const, roles: ["sales_head"] }, as: { party: "admin" as const, label: "Sales Head" }, href: "/leads" }];
        await emit({
            type: "lead.callback_assigned",
            title: `Unknown caller on the AI number: ${phone}${answered ? "" : " — not answered, call back within 10 minutes"}`,
            message: `${phone} called the Vobiz number and matches no lead. Call back, and add the lead if it is a dealer.`,
            stage: "AI callback",
            from: SYSTEM_PARTY,
            to,
            data: { phone, inbound: true },
            email: true,
        });
    } catch (err) {
        console.error("[inbound] unknown-caller alert failed:", err instanceof Error ? err.message : err);
    }
}

/**
 * Inits with no post-call after INBOUND_MISSED_AFTER_MS: nobody answered (or
 * the call died before a conversation). Each becomes a 10-minute return task.
 * Run by the callback-loop tick (every 5 minutes).
 */
export async function sweepMissedInbound(now: Date = new Date()): Promise<number> {
    if (!(await hasInboundTable())) return 0;
    let n = 0;
    try {
        const missed = rowsOf<{ id: string; caller_phone: string; call_sid: string | null }>(
            await db.execute(sql`
                UPDATE inbound_calls
                   SET handled_at = now(), answered = false, updated_at = now()
                 WHERE handled_at IS NULL
                   AND created_at < ${new Date(now.getTime() - INBOUND_MISSED_AFTER_MS).toISOString()}::timestamptz
                RETURNING id, caller_phone, call_sid
            `),
        );
        for (const m of missed) {
            n++;
            const match = await lookupInbound(m.caller_phone);
            const followUp: InboundFollowUp = { kind: "return_call", dueAt: new Date(now.getTime() + INBOUND_RETURN_MS) };
            if (!match.lead) {
                await alertUnknownCaller(m.caller_phone, false);
                await db.execute(sql`UPDATE inbound_calls SET return_due_at = ${followUp.dueAt.toISOString()}::timestamptz WHERE id = ${m.id}`);
                continue;
            }
            const callbackId = await applyFollowUp({
                leadId: match.lead.id,
                match,
                followUp,
                call: {
                    conversationId: `inbound_missed:${m.id}`,
                    callSid: m.call_sid,
                    callerPhone: m.caller_phone,
                    status: "missed",
                    transcript: null,
                    recordingUrl: null,
                    duration: null,
                    startedAt: null,
                    endedAt: null,
                    agentId: null,
                    terminationReason: null,
                    answeredBy: null,
                    callResult: null,
                    callbackAgreed: null,
                    callbackTime: null,
                    callLanguage: null,
                    summary: null,
                },
                answered: false,
                now,
            });
            await db.execute(sql`
                UPDATE inbound_calls
                   SET lead_id = ${match.lead.id}, callback_id = COALESCE(${callbackId}, callback_id),
                       return_due_at = ${followUp.dueAt.toISOString()}::timestamptz
                 WHERE id = ${m.id}
            `);
        }
    } catch (err) {
        console.error("[inbound] missed sweep failed:", err instanceof Error ? err.message : err);
    }
    return n;
}
