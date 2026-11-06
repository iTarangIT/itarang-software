// D1 (E-360) + Priya KPI task 10 (E-374) — pause an AI-dialer campaign when
// the carrier keeps refusing calls, probe the line, and pick up where it stopped.
//
// advanceCampaign (synchronous trigger failures) and the ElevenLabs webhook
// (call_initiation_failure) report every dial here. A refusal on OUR side —
// SIP 401/403/407/429/503, or a config error (carrierPause.lineBlockKind) —
// adds one to the campaign's run; anything that reached the carrier (a placed
// call, busy, no answer, a dead number) resets it. At the threshold:
//
//   1. the campaign goes to 'paused' (one writer wins: status = 'running' guard);
//   2. the refused rows go back to the queue as 'pending' with their attempts
//      refunded, and the first of them is saved as the cursor — so a resume
//      dials them again in queue order, from the cursor;
//   3. ONE alert goes to Settings › Dialer alerts;
//   4. a carrier pause books a probe 30 min on (inside 10:00–19:00 IST). The
//      window tick runs it (runCarrierProbes); a placed probe resumes the
//      campaign, a refused one books the next, up to 6. The second pause on
//      the same IST day, a setup error, or 6 refused probes wait for a person,
//      whose Resume runs the probe first (resumeAfterProbe).
//
// Raw SQL, not in schema.ts. Without E-360 nothing pauses (as before); without
// E-374 the E-360 pause works and nothing is probed. Nothing here throws.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    afterProbe,
    CARRIER_PAUSE_REASON,
    decidePause,
    lineBlockKind,
    MAX_PROBES,
    pauseThreshold,
    probeDue,
    SETUP_PAUSE_REASON,
    withinProbeHours,
    type LineBlockKind,
} from "./carrierPause";
import { extractSipCode } from "./dispositionV3";
import { getDialerAlertSettings, sendDialerAlert } from "./dialerAlerts";

export { CARRIER_PAUSE_REASON, SETUP_PAUSE_REASON } from "./carrierPause";

const PROBE_TTL_MS = 5 * 60 * 1000;
let probe: { at: number; ok: boolean } | null = null;
let probeCols: { at: number; ok: boolean } | null = null;

function rows<T>(r: unknown): T[] {
    return ((r as { rows?: T[] }).rows ?? (r as T[])) || [];
}

