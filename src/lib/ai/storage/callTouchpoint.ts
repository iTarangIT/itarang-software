// Record a finished AI call as a lead touchpoint, in the same vocabulary the
// human calling team uses.
//
// Until now the AI dialer wrote ai_call_logs and the dealer_leads rollups but
// never a touchpoint — measured on database-1: 2,445 inside_sales_call rows and
// ZERO ai_call rows, even though 'ai_call' has been a legal TOUCHPOINT_TYPE
// since Part 0. So AI calls were invisible to the lead timeline, to the E-236
// disposition filters, and to every connect-rate figure in the CRM.
//
// It never throws: a disposition write must not be able to fail a call
// finalization or stall the campaign advance that follows it.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import {
    aiExternalTag,
    mapAiCallToDisposition,
    type AiCallDispositionInput,
} from "@/lib/leads/aiDisposition";

export type AiCallTouchpointInput = AiCallDispositionInput & {
    leadId: string;
    provider: string;
    /** ai_call_logs.call_id — THE IDEMPOTENCY KEY. */
    callId: string | null;
    durationSec?: number | null;
    recordingUrl?: string | null;
    /** One-line call summary, for the timeline remark. */
    summary?: string | null;
    /** From resolveNextCallAt(), when the analyzer scheduled a follow-up. */
    nextCallAt?: Date | null;
    performedAt?: Date;
};

function rowsOf<T>(result: unknown): T[] {
    return (result as { rows?: T[] }).rows ?? (result as T[]);
}

/**
 * The timeline remark.
 *
 * Mirrors the "[NeoDove] …" shape remarksFor() already writes, so a lead's
 * history reads as one set of events rather than two systems shouting past each
 * other.
 */
function buildRemarks(
    input: AiCallTouchpointInput,
    connected: boolean,
): string {
    if (!connected) {
        return `[AI] No conversation (${input.providerStatus ?? "unknown"})`;
    }
    if (input.analysisFailed) {
        return "[AI] Connected — transcript not analysed (extraction failed)";
    }
    const bits: string[] = [];
    if (input.band) bits.push(input.band);
    if (typeof input.infoSignalsCount === "number") {
        bits.push(`${input.infoSignalsCount}/5 signals`);
    }
    if (input.bandCallStatus === "dropped_partial") {
        bits.push("resume — call was cut off");
    }
    const head = bits.length ? `[AI] ${bits.join(" · ")}` : "[AI] Connected";
    const summary = (input.summary ?? "").trim();
    return summary ? `${head} · "${summary}"` : head;
}

/**
 * @returns the touchpoint id, or null when nothing was written.
 */
