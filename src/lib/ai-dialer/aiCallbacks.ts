// AI dialer review (23 Oct 2026, points 2, 3, 7) — the background half of the
// callback flow, run from the 60s calling-window tick (resumeCampaigns.ts), so
// the in-process ticker and /api/cron/campaign-resume share one code path.
//
//   1. sweepStaleDialing   — an AI callback re-dial whose result never came back
//                            (lost webhook) is settled from ai_call_logs, or put
//                            back on the list.
//   2. dialDueAiCallbacks  — re-dial AI callbacks that are due, inside working
//                            hours. BEHIND AI_CALLBACKS_ENABLED=1 (real money):
//                            with the flag off, AI callbacks are recorded and
//                            reported but nothing dials them.
//   3. rescoreNeedsReview  — a connected call whose analysis failed (OpenAI
//                            down, bad JSON) is analysed again, so it ends up
//                            with a score instead of none. At most 3 tries
//                            within 24h.
//
// Every claim is one atomic UPDATE … RETURNING with SKIP LOCKED, so two
// drivers ticking in the same second cannot dial the same dealer twice.
// All of it is a no-op on a database without E-356.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiCallLogs, dealerLeads, dialerCampaignLeads } from "@/lib/db/schema";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import { analyzeTranscript } from "@/lib/ai/analysis";
import { updateLeadAfterCall } from "@/lib/ai/storage/leadStore";
import { aiInterestLevelSql } from "@/lib/ai/storage/aiInterest";
import { markSalesReady } from "@/lib/leads/salesReady";
import { defaultRetryWindow } from "@/lib/queue/campaignTracker";
import { hasCallOutcomeTables, closeCallback, reopenCallback } from "@/lib/ai/storage/callOutcomeStore";
import { clampIntoWindow, isWindowOpen } from "./retryPolicy";
import type { CallEndStatus } from "./campaignLeadStatus";
import { dealerSpoke } from "./campaignLeadStatus";
import { applyPostCall, MAX_AI_CALLBACK_ATTEMPTS, preparePostCall } from "./postCallOutcome";

/** Real calls cost money — off unless a deployment opts in. */
export function aiCallbacksEnabled(): boolean {
    return process.env.AI_CALLBACKS_ENABLED === "1";
}

/** Dials placed per tick — keeps a backlog from bursting the line. */
const DIALS_PER_TICK = 2;
const RESCORES_PER_TICK = 2;
/** A re-dial with no result after this long is treated as lost. */
const STALE_DIALING_MINUTES = 20;
/** A dial our side could not place is tried again this much later. */
const TRIGGER_FAILED_GAP_MS = 30 * 60 * 1000;
const UNREACHED_GAP_MS = 2 * 60 * 60 * 1000;

function rows<T>(r: unknown): T[] {
    return ((r as { rows?: T[] }).rows ?? (r as T[])) || [];
}

export type AiCallbackTickOutcome = { dialed: number; settled: number; rescored: number };

export async function runAiCallbackTick(): Promise<AiCallbackTickOutcome> {
    const out: AiCallbackTickOutcome = { dialed: 0, settled: 0, rescored: 0 };
    if (!(await hasCallOutcomeTables())) return out;
    try {
        out.settled = await sweepStaleDialing();
    } catch (e) {
        console.error("[aiCallbacks] stale sweep failed:", e instanceof Error ? e.message : e);
    }
    if (aiCallbacksEnabled()) {
        try {
            out.dialed = await dialDueAiCallbacks();
        } catch (e) {
            console.error("[aiCallbacks] dial failed:", e instanceof Error ? e.message : e);
        }
    }
    try {
        out.rescored = await rescoreNeedsReview();
    } catch (e) {
        console.error("[aiCallbacks] rescore failed:", e instanceof Error ? e.message : e);
    }
    return out;
}

// ── 1. Lost results ─────────────────────────────────────────────────────────

async function sweepStaleDialing(): Promise<number> {
    const stale = rows<{ id: string; attempts: number; last_call_id: string | null; spoke: string | null }>(
        await db.execute(sql`
            SELECT cb.id, cb.attempts, cb.last_call_id, acl.transcript AS spoke
              FROM lead_callbacks cb
              LEFT JOIN ai_call_logs acl ON acl.call_id = cb.last_call_id
             WHERE cb.status = 'dialing'
               AND cb.last_dialed_at < now() - make_interval(mins => ${STALE_DIALING_MINUTES})
             LIMIT 20
        `),
    );
    if (stale.length === 0) return 0;
    const window = await defaultRetryWindow();
    for (const s of stale) {
        if (s.spoke && dealerSpoke(s.spoke)) {
            await closeCallback(s.id, "done", "AI called back (result settled from the call log).");
        } else if (s.attempts >= MAX_AI_CALLBACK_ATTEMPTS) {
            await closeCallback(s.id, "expired", `Not reached after ${s.attempts} AI callback attempts.`);
        } else {
            await reopenCallback(s.id, clampIntoWindow(new Date(Date.now() + UNREACHED_GAP_MS), window));
        }
    }
    return stale.length;
}

