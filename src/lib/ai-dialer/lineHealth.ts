// D1 (E-360) — pause an AI-dialer campaign when the carrier keeps refusing calls.
//
// advanceCampaign reports every trigger result here. A line-blocked failure
// (SIP 401/403/407/429, config error — retryPolicy.isLineBlockedFailure) adds
// one to the campaign's run; anything that reached the carrier resets it. At
// CARRIER_PAUSE_THRESHOLD in a row the campaign is set to 'paused' with
// pause_reason 'carrier_refused', one alert goes out, and nothing dials —
// booked retries included — until someone presses Resume (clearCarrierPause).
//
// Raw SQL, not in schema.ts, every entry point probed with to_regclass: a
// database without E-360 keeps today's behaviour (no auto-pause) and nothing
// here throws.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emit } from "@/lib/notifications/emit";
import { ADMIN_PARTY } from "@/lib/notifications/provenance";
import { nextLineBlockedCount, shouldPauseForCarrier } from "./retryPolicy";

export const CARRIER_PAUSE_REASON = "carrier_refused";

/** Roles told when a campaign pauses itself (decided 10 Oct: Kartik, Apoorv, Aditya, it@). */
const ALERT_ROLES = ["admin", "ceo", "it"];

const PROBE_TTL_MS = 5 * 60 * 1000;
let probe: { at: number; ok: boolean } | null = null;

export async function hasLineHealthTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.ok;
    try {
        const r = (await db.execute(sql`
            SELECT to_regclass('public.dialer_campaign_line_health') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        probe = { at: Date.now(), ok: !!rows<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

function rows<T>(r: unknown): T[] {
    return ((r as { rows?: T[] }).rows ?? (r as T[])) || [];
}

/**
 * Record one trigger result for the campaign. `outcome` is the call_outcome
 * written for a failed trigger ("trigger_failed: …"), or null when the call
 * was placed. Returns true when the campaign has just been paused — the caller
 * must stop dialling at once.
 */
export async function noteTriggerResult(
    campaignId: string,
    outcome: string | null,
): Promise<boolean> {
    if (!(await hasLineHealthTable())) return false;
    try {
        if (nextLineBlockedCount(0, outcome) === 0) {
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
        if (!shouldPauseForCarrier(count)) return false;
        await pauseForCarrier(campaignId, detail, count);
        return true;
    } catch (err) {
        console.error("[lineHealth] noteTriggerResult failed:", err instanceof Error ? err.message : err);
        return false;
    }
}

/**
 * Park the campaign and tell the team, once. The `status = 'running'` guard
 * makes a second caller in the same second a no-op, so only one alert goes out.
 * resume_after stays NULL, so the window ticker never wakes it on its own.
 */
async function pauseForCarrier(campaignId: string, detail: string, count: number): Promise<void> {
    const r = await db.execute(sql`
        UPDATE dialer_campaigns
           SET status = 'paused', paused_at = now(), resume_after = NULL
         WHERE id = ${campaignId} AND status = 'running'
        RETURNING name
    `);
    const paused = rows<{ name: string }>(r)[0];
    await db.execute(sql`
        UPDATE dialer_campaign_line_health
           SET pause_reason = ${CARRIER_PAUSE_REASON}, paused_at = now(), updated_at = now()
         WHERE campaign_id = ${campaignId}
    `);
    if (!paused) return; // already paused/stopped by someone else — no second alert

    console.warn("[lineHealth] carrier refused calls — campaign paused", { campaignId, count, detail });
    const title = `AI dialer paused: carrier refused ${count} calls in a row`;
    const message =
        `Campaign "${paused.name}" was paused because the carrier refused ${count} calls in a row` +
        (detail ? ` ("${detail}")` : "") +
        `. No leads were used up. Press Resume on the campaign once the line is working.`;
    await emit({
        type: "dialer.campaign_paused",
        title,
        message,
        stage: "AI dialer",
        email: true,
        data: { campaignId, consecutiveRefusals: count, carrierError: detail },
        to: [
            {
                audience: { kind: "roles", roles: ALERT_ROLES },
                as: ADMIN_PARTY,
                href: `/leads/campaigns/${campaignId}`,
            },
        ],
    });
}

/** Resume: forget the run and the pause reason. */
export async function clearCarrierPause(campaignId: string): Promise<void> {
    if (!(await hasLineHealthTable())) return;
    try {
        await db.execute(sql`
            UPDATE dialer_campaign_line_health
               SET consecutive_line_blocked = 0, pause_reason = NULL, paused_at = NULL, updated_at = now()
             WHERE campaign_id = ${campaignId}
        `);
    } catch (err) {
        console.error("[lineHealth] clearCarrierPause failed:", err instanceof Error ? err.message : err);
    }
}

export type CarrierPause = { pauseReason: string; lastCarrierError: string | null; pausedAt: string | null };

/** Pause reasons for the campaign list / detail. Empty map without E-360. */
export async function carrierPausesFor(campaignIds: string[]): Promise<Map<string, CarrierPause>> {
    const out = new Map<string, CarrierPause>();
    if (campaignIds.length === 0 || !(await hasLineHealthTable())) return out;
    try {
        const r = await db.execute(sql`
            SELECT campaign_id, pause_reason, last_carrier_error, paused_at
              FROM dialer_campaign_line_health
             WHERE pause_reason IS NOT NULL
               AND campaign_id IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})
        `);
        for (const row of rows<{
            campaign_id: string;
            pause_reason: string;
            last_carrier_error: string | null;
            paused_at: string | Date | null;
        }>(r)) {
            out.set(row.campaign_id, {
                pauseReason: row.pause_reason,
                lastCarrierError: row.last_carrier_error,
                pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
            });
        }
    } catch (err) {
        console.error("[lineHealth] carrierPausesFor failed:", err instanceof Error ? err.message : err);
    }
    return out;
}
