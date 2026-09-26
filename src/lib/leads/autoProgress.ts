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
import type { LeadStatus } from "@/lib/lifecycle/transitions";
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

/** Status a connected call's label moves to; every other open-bucket label → Under_Discussion. */
const CALL_STATUS_BY_LABEL: Readonly<Record<string, LeadStatus>> = {
    "Commercials Explained": "Commercials_Explained",
    "Quotation Sent": "Awaiting_Customer_Decision",
    "Under Negotiation": "Awaiting_Customer_Decision",
    "Commercials Finalised": "Commercials_Finalised",
};

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
    if (bucket === "Lost" || bucket === "Converted") return NONE;
    if (!bucket && !CALL_STATUS_BY_LABEL[input.label]) return NONE;
    const target = CALL_STATUS_BY_LABEL[input.label] ?? "Under_Discussion";
    return {
        statusTo: forward(input.currentStatus, target),
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
            // Explained vs finalised is asked, not guessed.
            return { statusTo: null, interestTo: interestChange("hot", input.currentInterest) };
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
