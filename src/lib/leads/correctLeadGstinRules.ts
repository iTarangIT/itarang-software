// "Correct GSTIN" for a Won lead (tracker ID 124, decided 3 Oct 2026) — the
// rules, pure and client-safe; correctLeadGstin.ts does the writes.
//
// Before this a rep fixed a GSTIN typo by pressing Mark Won again: that changed
// dealer_leads.gstin but never the onboarding application (it is pre-filled
// only when empty), so invoice matching and the agreement used different
// numbers. Now Mark Won is hidden on a Won lead and this one action updates
// the lead AND its onboarding application together, logged with who and why.
//
//   * Won leads only. A Converted dealer has an account: its GSTIN is fixed
//     with the account's own Correct GSTIN (Accounts), which keeps the old
//     number as an alias so past invoices still match.
//   * The lead's owner, the Sales Head or admin.
//   * A valid dealer GSTIN (not iTarang's own), different from the current one.
//   * A reason is required.

import { isOwnGstin, isValidGstin, normalizeGstin } from "@/lib/leads/gstin";

/** Besides the lead's owner. */
export const GSTIN_CORRECTION_MANAGER_ROLES = ["sales_head", "admin"] as const;

export const GSTIN_CORRECTION_REASON_MIN = 5;

/** Refused before anything is written; withErrorHandler answers with `status`. */
export class LeadGstinCorrectionError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409,
    ) {
        super(message);
        this.name = "LeadGstinCorrectionError";
    }
}

export function canCorrectLeadGstin(input: { role: string; userId: string; ownerId: string | null }): boolean {
    return (
        (GSTIN_CORRECTION_MANAGER_ROLES as readonly string[]).includes(input.role) ||
        (!!input.ownerId && input.ownerId === input.userId)
    );
}

export function planGstinCorrection(input: {
    leadStatus: string | null;
    currentGstin: string | null;
    newGstin: string;
    reason: string | null | undefined;
}): { from: string | null; to: string; reason: string } {
    if (input.leadStatus === "Converted") {
        throw new LeadGstinCorrectionError(
            "This dealer is Converted — correct the GSTIN on their account (Accounts → Correct GSTIN).",
            409,
        );
    }
    if (input.leadStatus !== "Won") {
        throw new LeadGstinCorrectionError("Correct GSTIN is for a Won lead. Mark Won records the GSTIN.", 409);
    }
    const to = normalizeGstin(input.newGstin);
    if (!isValidGstin(to)) {
        throw new LeadGstinCorrectionError(
            "Enter the dealer's 15-character GSTIN (e.g. 07AAACB1234C1ZH) — check the last character.",
            400,
        );
    }
    if (isOwnGstin(to)) throw new LeadGstinCorrectionError("This is iTarang's own GSTIN, not the dealer's.", 400);
    const from = input.currentGstin ? normalizeGstin(input.currentGstin) : null;
    if (from === to) throw new LeadGstinCorrectionError("That is already the lead's GSTIN.", 400);
    const reason = input.reason?.trim() ?? "";
    if (reason.length < GSTIN_CORRECTION_REASON_MIN) {
        throw new LeadGstinCorrectionError("Say why the GSTIN is being corrected.", 400);
    }
    return { from: input.currentGstin?.trim() || null, to, reason };
}
