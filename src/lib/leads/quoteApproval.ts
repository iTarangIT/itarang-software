/**
 * E-221 — the CEO approval gate on lead quotations.
 *
 * Pure rules, no database. Kept out of the routes so both the write path and
 * the CEO queue agree on what is gated and what a rejection rolls back to,
 * and so those rules can be tested without a connection.
 */

export const QUOTE_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type QuoteApprovalStatus = (typeof QUOTE_APPROVAL_STATUSES)[number];

/**
 * The commercials events that put a price in front of a dealer, and so are the
 * ones the CEO gates.
 *
 * `terms_update` and `final_terms` are deliberately NOT here. The agreed scope
 * was "every quote", meaning the two quote events; gating a terms edit would
 * stall routine follow-up work behind the same queue for no commercial gain.
 * `brochure_share` carries no price at all.
 */
export const GATED_QUOTE_EVENTS = ["quote_issue", "quote_revision"] as const;

export function isGatedQuoteEvent(eventType: string): boolean {
    return (GATED_QUOTE_EVENTS as readonly string[]).includes(eventType);
}

/**
 * The approval status a newly-written commercials row starts in.
 *
 * Ungated events are born approved rather than being left NULL, so that
 * "approved" always means a positive statement about the row and the CEO queue
 * never has to reason about absence.
 */
export function initialApprovalStatus(eventType: string): QuoteApprovalStatus {
    return isGatedQuoteEvent(eventType) ? "pending" : "approved";
}

export interface CommercialVersion {
    commercial_id: string;
    version_no: number;
    approval_status: string | null;
}

/**
 * Which version becomes `is_current` when `rejectedVersionNo` is rejected.
 *
 * The highest version below the rejected one that is not itself rejected. A
 * rejected row must never become current again — it was refused — and a still
 * pending row must not either, or rejecting v3 would silently promote an
 * unapproved v2 to live.
 *
 * Returns null when nothing qualifies, which is the real case of a lead whose
 * very first quote is rejected: it goes back to having no current commercials
 * rather than inventing one.
 */
export function rollbackTarget(
    versions: CommercialVersion[],
    rejectedVersionNo: number,
): CommercialVersion | null {
    const eligible = versions
        .filter((v) => v.version_no < rejectedVersionNo)
        .filter((v) => (v.approval_status ?? "approved") === "approved")
        .sort((a, b) => b.version_no - a.version_no);
    return eligible[0] ?? null;
}