// ── 2. Re-dial due AI callbacks ─────────────────────────────────────────────

async function dialDueAiCallbacks(): Promise<number> {
    const window = await defaultRetryWindow();
    if (!isWindowOpen(new Date(), window)) return 0;

    const claimed = rows<{
        id: string;
        lead_id: string;
        provider: string | null;
        attempts: number;
        phone: string | null;
        owned: boolean;
    }>(
        await db.execute(sql`
            WITH due AS (
                SELECT id FROM lead_callbacks
                 WHERE owner_type = 'ai' AND status = 'open' AND due_at <= now()
                 ORDER BY due_at ASC
                 LIMIT ${DIALS_PER_TICK}
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE lead_callbacks cb
               SET status = 'dialing', attempts = cb.attempts + 1, last_dialed_at = now(),
                   last_call_id = NULL, updated_at = now()
              FROM due
             WHERE cb.id = due.id
            RETURNING cb.id, cb.lead_id, cb.provider, cb.attempts,
                      (SELECT phone FROM dealer_leads WHERE id = cb.lead_id) AS phone,
                      (SELECT current_owner_id IS NOT NULL OR lead_status IS NOT NULL
                         FROM dealer_leads WHERE id = cb.lead_id) AS owned
        `),
    );

    let dialed = 0;
    for (const c of claimed) {
        // A person picked the lead up since the request: the AI stands down.
        if (c.owned) {
            await closeCallback(c.id, "cancelled", "A person now owns this lead — AI callback not placed.");
            continue;
        }
        if (!c.phone) {
            await closeCallback(c.id, "cancelled", "Lead has no phone number.");
            continue;
        }
        const provider = (c.provider ?? "bolna").toLowerCase();
        let res: { success: boolean; call_id?: string; error?: string };
        try {
            res = (provider === "elevenlabs"
                ? await triggerElevenLabsCall({ phone: c.phone, leadId: c.lead_id, bypassIdempotency: true })
                : await triggerBolnaCall({ phone: c.phone, leadId: c.lead_id, bypassIdempotency: true })) as typeof res;
        } catch (e) {
            res = { success: false, error: e instanceof Error ? e.message : String(e) };
        }

        if (res.success && res.call_id) {
            await db.execute(sql`
                UPDATE lead_callbacks SET last_call_id = ${res.call_id}, updated_at = now() WHERE id = ${c.id}
            `);
            dialed++;
            console.log("[aiCallbacks] AI callback placed", { callbackId: c.id, leadId: c.lead_id, callId: res.call_id });
            continue;
        }
        console.warn("[aiCallbacks] AI callback not placed", { callbackId: c.id, error: res.error });
        // The dial never left our side — refund it.
        await db.execute(sql`
            UPDATE lead_callbacks SET attempts = GREATEST(attempts - 1, 0), updated_at = now() WHERE id = ${c.id}
        `);
        if (c.attempts > MAX_AI_CALLBACK_ATTEMPTS + 5) {
            await closeCallback(c.id, "expired", `AI callback could not be placed: ${res.error ?? "unknown error"}`);
        } else {
            await reopenCallback(c.id, clampIntoWindow(new Date(Date.now() + TRIGGER_FAILED_GAP_MS), window));
        }
    }
    return dialed;
}

// ── 3. Re-score calls whose analysis failed ─────────────────────────────────

