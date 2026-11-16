// AI dialer list item 5 — the zero-answer alert, the I/O half. Runs from the
// 60-second campaign window tick (resumeCampaigns.ts), at most every 10
// minutes per process. One alert per campaign per IST day, claimed in
// app_settings['dialer_zero_answer_alerts'] so two boxes never both send it.
// Needs E-373 (ai_dial_dispositions); without it nothing is checked.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasDialDispositionTables } from "@/lib/ai/storage/dialDisposition";
import { getDialerAlertSettings, sendDialerAlert } from "./dialerAlerts";
import { zeroAnswerCampaigns, type CampaignDial } from "./zeroAnswer";

export const ZERO_ANSWER_STATE_KEY = "dialer_zero_answer_alerts";
const CHECK_EVERY_MS = 10 * 60_000;
let lastCheck = 0;

/** Today in IST, YYYY-MM-DD. */
function istToday(now: Date): string {
    return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

/** Claim today's alert for a campaign; true only for the first caller. */
async function claim(day: string, campaignId: string): Promise<boolean> {
    const r = rowsOf<{ key: string }>(
        await db.execute(sql`
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (${ZERO_ANSWER_STATE_KEY},
                    jsonb_build_object('day', ${day}::text, 'sent', jsonb_build_object(${campaignId}::text, now()::text)),
                    now())
            ON CONFLICT (key) DO UPDATE
               SET value = CASE
                       WHEN app_settings.value->>'day' = ${day}::text
                       THEN jsonb_set(app_settings.value, ARRAY['sent', ${campaignId}::text], to_jsonb(now()::text))
                       ELSE EXCLUDED.value
                   END,
                   updated_at = now()
             WHERE app_settings.value->>'day' IS DISTINCT FROM ${day}::text
                OR NOT (COALESCE(app_settings.value->'sent', '{}'::jsonb) ? ${campaignId}::text)
            RETURNING key
        `),
    );
    return r.length > 0;
}

export async function checkZeroAnswer(
    now: Date = new Date(),
    opts: { force?: boolean } = {},
): Promise<{ checked: boolean; alerted: string[] }> {
    const out = { checked: false, alerted: [] as string[] };
    if (!opts.force && Date.now() - lastCheck < CHECK_EVERY_MS) return out;
    lastCheck = Date.now();
    if (!(await hasDialDispositionTables())) return out;
    const day = istToday(now);
    const dials = rowsOf<{ campaign_id: string; l1: string; l2: string; rule_no: string }>(
        await db.execute(sql`
            SELECT d.campaign_id, d.l1, d.l2, d.rule_no
              FROM ai_dial_dispositions d
              JOIN dialer_campaigns c ON c.id = d.campaign_id AND c.status = 'running'
             WHERE d.direction = 'outbound'
               AND d.campaign_id IS NOT NULL
               -- a carrier refusal is the carrier pause's job, not "nobody answered"
               AND NOT COALESCE((d.effects ->> 'carrierRefusal')::boolean, false)
               AND (d.dialled_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date
        `),
    ).map((d): CampaignDial => ({ campaignId: d.campaign_id, l1: d.l1, l2: d.l2, rule: d.rule_no }));
    out.checked = true;
    if (dials.length === 0) return out;
    const { zeroAnswerMinDials } = await getDialerAlertSettings();
    for (const hit of zeroAnswerCampaigns(dials, zeroAnswerMinDials)) {
        if (!(await claim(day, hit.campaignId))) continue;
        const name =
            rowsOf<{ name: string }>(
                await db.execute(sql`SELECT name FROM dialer_campaigns WHERE id = ${hit.campaignId}`),
            )[0]?.name ?? hit.campaignId;
        await sendDialerAlert({
            type: "dialer.zero_answer",
            title: `AI dialer: no one answered ${hit.dials} calls today on "${name}"`,
            message:
                `Campaign "${name}" has placed ${hit.dials} calls today and not one was answered by a person. ` +
                `The line is not refusing calls (that would pause the campaign), so check the caller id, ` +
                `the provider route and the agent's opening, or pause the campaign.`,
            href: `/leads/campaigns/${hit.campaignId}`,
            data: { campaignId: hit.campaignId, dials: hit.dials, day },
        });
        out.alerted.push(hit.campaignId);
    }
    return out;
}