export async function hasLineHealthTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.ok;
    try {
        const r = await db.execute(sql`
            SELECT to_regclass('public.dialer_campaign_line_health') IS NOT NULL AS ok
        `);
        probe = { at: Date.now(), ok: !!rows<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

/** E-374 — the pause / cursor / probe columns. */
export async function hasProbeColumns(): Promise<boolean> {
    if (probeCols && Date.now() - probeCols.at < PROBE_TTL_MS) return probeCols.ok;
    try {
        const r = await db.execute(sql`
            SELECT count(*)::int AS n FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'dialer_campaign_line_health'
               AND column_name IN ('next_probe_at', 'cursor_queue_position', 'pauses_today', 'needs_manual_resume')
        `);
        probeCols = { at: Date.now(), ok: Number(rows<{ n: number }>(r)[0]?.n ?? 0) === 4 };
    } catch {
        probeCols = { at: Date.now(), ok: false };
    }
    return probeCols.ok;
}

/** Test seam. */
export function resetLineHealthProbes(): void {
    probe = null;
    probeCols = null;
}

/**
 * Record one dial result for the campaign. `outcome` is the call_outcome
 * written for a failed dial ("trigger_failed: …", or an initiation failure
 * carrying "(sip status: …)"), or null when the call was placed. Returns true
 * when the campaign has just been paused — the caller must stop dialling.
 */
export async function noteTriggerResult(
    campaignId: string,
    outcome: string | null,
): Promise<boolean> {
    if (!(await hasLineHealthTable())) return false;
    try {
        const kind = lineBlockKind(outcome);
        if (!kind) {
            // Reached the carrier. Only touches a row that has a run to reset.
            await db.execute(sql`
                UPDATE dialer_campaign_line_health
                   SET consecutive_line_blocked = 0, updated_at = now()
                 WHERE campaign_id = ${campaignId} AND consecutive_line_blocked > 0
            `);
            return false;
        }
        const detail = (outcome ?? "").replace(/^trigger_(?:failed|exception):\s*/i, "").slice(0, 300);
        const r = await db.execute(sql`
            INSERT INTO dialer_campaign_line_health
                   (campaign_id, consecutive_line_blocked, last_carrier_error, updated_at)
            VALUES (${campaignId}, 1, ${detail}, now())
            ON CONFLICT (campaign_id) DO UPDATE
               SET consecutive_line_blocked = dialer_campaign_line_health.consecutive_line_blocked + 1,
                   last_carrier_error = EXCLUDED.last_carrier_error,
                   updated_at = now()
            RETURNING consecutive_line_blocked
        `);
        const count = Number(rows<{ consecutive_line_blocked: number }>(r)[0]?.consecutive_line_blocked ?? 0);
        if (count < pauseThreshold(kind)) return false;
        await pauseForLineBlock(campaignId, kind, detail, count);
        return true;
    } catch (err) {
        console.error("[lineHealth] noteTriggerResult failed:", err instanceof Error ? err.message : err);
        return false;
    }
}

/**
 * Park the campaign, hand the refused rows back to the queue, save the cursor,
 * book the probe and tell the team — once. The `status = 'running'` guard
 * makes a second caller in the same second a no-op. resume_after stays NULL, so
 * the window ticker never wakes it; only a probe or a person does.
 */
async function pauseForLineBlock(
    campaignId: string,
    kind: LineBlockKind,
    detail: string,
    count: number,
): Promise<void> {
    const r = await db.execute(sql`
        UPDATE dialer_campaigns
           SET status = 'paused', paused_at = now(), resume_after = NULL
         WHERE id = ${campaignId} AND status = 'running'
        RETURNING name
    `);
    const paused = rows<{ name: string }>(r)[0];
    const now = new Date();
    const decision = decidePause({ kind, now, previous: await previousPause(campaignId) });

    if (!(await hasProbeColumns())) {
        // E-360 only: the pause reason, nothing else.
        await db.execute(sql`
            UPDATE dialer_campaign_line_health
               SET pause_reason = ${decision.reason}, paused_at = now(), updated_at = now()
             WHERE campaign_id = ${campaignId}
        `);
    } else if (paused) {
        // Refused rows back to the queue. Their attempts were already refunded
        // (counted: false, attempt_count - 1) when each refusal was recorded;
        // the booked +30 min retry is dropped so the resume dials them in queue
        // order. The lowest queue position is the cursor.
        const handed = rows<{ queue_position: number; lead_id: string }>(
            await db.execute(sql`
                UPDATE dialer_campaign_leads
                   SET status = 'pending', next_attempt_at = NULL, completed_at = NULL
                 WHERE campaign_id = ${campaignId}
                   AND status NOT IN ('pending', 'calling')
                   AND next_attempt_at IS NOT NULL
                   AND (attempt_history -> -1 ->> 'counted') = 'false'
                RETURNING queue_position, lead_id
            `),
        );
        const cursor = handed.reduce<{ queue_position: number; lead_id: string } | null>(
            (min, row) => (min == null || row.queue_position < min.queue_position ? row : min),
            null,
        );
        await db.execute(sql`
            UPDATE dialer_campaign_line_health
               SET pause_reason = ${decision.reason},
                   paused_at = now(),
                   block_kind = ${kind},
                   sip_code = ${extractSipCode(detail)},
                   cursor_queue_position = ${cursor?.queue_position ?? null},
                   cursor_lead_id = ${cursor?.lead_id ?? null},
                   refunded_rows = ${handed.length},
                   pause_day = ${decision.pauseDay}::date,
                   pauses_today = ${decision.pausesToday},
                   probe_count = 0,
                   next_probe_at = ${decision.nextProbeAt ? decision.nextProbeAt.toISOString() : null}::timestamptz,
                   last_probe_at = NULL,
                   last_probe_result = NULL,
                   needs_manual_resume = ${decision.needsManualResume},
                   alert_sent_at = now(),
                   updated_at = now()
             WHERE campaign_id = ${campaignId}
        `);
        // Counters are derived from the rows.
        const { syncCampaignCounters } = await import("@/lib/queue/campaignTracker");
        await syncCampaignCounters(campaignId);
    }
    if (!paused) return; // already paused / stopped by someone else — no second alert

    console.warn("[lineHealth] line blocked — campaign paused", { campaignId, kind, count, detail, decision });
    const probeLine =
        decision.reason === SETUP_PAUSE_REASON
            ? "This is a setting on our side, not the carrier: fix it, then press Resume."
            : decision.needsManualResume
              ? "This is the second pause today, so it waits for someone to press Resume (a test call runs first)."
              : `A test call to the probe number runs every 30 minutes between 10:00 and 19:00 (up to ${MAX_PROBES}); the campaign resumes on its own once one goes through.`;
    await sendDialerAlert({
        type: "dialer.campaign_paused",
        title:
            decision.reason === SETUP_PAUSE_REASON
                ? `AI dialer paused: a setup error refused ${count} calls`
                : `AI dialer paused: carrier refused ${count} calls in a row`,
        message:
            `Campaign "${paused.name}" was paused because ${count} calls in a row were refused` +
            (detail ? ` ("${detail}")` : "") +
            `. No leads were used up; the refused leads are back in the queue and it will pick up from the first of them. ` +
            probeLine,
        href: `/leads/campaigns/${campaignId}`,
        data: { campaignId, consecutiveRefusals: count, carrierError: detail, kind, ...decision },
    });
}

async function previousPause(campaignId: string): Promise<{ pauseDay: string | null; pausesToday: number | null }> {
    if (!(await hasProbeColumns())) return { pauseDay: null, pausesToday: null };
    const r = rows<{ pause_day: string | null; pauses_today: number | null }>(
        await db.execute(sql`
            SELECT pause_day::text AS pause_day, pauses_today FROM dialer_campaign_line_health
             WHERE campaign_id = ${campaignId}
        `),
    )[0];
    return { pauseDay: r?.pause_day ?? null, pausesToday: r?.pauses_today ?? null };
}

/**
 * Resume: forget the run, the pause and its probes. The pause DAY and its
 * count stay, so a second pause the same day still waits for a person.
 */
export async function clearCarrierPause(campaignId: string): Promise<void> {
    if (!(await hasLineHealthTable())) return;
    try {
        if (await hasProbeColumns()) {
            await db.execute(sql`
                UPDATE dialer_campaign_line_health
                   SET consecutive_line_blocked = 0, pause_reason = NULL, paused_at = NULL,
                       next_probe_at = NULL, needs_manual_resume = false, updated_at = now()
                 WHERE campaign_id = ${campaignId}
            `);
            return;
        }
        await db.execute(sql`
            UPDATE dialer_campaign_line_health
               SET consecutive_line_blocked = 0, pause_reason = NULL, paused_at = NULL, updated_at = now()
             WHERE campaign_id = ${campaignId}
        `);
    } catch (err) {
        console.error("[lineHealth] clearCarrierPause failed:", err instanceof Error ? err.message : err);
    }
}

// ── Probes ───────────────────────────────────────────────────────────────────

export type PlaceProbe = (number: string) => Promise<{ placed: boolean; detail: string }>;

async function defaultPlaceProbe(number: string) {
    const { placeProbeCall } = await import("@/lib/ai/elevenlabs/probeCall");
    return placeProbeCall(number);
}

async function resumeCampaign(campaignId: string): Promise<void> {
    const r = rows<{ provider: string; status: string }>(
        await db.execute(sql`SELECT provider, status FROM dialer_campaigns WHERE id = ${campaignId}`),
    )[0];
    if (!r || r.status !== "paused") return;
    await clearCarrierPause(campaignId);
    // Dynamic: startCampaign → advanceCampaign → this module.
    const { startDraftCampaign } = await import("@/lib/queue/startCampaign");
    await startDraftCampaign(campaignId, r.provider as "elevenlabs" | "bolna", { resetStartedAt: false });
}

/**
 * One pass of the automatic probes, from the 60-second window tick. Each due
 * probe is claimed by clearing next_probe_at first, so two boxes ticking in the
 * same second never ring the probe phone twice.
 */
export async function runCarrierProbes(
    now: Date = new Date(),
    place: PlaceProbe = defaultPlaceProbe,
): Promise<{ probed: number; resumed: string[] }> {
    const out = { probed: 0, resumed: [] as string[] };
    if (!withinProbeHours(now) || !(await hasLineHealthTable()) || !(await hasProbeColumns())) return out;
    const due = rows<{ campaign_id: string; probe_count: number; next_probe_at: string }>(
        await db.execute(sql`
            SELECT h.campaign_id, h.probe_count, h.next_probe_at::text AS next_probe_at
              FROM dialer_campaign_line_health h
              JOIN dialer_campaigns c ON c.id = h.campaign_id AND c.status = 'paused'
             WHERE h.pause_reason = ${CARRIER_PAUSE_REASON}
               AND NOT h.needs_manual_resume
               AND h.next_probe_at IS NOT NULL
               AND h.next_probe_at <= ${now.toISOString()}::timestamptz
               AND h.probe_count < ${MAX_PROBES}
        `),
    );
    if (due.length === 0) return out;
    const { probeNumber } = await getDialerAlertSettings();
    for (const row of due) {
        if (
            !probeDue({
                reason: CARRIER_PAUSE_REASON,
                needsManualResume: false,
                nextProbeAt: new Date(row.next_probe_at),
                probesUsed: Number(row.probe_count),
                now,
            })
        ) {
            continue;
        }
        const claimed = rows<{ campaign_id: string }>(
            await db.execute(sql`
                UPDATE dialer_campaign_line_health
                   SET next_probe_at = NULL, updated_at = now()
                 WHERE campaign_id = ${row.campaign_id} AND next_probe_at IS NOT NULL
                RETURNING campaign_id
            `),
        );
        if (claimed.length === 0) continue;
        try {
            const result = await place(probeNumber);
            const probesUsed = Number(row.probe_count) + 1;
            const next = afterProbe({ placed: result.placed, probesUsed, now });
            out.probed++;
            await db.execute(sql`
                UPDATE dialer_campaign_line_health
                   SET probe_count = ${probesUsed},
                       last_probe_at = now(),
                       last_probe_result = ${(result.placed ? "placed: " : "refused: ") + result.detail.slice(0, 200)},
                       next_probe_at = ${next.kind === "again" ? next.nextProbeAt.toISOString() : null}::timestamptz,
                       needs_manual_resume = ${next.kind === "exhausted"},
                       updated_at = now()
                 WHERE campaign_id = ${row.campaign_id}
            `);
            if (next.kind === "resume") {
                await resumeCampaign(row.campaign_id);
                out.resumed.push(row.campaign_id);
            }
        } catch (err) {
            console.error("[lineHealth] probe failed:", err instanceof Error ? err.message : err);
        }
    }
    return out;
}

/**
 * A person pressed Resume on a campaign the line paused. A carrier pause runs
 * the probe first and refuses to resume while the line still refuses; a setup
 * pause has nothing to probe (the setting was fixed or it was not). Returns
 * ok: true when the caller may go on and resume.
 */
export async function resumeAfterProbe(
    campaignId: string,
    place: PlaceProbe = defaultPlaceProbe,
): Promise<{ ok: true; probed: boolean } | { ok: false; error: string }> {
    if (!(await hasLineHealthTable())) return { ok: true, probed: false };
    const r = rows<{ pause_reason: string | null }>(
        await db.execute(sql`
            SELECT pause_reason FROM dialer_campaign_line_health WHERE campaign_id = ${campaignId}
        `),
    )[0];
    if (r?.pause_reason !== CARRIER_PAUSE_REASON) return { ok: true, probed: false };
    const { probeNumber } = await getDialerAlertSettings();
    const result = await place(probeNumber);
    if (await hasProbeColumns()) {
        await db.execute(sql`
            UPDATE dialer_campaign_line_health
               SET last_probe_at = now(),
                   last_probe_result = ${(result.placed ? "placed (manual): " : "refused (manual): ") + result.detail.slice(0, 200)},
                   updated_at = now()
             WHERE campaign_id = ${campaignId}
        `);
    }
    if (!result.placed) {
        return {
            ok: false,
            error: `The test call to ${probeNumber} was refused too ("${result.detail}"). The line is still blocked; the campaign stays paused.`,
        };
    }
    return { ok: true, probed: true };
}

// ── Read side ────────────────────────────────────────────────────────────────

export type CarrierPause = {
    pauseReason: string;
    lastCarrierError: string | null;
    pausedAt: string | null;
    /** E-374 — null on a database without it. */
    sipCode: number | null;
    cursorQueuePosition: number | null;
    cursorLeadId: string | null;
    refundedRows: number | null;
    pausesToday: number | null;
    probeCount: number | null;
    maxProbes: number;
    nextProbeAt: string | null;
    lastProbeAt: string | null;
    lastProbeResult: string | null;
    needsManualResume: boolean;
};

/** Pause details for the campaign list / detail. Empty map without E-360. */
export async function carrierPausesFor(campaignIds: string[]): Promise<Map<string, CarrierPause>> {
    const out = new Map<string, CarrierPause>();
    if (campaignIds.length === 0 || !(await hasLineHealthTable())) return out;
    try {
        const full = await hasProbeColumns();
        const r = await db.execute(sql`
            SELECT to_jsonb(h) AS h FROM dialer_campaign_line_health h
             WHERE h.pause_reason IS NOT NULL
               AND h.campaign_id IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})
        `);
        for (const { h } of rows<{ h: Record<string, unknown> }>(r)) {
            const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
            const num = (v: unknown) => (v == null ? null : Number(v));
            out.set(String(h.campaign_id), {
                pauseReason: String(h.pause_reason),
                lastCarrierError: (h.last_carrier_error as string | null) ?? null,
                pausedAt: iso(h.paused_at),
                sipCode: full ? num(h.sip_code) : null,
                cursorQueuePosition: full ? num(h.cursor_queue_position) : null,
                cursorLeadId: full ? ((h.cursor_lead_id as string | null) ?? null) : null,
                refundedRows: full ? num(h.refunded_rows) : null,
                pausesToday: full ? num(h.pauses_today) : null,
                probeCount: full ? num(h.probe_count) : null,
                maxProbes: MAX_PROBES,
                nextProbeAt: full ? iso(h.next_probe_at) : null,
                lastProbeAt: full ? iso(h.last_probe_at) : null,
                lastProbeResult: full ? ((h.last_probe_result as string | null) ?? null) : null,
                needsManualResume: full ? h.needs_manual_resume === true : true,
            });
        }
    } catch (err) {
        console.error("[lineHealth] carrierPausesFor failed:", err instanceof Error ? err.message : err);
    }
    return out;
}
