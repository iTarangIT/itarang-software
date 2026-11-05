// Dispositions v3 (E-373) — store one verdict per AI dial, and act on it.
//
// Called from every place a dial ends:
//   - finalizeElevenLabsCall (both branches)       — a conversation existed
//   - webhookHandler call_initiation_failure        — ElevenLabs could not place it
//   - advanceCampaign trigger failure / exception   — the provider refused at once
//
// What it writes:
//   ai_dial_dispositions  the L1 / L2 / L3 and its evidence (upsert on dial_key,
//                         so a webhook retry or a poll tick re-writes the same row)
//   dialer_number_stats   the per-number counters — ONLY on the first write of a
//                         dial, so a retry never counts twice
//   dealer_lead_phone_type  the switchboard / dead-number mark that retires the
//                         number (IVR, tracking number, SIP 404 / 410)
//
// Raw SQL behind a to_regclass probe: without E-373 nothing is stored and the
// dialer behaves as before. Never throws — a disposition must not fail a call
// finalization or stall the campaign advance that follows it.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    DISPOSITION_V3_VERSION,
    dispositionForDial,
    type DialEvidence,
    type DispositionV3,
    type DispositionV3Input,
} from "@/lib/ai-dialer/dispositionV3";
import { phoneKey } from "@/lib/ai-dialer/numberHygiene";
import { markNumber } from "@/lib/ai-dialer/phoneTypeStore";

const PROBE_TTL_MS = 5 * 60 * 1000;
let probe: { at: number; ok: boolean } | null = null;

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

