// AI dialer list item 7 — each phone number is dialled once per campaign, and
// never by two campaigns at once.
//
// Enrolment already drops a second lead on the same number (planEnrolment,
// duplicate_number). Two things slip past it and are caught here, at dial
// time, just before the call is placed:
//   - a number edited after enrolment, or the owner mobile a call captured
//     (E-379), that another lead in THIS campaign has already been dialled on;
//   - the same number being dialled by ANOTHER campaign right now, or within
//     the last two hours (two campaigns running over the same leads).
// A lead's own redials in this campaign are allowed — that is the retry rule.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasDialDispositionTables } from "@/lib/ai/storage/dialDisposition";

import { CROSS_CAMPAIGN_GAP_MS, type PriorDial } from "./dialGuardRule";
export { CROSS_CAMPAIGN_GAP_MS, dialConflict, type DialConflict, type PriorDial } from "./dialGuardRule";

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

/** The earlier dials that matter for one number. Never throws (an error = no conflict). */
export async function priorDialsFor(input: {
    phone: string;
    campaignId: string;
    campaignLeadId: string;
    now?: Date;
}): Promise<PriorDial[]> {
    const digits = input.phone.replace(/\D/g, "");
    if (digits.length < 10) return [];
    const key = digits.slice(-10);
    const since = new Date((input.now ?? new Date()).getTime() - CROSS_CAMPAIGN_GAP_MS).toISOString();
    const out: PriorDial[] = [];
    try {
        if (await hasDialDispositionTables()) {
            for (const r of rowsOf<{ campaign_id: string | null; lead_id: string | null; dialled_at: string }>(
                await db.execute(sql`
                    SELECT campaign_id, lead_id, dialled_at::text AS dialled_at
                      FROM ai_dial_dispositions
                     WHERE direction = 'outbound' AND phone_key = ${key}
                       AND (campaign_id = ${input.campaignId} OR dialled_at > ${since}::timestamptz)
                     LIMIT 50
                `),
            )) {
                out.push({ campaignId: r.campaign_id, leadId: r.lead_id, at: new Date(r.dialled_at) });
            }
        }
        // A call on that number still ringing in another running campaign
        // (its disposition is only written when it ends).
        for (const r of rowsOf<{ campaign_id: string; lead_id: string }>(
            await db.execute(sql`
                SELECT x.campaign_id, x.lead_id
                  FROM dialer_campaign_leads x
                  JOIN dealer_leads dl ON dl.id = x.lead_id
                 WHERE x.campaign_id IN (SELECT id FROM dialer_campaigns WHERE status = 'running')
                   AND x.campaign_id <> ${input.campaignId}
                   AND x.status = 'calling'
                   AND x.id <> ${input.campaignLeadId}
                   AND right(regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g'), 10) = ${key}
                 LIMIT 5
            `),
        )) {
            out.push({ campaignId: r.campaign_id, leadId: r.lead_id, at: input.now ?? new Date(), inFlight: true });
        }
    } catch (err) {
        console.warn("[dialGuard] prior dials not read:", err instanceof Error ? err.message : err);
    }
    return out;
}
