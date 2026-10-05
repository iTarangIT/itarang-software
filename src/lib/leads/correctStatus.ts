// What admin "Correct status" must carry (tracker ID 57 / 80). The override may
// set any status, but a lead it closes has to be as complete as one closed
// through Mark Lost / Mark Won: a Lost with no reason drops out of
// Lost-by-reason, and a Won / Converted with no GSTIN never matches its
// invoices. Pure — POST /api/admin/leads/[id]/correct-status does the writes.

import { isOwnGstin, isValidGstin, normalizeGstin } from "@/lib/leads/gstin";
import type { LeadStatus, LostReason } from "@/lib/lifecycle/transitions";

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
    /** Won / Converted, when the admin typed one: normalised, to write on the lead. */
    gstin?: string;
    /** Won / Converted: the lead must have its onboarding application. */
    needsOnboarding: boolean;
};

export function planCorrection(input: {
    to: LeadStatus;
    lostReason?: LostReason | null;
    competitorName?: string | null;
    gstin?: string | null;
    /** The GSTIN already on the lead, if any. */
    existingGstin?: string | null;
}): CorrectionPlan {
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
            needsOnboarding: false,
        };
    }

    if (input.to === "Won" || input.to === "Converted") {
        const typed = normalizeGstin(input.gstin);
        if (typed && !isValidGstin(typed)) {
            throw new CorrectionInputError("Enter the dealer's 15-character GSTIN (e.g. 07AAACB1234C1ZH) — check the last character.");
        }
        if (typed && isOwnGstin(typed)) {
            throw new CorrectionInputError("This is iTarang's own GSTIN, not the dealer's.");
        }
        if (!typed && !isValidGstin(input.existingGstin)) {
            throw new CorrectionInputError(
                `This lead has no GSTIN. Enter the dealer's 15-character GSTIN to correct it to ${input.to}.`,
            );
        }
        return { ...(typed ? { gstin: typed } : {}), needsOnboarding: true };
    }

    return { needsOnboarding: false };
}
