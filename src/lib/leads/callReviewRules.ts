// Who reads call reviews — the attached recordings list, call transcripts and
// the latest call in the Sales Insight drawer (tracker ID 166, item 6, 18 Oct).
//
// The decided rule: Admin, the Sales Head, the CEO and the owner of the lead.
// Everyone else who reaches the lead (the partner, Sales Insight, Sales
// Manager, Business Head) still sees the lead, but not its call reviews —
// before this they saw the list and the transcripts and were refused only
// when they opened the recording file.
//
// Pure: no db imports. The routes work out "owns the lead" themselves.

/** Same three roles as the file rule's top roles (fileRules.ts FILE_TOP_ROLES). */
export const CALL_REVIEW_ALL_ROLES = ["admin", "ceo", "sales_head"] as const;

/** Does this role read every lead's call reviews? */
export function seesEveryCallReview(role: string | null | undefined): boolean {
    return (CALL_REVIEW_ALL_ROLES as readonly string[]).includes((role ?? "").toLowerCase());
}

/** May this caller read this lead's call reviews? A missing fact is a refusal. */
export function mayReadCallReview(input: { role: string | null | undefined; ownsLead: boolean | null | undefined }): boolean {
    return seesEveryCallReview(input.role) || input.ownsLead === true;
}

/** Is `userId` one of these owner ids (dealer lead owner / ASM, or customer lead owners)? */
export function isOwnerAmong(userId: string | null | undefined, owners: readonly (string | null | undefined)[]): boolean {
    const me = (userId ?? "").trim();
    if (!me) return false;
    return owners.some((o) => !!o && o === me);
}

type LatestCall = {
    transcript?: unknown;
    summary?: unknown;
    recording_url?: unknown;
    intent_reason?: unknown;
};

/**
 * The latest-call block of the Sales Insight drawer, with the review taken out
 * for a caller who may not read it: no transcript, no summary, no recording
 * link, no intent reasoning. Status, score and timing stay.
 */
export function withoutCallReview<T extends LatestCall>(call: T | null): (T & { review_hidden?: true }) | null {
    if (!call) return null;
    return { ...call, transcript: null, summary: null, recording_url: null, intent_reason: null, review_hidden: true };
}
