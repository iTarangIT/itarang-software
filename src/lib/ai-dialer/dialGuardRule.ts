// AI dialer list item 7 — each phone number is dialled once per campaign, and
// never by two campaigns at once. The pure rule; dialGuard.ts does the I/O.
//
// Enrolment already drops a second lead on the same number (planEnrolment,
// duplicate_number). Two things slip past it and are caught here, at dial
// time, just before the call is placed:
//   - a number edited after enrolment, or the owner mobile a call captured
//     (E-379), that another lead in THIS campaign has already been dialled on;
//   - the same number being dialled by ANOTHER campaign right now, or within
//     the last two hours (two campaigns running over the same leads).
// A lead's own redials in this campaign are allowed — that is the retry rule.

/** Another campaign's dial on the same number this recently blocks the dial. */
export const CROSS_CAMPAIGN_GAP_MS = 2 * 60 * 60_000;

export type PriorDial = { campaignId: string | null; leadId: string | null; at: Date; inFlight?: boolean };
/** How long to wait when another campaign's call on the number is still ringing. */
export const IN_FLIGHT_WAIT_MS = 30 * 60_000;

export type DialConflict =
    | { kind: "same_campaign_other_lead" }
    | { kind: "other_campaign_recent"; until: Date }
    | null;

/** Pure: does an earlier dial on this number block this one — and until when? */
export function dialConflict(
    prior: ReadonlyArray<PriorDial>,
    me: { campaignId: string; leadId: string; now: Date },
): DialConflict {
    for (const p of prior) {
        if (p.campaignId === me.campaignId && p.leadId && p.leadId !== me.leadId) {
            return { kind: "same_campaign_other_lead" };
        }
    }
    let until = 0;
    for (const p of prior) {
        if (p.campaignId === me.campaignId) continue;
        const end = p.inFlight ? me.now.getTime() + IN_FLIGHT_WAIT_MS : p.at.getTime() + CROSS_CAMPAIGN_GAP_MS;
        if (end > me.now.getTime()) until = Math.max(until, end);
    }
    return until ? { kind: "other_campaign_recent", until: new Date(until) } : null;
}
