// Automatic lead status + temperature from what a rep just did — ONE rule for
// the CRM's Log Touchpoint / Log Visit modals (which pre-fill it; the rep can
// change it) and the WhatsApp Assistant (which proposes it on the preview;
// the rep can Edit it). A value the rep stated always wins; this only fills
// what they left unsaid. Decided with the product owner 2026-09-26.
//
//   status       moves FORWARD only (see RANK), never touches Converted/Lost,
//                and never runs for transfer / claim / convert / lost, which
//                set status themselves.
//   temperature  follows the latest outcome, down as well as up: the call's
//                bucket (Cold/Warm/Hot → cold/warm/hot), or the visit outcome.
//
// CLIENT-SAFE: no db import — the modals import it.

import { CONNECTED_DISPOSITIONS, type DispositionBucket } from "@/lib/leads/dispositions";
import type { LeadStatus, LostReason } from "@/lib/lifecycle/transitions";
import type { VisitOutcome } from "@/lib/asm/types";

export type Interest = "hot" | "warm" | "cold";

export type AutoProgress = {
    /** Proposed status, or null for "leave it". */
    statusTo: LeadStatus | null;
    /** Proposed temperature, or null for "leave it". */
    interestTo: Interest | null;
};

const NONE: AutoProgress = { statusTo: null, interestTo: null };

/**
 * How far along the funnel a status is. Transferred_to_ASM sits just below
 * Under_Discussion so an ASM's first real conversation still moves it forward.
 * A quote awaiting the dealer's decision comes before commercials finalised.
 * Terminal statuses are absent: nothing moves a closed lead.
 */
const RANK: Partial<Record<LeadStatus, number>> = {
    New_Unassigned: 0,
    Assigned_Not_Contacted: 1,
    Transferred_to_ASM: 1.5,
    Under_Discussion: 2,
    Commercials_Explained: 3,
    Awaiting_Customer_Decision: 4,
    Commercials_Finalised: 5,
};

/** `to` if it is further along than `from`, else null. */
function forward(from: string | null, to: LeadStatus): LeadStatus | null {
    const a = from == null ? 0 : RANK[from as LeadStatus];
    const b = RANK[to];
    if (a === undefined || b === undefined) return null; // terminal or unknown
    return b > a ? to : null;
}

const BUCKET_INTEREST: Partial<Record<DispositionBucket, Interest>> = { Cold: "cold", Warm: "warm", Hot: "hot" };

/**
 * The call outcomes that NAME a commercials stage. Since 29 Sep 2026 (ID 75)
 * they move nothing beyond first contact: commercials stages come only from
 * quote events (src/lib/leads/quoteStatus.ts). The forms show "No quote in
 * the system" next to them when the lead has no quote.
 */
export const COMMERCIALS_CALL_LABELS: readonly string[] = [
    "Commercials Explained",
    "Quotation Sent",
    "Under Negotiation",
    "Commercials Finalised",
];

/**
 * ID 76: the ONE map from a call outcome label to its Lost reason. The forms
 * pre-fill Mark Lost from it, and the WhatsApp Assistant's vocabulary
 * (assistant/vocab.ts lostReasonByLabel) is built from it — so the two can
 * never disagree. A label absent here = the rep picks (the form still opens).
 *
 *   REJECTED BY US  defaults to the credit reason (ID 76.2); Mark Lost keeps
 *                   the credit / geography choice editable.
 *   Price High      is a Warm label, Lost only when the rep says so.
 */
export const LOST_REASON_BY_LABEL: Readonly<Record<string, LostReason>> = Object.freeze({
    "Not Interested": "not_interested",
    "Lost to Competition": "lost_to_competition",
    "Some other Business": "moved_to_other_business",
    "Business Closed": "business_closed",
    "REJECTED BY US": "rejected_by_us_credit",
    "Price High": "price_high",
});

export function lostReasonForLabel(label: string): LostReason | null {
    return LOST_REASON_BY_LABEL[label] ?? null;
}

/** The one bucket a connected label belongs to; null when it is in several (or none). */
export function bucketForLabel(label: string): DispositionBucket | null {
    const hits = (Object.keys(CONNECTED_DISPOSITIONS) as DispositionBucket[]).filter((b) =>
        CONNECTED_DISPOSITIONS[b].includes(label),
    );
    return hits.length === 1 ? hits[0]! : null;
}

function interestChange(to: Interest | null, current: string | null): Interest | null {
    return to && to !== current ? to : null;
}

export function autoProgressForCall(input: {
    connected: boolean;
    label: string;
    /** The bucket the rep picked, if any — needed for labels in two buckets. */
    bucket: DispositionBucket | null;
    currentStatus: string | null;
    currentInterest: string | null;
}): AutoProgress {
    if (!input.connected) return NONE;
    const bucket = input.bucket ?? bucketForLabel(input.label);
    // ID 77: a call never ends Awaiting field visit — only a visit does.
    const statusFrozen = input.currentStatus === "Transferred_to_ASM";
    if (bucket === "Lost" || bucket === "Converted") return NONE;
    if (!bucket && !COMMERCIALS_CALL_LABELS.includes(input.label)) return NONE;
    // A connected call is first contact — never a commercials stage (ID 75).
    return {
        statusTo: statusFrozen ? null : forward(input.currentStatus, "Under_Discussion"),
        interestTo: interestChange(bucket ? (BUCKET_INTEREST[bucket] ?? null) : null, input.currentInterest),
    };
}

export function autoProgressForVisit(input: {
    /** False for a postponed / cancelled / no-show visit. */
    visited: boolean;
    outcome: VisitOutcome | null;
    currentStatus: string | null;
    currentInterest: string | null;
}): AutoProgress {
    if (!input.visited) return NONE;
    switch (input.outcome) {
        case "productive":
            return { statusTo: forward(input.currentStatus, "Under_Discussion"), interestTo: null };
        case "commercials_progressed":
            // Commercials stages come only from quote events (ID 75); the visit
            // is still first contact.
            return {
                statusTo: forward(input.currentStatus, "Under_Discussion"),
                interestTo: interestChange("hot", input.currentInterest),
            };
        case "dealer_uninterested":
            // Keep open vs Lost is asked, not guessed.
            return { statusTo: null, interestTo: interestChange("cold", input.currentInterest) };
        default:
            return NONE;
    }
}

export function autoProgressForFollowUp(input: {
    /** Did the rep actually speak to the dealer? A reminder alone moves nothing. */
    spokeWithDealer: boolean;
    currentStatus: string | null;
}): AutoProgress {
    if (!input.spokeWithDealer) return NONE;
    return { statusTo: forward(input.currentStatus, "Under_Discussion"), interestTo: null };
}