export async function writeAiCallTouchpoint(
    input: AiCallTouchpointInput,
): Promise<string | null> {
    try {
        // Without a stable call id there is no idempotency key: upsertAiCallLog
        // synthesises `AICALL_<Date.now()>` in that case, which would produce a
        // NEW touchpoint on every webhook retry and every poll tick. A missing
        // touchpoint is far better than one that multiplies. Every live path
        // has a call id.
        if (!input.callId) {
            console.warn(
                `[callTouchpoint] skipping touchpoint for lead ${input.leadId}: no call id to key idempotency on`,
            );
            return null;
        }

        const d = mapAiCallToDisposition(input);
        const connected = d.connectStatus === "connected";
        const performedAt = input.performedAt ?? new Date();

        // Layer 1 of idempotency. lead_touchpoints_external_uniq (E-113) makes
        // (external_system, external_event_id) unique, so a duplicate would be
        // refused anyway — but checking first also REPAIRS a row whose
        // post-commit disposition update failed on an earlier pass, which the
        // unique index alone would not.
        const existing = rowsOf<{ touchpoint_id: string }>(
            await db.execute(sql`
                SELECT touchpoint_id FROM lead_touchpoints
                 WHERE external_system = ${input.provider}
                   AND external_event_id = ${input.callId}
                 LIMIT 1
            `),
        )[0];

        let touchpointId: string;

        if (existing) {
            touchpointId = existing.touchpoint_id;
        } else {
            try {
                const result = await writeTouchpoint({
                    dealerLeadId: input.leadId,
                    touchpointType: "ai_call",
                    // NULL = system-generated, which is already this column's
                    // documented meaning — and it is load-bearing. reports.ts's
                    // dailyActivity and funnelByOwner both filter
                    // `performed_by IS NOT NULL`, so AI rows stay out of every
                    // per-rep figure by construction. A synthetic "AI Dialer"
                    // user would put the robot into rep leaderboards, owner
                    // dropdowns and every LEFT JOIN users in the codebase.
                    performedBy: null,
                    performedAt,
                    callStatus: d.callStatus,
                    callDurationSec: input.durationSec ?? null,
                    // ALWAYS false. BRD §0.1 defines engagement as a HUMAN
                    // interaction, and canTransition gates
                    // Assigned_Not_Contacted → Under_Discussion on
                    // engagedTouchpointCount >= 1. Letting a robot satisfy that
                    // would silently change what Under_Discussion certifies.
                    isEngaged: false,
                    remarks: buildRemarks(input, connected),
                    // "api" means an external system called US; we called the
                    // provider. The enum already has the right word.
                    syncMethod: "system",
                    // Not "ai_dialer": external_event_id holds the PROVIDER's
                    // call id, and the unique index is on the pair.
                    externalSystem: input.provider,
                    externalEventId: input.callId,
                    nextAction: input.nextCallAt ? "follow_up" : "no_action",
                    nextActionAt: input.nextCallAt ?? null,
                    // NEVER a status change. A disposition records what happened
                    // on a call; moving the BRD §0.7 pipeline stays a human
                    // decision.
                });
                touchpointId = result.touchpointId;
            } catch (err) {
                // 23505 = the unique index caught a genuine race (two workers,
                // or a webhook and a poll tick landing together). writeTouchpoint
                // opened its own transaction, so the rollback is contained and
                // last_touchpoint_at was not left half-bumped.
                if ((err as { code?: string })?.code === "23505") {
                    console.warn(
                        `[callTouchpoint] duplicate touchpoint for call ${input.callId} — already recorded`,
                    );
                    return null;
                }
                throw err;
            }
        }

        // E-226 + E-236 columns, written AFTER the transaction commits and in
        // their own try/catch.
        //
        // Post-commit rather than in-transaction, unlike the inside-sales path:
        // a provider webhook is an event nobody can re-fetch, so losing the
        // TOUCHPOINT to a database missing E-236 would be unacceptable while
        // losing the LABEL is merely bad. (The rep's form takes the opposite
        // trade: they watched themselves pick it, so a silent drop is a lie on
        // screen.) Same shape as attachCallEvidence in neodove/inbound.ts.
        //
        // COALESCE on every column so a re-run can only fill gaps, never blank
        // out something a later pass already wrote.
        try {
            await db.execute(sql`
                UPDATE lead_touchpoints
                   SET disposition        = COALESCE(${d.disposition}, disposition),
                       disposition_bucket = COALESCE(${d.bucket}, disposition_bucket),
                       connect_status     = COALESCE(${d.connectStatus}, connect_status),
                       external_stage     = COALESCE(${input.providerStatus}, external_stage),
                       external_tag       = COALESCE(${aiExternalTag(input)}, external_tag),
                       recording_url      = COALESCE(${input.recordingUrl ?? null}, recording_url)
                 WHERE touchpoint_id = ${touchpointId}::uuid
            `);
        } catch (err) {
            console.warn(
                "[callTouchpoint] disposition columns not written (E-236 applied?):",
                err,
            );
        }

        // The denormalised current-state columns on dealer_leads.
        //
        // SKIPPED ENTIRELY when there is no honest label (an unanalysable call).
        // Writing NULL would erase a lead's existing NeoDove disposition with
        // nothing, drop the row out of the partial index that only covers
        // last_disposition IS NOT NULL, and still bump the recency guard. The
        // touchpoint already records that the call connected, so the fact is not
        // lost — only the rollup is left alone.
        if (d.disposition) {
            try {
                const at = performedAt.toISOString();
                await db.execute(sql`
                    UPDATE dealer_leads
                       SET last_disposition        = ${d.disposition},
                           last_disposition_bucket = ${d.bucket},
                           last_connect_status     = ${d.connectStatus},
                           last_disposition_at     = ${at}::timestamptz,
                           last_disposition_source = 'ai_dialer'
                     WHERE id = ${input.leadId}
                       -- The LATER CALL owns the row, whichever system observed
                       -- it. Identical guard to NeoDove's recordLeadDisposition:
                       -- there is deliberately no source precedence, because a
                       -- rule like "NeoDove beats AI" would make last_disposition
                       -- mean "the newest NeoDove one, unless there isn't one",
                       -- which no report could caption.
                       AND (last_disposition_at IS NULL
                            OR last_disposition_at <= ${at}::timestamptz)
                `);
            } catch (err) {
                console.warn(
                    "[callTouchpoint] dealer_leads disposition rollup not written:",
                    err,
                );
            }
        }

        return touchpointId;
    } catch (err) {
        console.error("[callTouchpoint] failed:", err);
        return null;
    }
}