async function rescoreNeedsReview(): Promise<number> {
    const claimed = rows<{
        call_id: string;
        provider: "bolna" | "elevenlabs" | null;
        lead_id: string | null;
        campaign_id: string | null;
        campaign_lead_id: string | null;
        campaign_status: string | null;
    }>(
        await db.execute(sql`
            WITH due AS (
                SELECT call_id FROM ai_call_outcomes
                 WHERE category = 'needs_review' AND rescore_attempts < 3
                   AND created_at > now() - interval '24 hours'
                   AND updated_at < now() - interval '10 minutes'
                 ORDER BY created_at ASC
                 LIMIT ${RESCORES_PER_TICK}
                 FOR UPDATE SKIP LOCKED
            )
            UPDATE ai_call_outcomes o
               SET rescore_attempts = o.rescore_attempts + 1, updated_at = now()
              FROM due
             WHERE o.call_id = due.call_id
            RETURNING o.call_id, o.provider, o.lead_id, o.campaign_id, o.campaign_lead_id, o.campaign_status
        `),
    );

    let rescored = 0;
    for (const c of claimed) {
        if (!c.lead_id) continue;
        const log = (
            await db
                .select({ id: aiCallLogs.id, status: aiCallLogs.status, transcript: aiCallLogs.transcript })
                .from(aiCallLogs)
                .where(eq(aiCallLogs.call_id, c.call_id))
                .limit(1)
        )[0];
        if (!log?.transcript || log.status !== "needs_review") continue;

        const analysis = await analyzeTranscript(log.transcript);
        if (analysis.status === "failed") continue;

        const score = analysis.band === null ? 0 : analysis.intent_score;
        const summary = analysis.memory?.intent_summary
            ? `${analysis.band ?? "dropped_empty"} — ${analysis.memory.intent_summary}`
            : `${analysis.band ?? "dropped_empty"} — ${analysis.info_signals_count}/5 signals disclosed`;

        await db
            .update(aiCallLogs)
            .set({
                status: "completed",
                summary,
                intent_score: score,
                intent_reason: analysis.memory?.intent_summary ?? null,
                next_action: analysis.action,
                scoring_version: analysis.scoring_version,
                extraction_version: analysis.extraction_version,
                calibration_set_hash: analysis.calibration_set_hash,
                signals: analysis.signals,
                score_breakdown: analysis.score_breakdown,
                band: analysis.band,
                call_status: analysis.call_status,
                info_signals_count: analysis.info_signals_count,
                updated_at: new Date(),
            })
            .where(eq(aiCallLogs.id, log.id));

        if (analysis.band !== null) {
            const lead = await db.query.dealerLeads.findFirst({ where: (l, { eq }) => eq(l.id, c.lead_id!) });
            if (lead) {
                const updated = updateLeadAfterCall(
                    {
                        ...lead,
                        follow_up_history: (lead.follow_up_history as unknown[]) || [],
                        memory: (lead.memory as Record<string, unknown> | null) ?? null,
                    },
                    {
                        transcript: log.transcript,
                        outcome: analysis.outcome,
                        memory: analysis.memory,
                        provider: c.provider ?? "bolna",
                        intentScore: analysis.intent_score,
                        band: analysis.band,
                        callStatus: analysis.call_status,
                        infoSignalsCount: analysis.info_signals_count,
                        signals: analysis.signals,
                        scoreBreakdown: analysis.score_breakdown,
                        scoringVersion: analysis.scoring_version,
                        extractionVersion: analysis.extraction_version,
                        calibrationSetHash: analysis.calibration_set_hash,
                        hardNegative: analysis.hard_negative,
                    },
                );
                await db
                    .update(dealerLeads)
                    .set({
                        follow_up_history: updated.follow_up_history,
                        total_attempts: updated.total_attempts,
                        final_intent_score: updated.final_intent_score,
                        current_status: updated.current_status,
                        interest_level: aiInterestLevelSql(updated.interest_level ?? null),
                        call_status: updated.call_status,
                        info_signals_count: updated.info_signals_count,
                        intent_band: updated.intent_band,
                        memory: updated.memory,
                    })
                    .where(eq(dealerLeads.id, lead.id));
                if (updated.current_status === "qualified") {
                    await markSalesReady(db, { leadId: lead.id, reason: "ai_qualified", actorId: null });
                }
            }
        }

        await db
            .update(dialerCampaignLeads)
            .set({ intent_score: score })
            .where(eq(dialerCampaignLeads.bolna_call_id, c.call_id));

        const callEnd = { status: (c.campaign_status ?? "completed") as CallEndStatus, outcome: null };
        const plan = await preparePostCall({ callEnd, analysis, transcript: log.transcript, leadId: c.lead_id });
        await applyPostCall({
            provider: c.provider ?? "bolna",
            callId: c.call_id,
            leadId: c.lead_id,
            plan,
            callEnd,
            band: analysis.band,
            intentScore: score,
            summary: analysis.memory?.intent_summary ?? null,
            transcript: log.transcript,
            requestedText: analysis.signals.callback_when || null,
            // The campaign row was finalized when the call ended — no retry now.
            campaign: { campaignId: c.campaign_id, campaignLeadId: c.campaign_lead_id, retryAt: null },
        });
        rescored++;
        console.log("[aiCallbacks] re-scored a needs_review call", { callId: c.call_id, band: analysis.band, score });
    }
    return rescored;
}
