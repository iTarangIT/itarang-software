// What admin "Correct status" must carry (tracker ID 57 / 80). A lead it closes
// has to be as complete as one closed through Mark Lost: a Lost with no reason
// drops out of Lost-by-reason.
//
// ID 133 (3 Oct): it can no longer set Won or Converted. Converted comes only
// from approval of the dealer's onboarding, Won only from Mark Won — a
// correction to either skipped the onboarding path. Pure — POST
// /api/admin/leads/[id]/correct-status does the writes.

import type { LeadStatus, LostReason } from "@/lib/lifecycle/transitions";

/** The statuses Correct status may not set (ID 133). */
export const CORRECTION_REFUSED_TARGETS: readonly LeadStatus[] = ["Won", "Converted"];

export function correctionAllowedTo(to: LeadStatus): boolean {
    return !CORRECTION_REFUSED_TARGETS.includes(to);
}

/** Refused before anything is written; withErrorHandler answers 400 with the sentence. */
export class CorrectionInputError extends Error {
    readonly status = 400;
    constructor(message: string) {
        super(message);
        this.name = "CorrectionInputError";
    }
}

export type CorrectionPlan = {
    /** Lost only — stored in dealer_leads.lost_reason and the status history. */
    toLostReason?: LostReason;
    /** lost_to_competition only (ID 76). */
    competitorName?: string;
};

export function planCorrection(input: {
    to: LeadStatus;
    lostReason?: LostReason | null;
    competitorName?: string | null;
}): CorrectionPlan {
    if (input.to === "Converted") {
        throw new CorrectionInputError(
            "A lead becomes Converted only when the dealer's onboarding is approved. Send it through onboarding.",
        );
    }
    if (input.to === "Won") {
        throw new CorrectionInputError("Use Mark Won — Correct status cannot set Won.");
    }
    if (input.to === "Lost") {
        if (!input.lostReason) {
            throw new CorrectionInputError("Pick a Lost reason to correct a lead to Lost.");
        }
        const competitor = input.competitorName?.trim() ?? "";
        if (input.lostReason === "lost_to_competition" && !competitor) {
            throw new CorrectionInputError("Name the competitor when the reason is 'Lost to competition'.");
        }
        return {
            toLostReason: input.lostReason,
            ...(input.lostReason === "lost_to_competition" ? { competitorName: competitor } : {}),
        };
    }

    return {};
}
