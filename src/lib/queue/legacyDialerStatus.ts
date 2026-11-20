// What the legacy /api/ai-dialer/status poll may do with the Redis dialer
// session. Pure, no I/O, so vitest covers it.
//
// The route predates campaigns: it treated a session with no call for 3 minutes
// as "timed out", popped the next lead off the session queue, dialled it
// directly, and finalized the campaign 'completed' when the queue ran dry.
// Every campaign start also opens a session (startCampaign.ts), but nothing
// moves that session along — advanceCampaign owns the dialling — so while
// /leads was open the poll walked the queue at one lead per 3 minutes and
// then closed the campaign. Howrah part 1 (19 Nov 2026): closed at 15:44 IST
// with 22 automatic retries booked; Bajaj Dealers part 7 (4 Nov) the same.
//
// A session that belongs to a campaign is therefore read-only here: no dial,
// no finalize. The old timeout walk is kept for a manual queue (no campaign).

/** May the poll advance the session queue (and dial / finalize) itself? */
export function legacyTimeoutMayAdvance(session: { campaignId: string | null }): boolean {
    return !session.campaignId;
}

/** Campaign statuses after which the AI no longer dials it. */
const ENDED = new Set(["completed", "stopped", "failed"]);

/**
 * The campaign behind a session has ended (or is gone): the session should be
 * cleared so the /leads banner goes idle.
 */
export function campaignSessionEnded(campaignStatus: string | null | undefined): boolean {
    return campaignStatus == null || ENDED.has(campaignStatus);
}
