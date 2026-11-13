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
export type DialConflict = "same_campaign_other_lead" | "other_campaign_recent" | null;

/** Pure: does an earlier dial on this number block this one? */
export function dialConflict(
    prior: ReadonlyArray<PriorDial>,
    me: { campaignId: string; leadId: string; now: Date },
): DialConflict {
    for (const p of prior) {
        if (p.campaignId === me.campaignId && p.leadId && p.leadId !== me.leadId) return "same_campaign_other_lead";
    }
    for (const p of prior) {
        if (p.campaignId === me.campaignId) continue;
        if (p.inFlight || me.now.getTime() - p.at.getTime() < CROSS_CAMPAIGN_GAP_MS) return "other_campaign_recent";
    }
    return null;
}