export async function hasDialDispositionTables(): Promise<boolean> {
    if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.ok;
    try {
        const r = await db.execute(sql`
            SELECT to_regclass('public.ai_dial_dispositions') IS NOT NULL
               AND to_regclass('public.dialer_number_stats') IS NOT NULL
               AND to_regclass('public.ai_redial_plan') IS NOT NULL AS ok
        `);
        probe = { at: Date.now(), ok: !!rowsOf<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

/** Test seam: forget the cached probe. */
export function resetDialDispositionProbe(): void {
    probe = null;
}

/** Two "user disconnected" in a row on one number: our caller ID may be tagged as spam. */
export const REJECT_STREAK_CALLER_ID_CHECK = 2;

export type RecordDialInput = {
    /** The conversation id, or `trigger:<campaign_lead_id>:<attempt>`. */
    dialKey: string;
    leadId: string | null;
    campaignId?: string | null;
    phone?: string | null;
    direction?: "outbound" | "inbound";
    dialledAt?: Date | null;
    evidence: DialEvidence;
};

export type RecordedDial = { d: DispositionV3; input: DispositionV3Input; inserted: boolean };

/**
 * Map, store and act on one dial. Returns the verdict even when the tables are
 * missing (callers use it for the touchpoint label and the redial rule).
 */
export async function recordDialDisposition(input: RecordDialInput): Promise<RecordedDial> {
    const { d, input: mapped } = dispositionForDial(input.evidence);
    const out: RecordedDial = { d, input: mapped, inserted: false };
    try {
        if (!input.dialKey || !(await hasDialDispositionTables())) return out;
        const key = phoneKey(input.phone ?? null);
        const ev = input.evidence;
        const dialledAt = (input.dialledAt ?? new Date()).toISOString();
        const r = await db.execute(sql`
            INSERT INTO ai_dial_dispositions (
                dial_key, lead_id, campaign_id, phone_key, direction,
                l1, l2, l3, rule_no, rules_version, sip_code,
                answered_by, call_result, callback_agreed, call_language,
                ended_by, end_reason_raw, duration_secs, effects, dialled_at
            ) VALUES (
                ${input.dialKey}, ${input.leadId},
                -- The finalizer runs before it knows the campaign: the row that
                -- placed this conversation does.
                COALESCE(${input.campaignId ?? null}::text, (
                    SELECT campaign_id::text FROM dialer_campaign_leads
                     WHERE bolna_call_id = ${input.dialKey} ORDER BY started_at DESC NULLS LAST LIMIT 1
                )),
                ${key},
                ${input.direction ?? "outbound"},
                ${d.l1}, ${d.l2}, ${d.l3}, ${d.rule}, ${DISPOSITION_V3_VERSION}, ${d.sipCode},
                ${ev.answeredBy ?? null}, ${ev.callResult ?? null}, ${mapped.callbackAgreed},
                ${ev.callLanguage ?? null}, ${mapped.endedBy ?? null}, ${ev.terminationReason ?? null},
                ${mapped.durationSecs}, ${JSON.stringify(d.effects)}::jsonb, ${dialledAt}::timestamptz
            )
            ON CONFLICT (dial_key) DO UPDATE SET
                lead_id         = COALESCE(EXCLUDED.lead_id, ai_dial_dispositions.lead_id),
                campaign_id     = COALESCE(EXCLUDED.campaign_id, ai_dial_dispositions.campaign_id),
                phone_key       = COALESCE(EXCLUDED.phone_key, ai_dial_dispositions.phone_key),
                l1 = EXCLUDED.l1, l2 = EXCLUDED.l2, l3 = EXCLUDED.l3,
                rule_no = EXCLUDED.rule_no, rules_version = EXCLUDED.rules_version,
                sip_code        = COALESCE(EXCLUDED.sip_code, ai_dial_dispositions.sip_code),
                answered_by     = COALESCE(EXCLUDED.answered_by, ai_dial_dispositions.answered_by),
                call_result     = COALESCE(EXCLUDED.call_result, ai_dial_dispositions.call_result),
                callback_agreed = COALESCE(EXCLUDED.callback_agreed, ai_dial_dispositions.callback_agreed),
                call_language   = COALESCE(EXCLUDED.call_language, ai_dial_dispositions.call_language),
                ended_by        = COALESCE(EXCLUDED.ended_by, ai_dial_dispositions.ended_by),
                end_reason_raw  = COALESCE(EXCLUDED.end_reason_raw, ai_dial_dispositions.end_reason_raw),
                duration_secs   = COALESCE(EXCLUDED.duration_secs, ai_dial_dispositions.duration_secs),
                effects = EXCLUDED.effects,
                updated_at = now()
            RETURNING (xmax = 0) AS inserted
        `);
        out.inserted = !!rowsOf<{ inserted: boolean }>(r)[0]?.inserted;
        if (out.inserted) await applyEffects(input, d, key);
    } catch (err) {
        console.error(
            "[dialDisposition.recordDialDisposition] failed:",
            err instanceof Error ? err.message : err,
        );
    }
    return out;
}

/** Counters and number marks — once per dial. */
async function applyEffects(input: RecordDialInput, d: DispositionV3, key: string | null): Promise<void> {
    const e = d.effects;
    if (input.leadId && e.retireNumber) {
        // A Google tracking number behaves like a switchboard: it answers and
        // reaches nobody. Both are skipped by later dials and listed under
        // Needs dealer mobile.
        await markNumber(input.leadId, d.rule === "3" ? "dead_number" : "switchboard");
    }
    if (!key) return;
    // A dial that reached a person resets the reject streak; another reject adds one.
    const rejectDelta = e.rejectCounter ? 1 : 0;
    const resetStreak = !e.rejectCounter && d.connectStatus === "connected";
    await db.execute(sql`
        INSERT INTO dialer_number_stats (
            phone_key, lead_id, reject_streak, caller_id_check_at,
            dead_audio_count, intro_hangup_count, last_l2, last_dial_at, updated_at
        ) VALUES (
            ${key}, ${input.leadId}, ${rejectDelta},
            ${rejectDelta >= REJECT_STREAK_CALLER_ID_CHECK ? sql`now()` : sql`NULL`},
            ${e.deadAudioCounter ? 1 : 0}, ${e.introHangupCounter ? 1 : 0},
            ${d.l3 ?? d.l2}, now(), now()
        )
        ON CONFLICT (phone_key) DO UPDATE SET
            lead_id = COALESCE(EXCLUDED.lead_id, dialer_number_stats.lead_id),
            reject_streak = CASE
                WHEN ${rejectDelta} > 0 THEN dialer_number_stats.reject_streak + 1
                WHEN ${resetStreak} THEN 0
                ELSE dialer_number_stats.reject_streak END,
            caller_id_check_at = CASE
                WHEN ${rejectDelta} > 0
                 AND dialer_number_stats.reject_streak + 1 >= ${REJECT_STREAK_CALLER_ID_CHECK}
                THEN COALESCE(dialer_number_stats.caller_id_check_at, now())
                WHEN ${resetStreak} THEN NULL
                ELSE dialer_number_stats.caller_id_check_at END,
            dead_audio_count = dialer_number_stats.dead_audio_count + EXCLUDED.dead_audio_count,
            intro_hangup_count = dialer_number_stats.intro_hangup_count + EXCLUDED.intro_hangup_count,
            last_l2 = EXCLUDED.last_l2,
            last_dial_at = now(),
            updated_at = now()
    `);
}

export type NumberStats = {
    rejectStreak: number;
    callerIdCheck: boolean;
    deadAudioCount: number;
    introHangupCount: number;
};

/** Per-number counters for the redial planner (null without E-373 or a row). */
export async function numberStatsFor(phone: string | null | undefined): Promise<NumberStats | null> {
    const key = phoneKey(phone ?? null);
    if (!key || !(await hasDialDispositionTables())) return null;
    try {
        const r = rowsOf<{
            reject_streak: number;
            caller_id_check_at: string | null;
            dead_audio_count: number;
            intro_hangup_count: number;
        }>(
            await db.execute(sql`
                SELECT reject_streak, caller_id_check_at, dead_audio_count, intro_hangup_count
                  FROM dialer_number_stats WHERE phone_key = ${key}
            `),
        )[0];
        if (!r) return null;
        return {
            rejectStreak: Number(r.reject_streak),
            callerIdCheck: !!r.caller_id_check_at,
            deadAudioCount: Number(r.dead_audio_count),
            introHangupCount: Number(r.intro_hangup_count),
        };
    } catch {
        return null;
    }
}

/** The latest stored v3 disposition per lead, for list / detail decoration. */
export async function latestDispositionsFor(
    dialKeys: string[],
): Promise<Map<string, { l1: string; l2: string; l3: string | null; sipCode: number | null; rule: string }>> {
    const out = new Map<string, { l1: string; l2: string; l3: string | null; sipCode: number | null; rule: string }>();
    const keys = [...new Set(dialKeys.filter(Boolean))];
    if (keys.length === 0 || !(await hasDialDispositionTables())) return out;
    try {
        const r = rowsOf<{ dial_key: string; l1: string; l2: string; l3: string | null; sip_code: number | null; rule_no: string }>(
            await db.execute(sql`
                SELECT dial_key, l1, l2, l3, sip_code, rule_no
                  FROM ai_dial_dispositions
                 WHERE dial_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
            `),
        );
        for (const row of r) {
            out.set(row.dial_key, {
                l1: row.l1,
                l2: row.l2,
                l3: row.l3,
                sipCode: row.sip_code == null ? null : Number(row.sip_code),
                rule: row.rule_no,
            });
        }
    } catch (err) {
        console.error("[dialDisposition.latestDispositionsFor] failed:", err instanceof Error ? err.message : err);
    }
    return out;
}

/** The dial key for a dial that never got a conversation id. */
export function triggerDialKey(campaignLeadId: string | number, attempt: number): string {
    return `trigger:${campaignLeadId}:${attempt}`;
}
