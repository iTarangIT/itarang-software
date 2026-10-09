// Change Lost reason (tracker ID 136) — the pure, client-safe rules. The write
// is changeLostReason.ts; the header there has the full decision.

import { LOST_REASON, type LostReason } from "@/lib/lifecycle/transitions";

/** Who may change a Lost reason (ID 136). */
export const LOST_REASON_CHANGE_ROLES = ["admin", "sales_head"] as const;

/** Mark Lost's own list: onboarding_dropout is set only by the drop-out review. */
export const CHANGEABLE_LOST_REASONS: readonly LostReason[] = LOST_REASON.filter((r) => r !== "onboarding_dropout");

/** Refused before anything is written; withErrorHandler answers with `status`. */
export class LostReasonChangeError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "LostReasonChangeError";
    }
}

export type LostReasonChangePlan = {
    from: LostReason | null;
    to: LostReason;
    /** Set when the new reason is lost_to_competition; cleared (null) when it is not. */
    competitorName: string | null;
    note: string;
};

/** Pure — every refusal the route makes, against the lead as it is now. */
export function planLostReasonChange(input: {
    leadStatus: string | null;
    currentReason: string | null;
    currentCompetitor: string | null;
    to: LostReason;
    competitorName?: string | null;
    note?: string | null;
}): LostReasonChangePlan {
    if (input.leadStatus !== "Lost") {
        throw new LostReasonChangeError("Only a Lost lead has a Lost reason to change.", 409);
    }
    if (!CHANGEABLE_LOST_REASONS.includes(input.to)) {
        throw new LostReasonChangeError("Onboarding drop-out is set only by the drop-out review.");
    }
    const note = input.note?.trim() ?? "";
    if (note.length < 5) {
        throw new LostReasonChangeError("Write a note of at least 5 characters on why the reason is changing.");
    }
    const competitor = input.competitorName?.trim() ?? "";
    if (input.to === "lost_to_competition" && !competitor) {
        throw new LostReasonChangeError("Name the competitor when the reason is 'Lost to competition'.");
    }
    const sameReason = input.currentReason === input.to;
    const sameCompetitor =
        input.to !== "lost_to_competition" || competitor === (input.currentCompetitor?.trim() ?? "");
    if (sameReason && sameCompetitor) {
        throw new LostReasonChangeError("That is already the lead's Lost reason.");
    }
    return {
        from: (input.currentReason as LostReason | null) ?? null,
        to: input.to,
        competitorName: input.to === "lost_to_competition" ? competitor : null,
        note,
    };
}
