// The outcome rule, as the SERVER applies it (tracker ID 114, 01 Oct 2026).
//
// autoProgress.ts says what a call or visit outcome proposes. This module turns
// that into the move the status writer makes — so the touchpoints API, the
// forms, the WhatsApp Assistant, the visit route and the NeoDove webhook all
// derive status and temperature from the outcome through ONE function, against
// the lead's row as locked inside writeTouchpoint's transaction, instead of
// each caller (or the browser) working it out for itself.
//
//   status       forward only, first contact at most (Under_Discussion);
//                commercials stages come from quote events, Won / Lost /
//                transfer from their own actions. A derived move therefore
//                always passes the S3 guard (statusRules.ts) — unit-tested.
//   temperature  follows the latest outcome — but a DERIVED value is written
//                only where the owner's own work produced it (P0-10): see
//                autoInterestAllowed. A value the rep STATED is theirs to set.
//
// CLIENT-SAFE: no db import.

import { autoProgressForCall, autoProgressForVisit, type Interest } from "@/lib/leads/autoProgress";
import type { DispositionBucket } from "@/lib/leads/dispositions";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { isForward, STATUS_RANK, type StatusEvent } from "@/lib/lifecycle/statusRules";
import type { VisitOutcome } from "@/lib/asm/types";

export type TouchpointOutcome =
    | {
          kind: "call";
          connected: boolean;
          /** The CC sheet's L3 label, when one was picked or sent. */
          label: string | null;
          /** The bucket picked, if any — needed for labels that sit in two. */
          bucket: DispositionBucket | null;
          /**
           * Inbound systems only (NeoDove, ID 116). Nobody is at the CRM to be
           * asked Mark Lost / Mark Won, and live payloads often carry no label
           * at all — so ANY connected call is first contact, whatever its
           * outcome says. Temperature still comes from the bucket alone.
           */
          firstContactOnConnect?: boolean;
      }
    | {
          kind: "visit";
          /** False for a postponed / cancelled / no-show visit. */
          visited: boolean;
          outcome: VisitOutcome | null;
          // No "requested" status (ID 80): the visit's outcome decides, nothing
          // the caller asks for.
      };

/** The lead as read under the writer's row lock. */
export type OutcomeLead = {
    status: string | null;
    interest: string | null;
    preTransferStatus: string | null;
    ownerId: string | null;
    /** dealer_leads.interest_changed_at (E-301); null when never changed or absent. */
    interestChangedAt?: Date | null;
};

export type ResolvedOutcome = {
    statusTo: LeadStatus | null;
    event: StatusEvent;
    interestTo: Interest | null;
};

const RESTORABLE = new Set<string>([
    "Under_Discussion",
    "Commercials_Explained",
    "Awaiting_Customer_Decision",
    "Commercials_Finalised",
]);

/**
 * The status a DONE visit moves the lead to, or null for "leave it" (ID 77).
 * Awaiting field visit ends only here: the lead goes to the further of first
 * contact and where it was before the transfer.
 */
export function statusAfterVisit(input: {
    current: string | null;
    preTransfer: string | null;
    requested: LeadStatus | null;
}): LeadStatus | null {
    const { current, preTransfer, requested } = input;
    if (current === "Transferred_to_ASM") {
        const candidates: LeadStatus[] = ["Under_Discussion"];
        if (preTransfer && RESTORABLE.has(preTransfer)) candidates.push(preTransfer as LeadStatus);
        // ID 75 / 80: `requested` is what the visit outcome earned (first
        // contact), never a status someone asked for; commercials stages come
        // from quote events (the pre-transfer stage is restored).
        if (requested === "Under_Discussion") candidates.push(requested);
        return candidates.reduce((a, b) => ((STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a));
    }
    if (requested === "Under_Discussion" && isForward(current, requested)) return requested;
    return null;
}

/** What the outcome proposes for this lead: a status move (with its event) and a temperature. */
export function resolveOutcome(outcome: TouchpointOutcome, lead: OutcomeLead): ResolvedOutcome {
    if (outcome.kind === "call") {
        const auto = autoProgressForCall({
            connected: outcome.connected,
            label: outcome.label ?? "",
            bucket: outcome.bucket,
            currentStatus: lead.status,
            currentInterest: lead.interest,
        });
        let statusTo = auto.statusTo;
        if (
            !statusTo &&
            outcome.firstContactOnConnect &&
            outcome.connected &&
            // ID 77: a call never ends Awaiting field visit — only a visit does.
            lead.status !== "Transferred_to_ASM" &&
            isForward(lead.status, "Under_Discussion")
        ) {
            statusTo = "Under_Discussion";
        }
        return { statusTo, event: "progress", interestTo: auto.interestTo };
    }

    if (!outcome.visited) return { statusTo: null, event: "visit", interestTo: null };
    const auto = autoProgressForVisit({
        visited: true,
        outcome: outcome.outcome,
        currentStatus: lead.status,
        currentInterest: lead.interest,
    });
    const statusTo = statusAfterVisit({
        current: lead.status,
        preTransfer: lead.preTransferStatus,
        requested: auto.statusTo,
    });
    return { statusTo, event: "visit", interestTo: auto.interestTo };
}

/**
 * May a DERIVED temperature be written? (P0-10, for every entry point.)
 *   - someone did the work (an unmapped NeoDove agent or the AI has no actor);
 *   - the lead is not closed;
 *   - the lead is unowned, or the actor is its owner — a colleague's call on
 *     the owner's behalf does not re-rate the owner's lead;
 *   - the outcome is not older than the lead's last temperature change (an
 *     inbound event delivered late must not undo a newer rating).
 */
export function autoInterestAllowed(input: {
    actorId: string | null;
    performedAt: Date;
    lead: Pick<OutcomeLead, "status" | "ownerId" | "interestChangedAt">;
}): boolean {
    const { actorId, performedAt, lead } = input;
    if (!actorId) return false;
    if (lead.status === "Converted" || lead.status === "Lost") return false;
    if (lead.ownerId && lead.ownerId !== actorId) return false;
    if (lead.interestChangedAt && lead.interestChangedAt.getTime() > performedAt.getTime()) return false;
    return true;
}

/**
 * The writer's decision for one touchpoint.
 *
 *   status       an explicit statusChange from the caller wins (nothing is
 *                applied twice); else the outcome's move.
 *   temperature  `interest` is tri-state: a level = the rep stated it;
 *                null = "leave it"; undefined = derive from the outcome.
 */
export function planOutcome(input: {
    outcome?: TouchpointOutcome;
    hasExplicitStatus: boolean;
    interest?: Interest | null;
    actorId: string | null;
    performedAt: Date;
    lead: OutcomeLead;
}): ResolvedOutcome {
    const { outcome, lead } = input;
    const derived = outcome ? resolveOutcome(outcome, lead) : null;

    let interestTo: Interest | null = null;
    if (input.interest === undefined) {
        if (
            derived?.interestTo &&
            autoInterestAllowed({ actorId: input.actorId, performedAt: input.performedAt, lead })
        ) {
            interestTo = derived.interestTo;
        }
    } else if (input.interest !== null && input.interest !== lead.interest && input.actorId) {
        interestTo = input.interest;
    }

    return {
        statusTo: input.hasExplicitStatus ? null : (derived?.statusTo ?? null),
        event: derived?.event ?? "progress",
        interestTo,
    };
}
