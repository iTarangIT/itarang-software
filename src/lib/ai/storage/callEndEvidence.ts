// E-310 — the provider's own word on HOW a call ended, kept on ai_call_logs.
//
// classifyCallEnd (src/lib/ai-dialer/campaignLeadStatus.ts) reads the
// termination / hangup reason and the answering-machine flag, but
// until E-310 nothing stored them — so "who hung up" could not be re-read for a
// past call, and a backfill could only split silent calls by duration.
//
// Written by a guarded raw UPDATE after the ai_call_logs upsert, the same way
// E-267 transcript_turns is: the columns are NOT mirrored in schema.ts until
// both databases have them, because Drizzle names every schema column in its
// INSERT and an unapplied migration would then break every call log write.
// On a database without E-310 this logs one warning and does nothing.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export type CallEndEvidenceRow = {
    /** ElevenLabs metadata.termination_reason / Bolna telephony_data.hangup_reason, verbatim. */
    endReason?: string | null;
    /** Bolna telephony_data.answered_by_voice_mail (null when AMD is off). */
    answeredByVoicemail?: boolean | null;
};

function text(v: unknown): string | null {
    if (v == null) return null;
    const s = `${v}`.trim();
    return s ? s : null;
}

let warnedMissing = false;

export async function persistCallEndEvidence(
    callId: string | null | undefined,
    ev: CallEndEvidenceRow | null | undefined,
    logTag: string,
): Promise<void> {
    if (!callId || !ev) return;
    const endReason = text(ev.endReason);
    const vm = typeof ev.answeredByVoicemail === "boolean" ? ev.answeredByVoicemail : null;
    if (endReason == null && vm == null) return;

    try {
        // COALESCE: a redelivery that lacks a field must not wipe a value an
        // earlier event stored.
        await db.execute(
            sql`UPDATE ai_call_logs
                   SET end_reason = COALESCE(${endReason}::text, end_reason),
                       answered_by_voicemail = COALESCE(${vm}::boolean, answered_by_voicemail)
                 WHERE call_id = ${callId}`,
        );
    } catch (err) {
        const code = (err as { cause?: { code?: string } })?.cause?.code;
        if (code === "42703") {
            if (!warnedMissing) {
                warnedMissing = true;
                console.warn(
                    `[${logTag}] call end reason not stored — apply drizzle/E-310_ai_call_logs_end_reason.sql`,
                );
            }
            return;
        }
        console.error(`[${logTag}] call end evidence write failed:`, err);
    }
}
