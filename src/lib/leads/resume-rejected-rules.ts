/**
 * 23 Nov 2026 — pure rules for resuming an NBFC-rejected file (tasks 8 + 9).
 * See ./resume-rejected.ts.
 */

export type ResumeMode = "same_nbfc" | "other_nbfc" | "new_dealer";

/** A lender is still working on the file. */
const LIVE_ASSIGNMENT = new Set(["pending", "in_progress", "offer_submitted", "selected"]);
/** Past the lender decision — nothing left to resume. */
const PAST_SANCTION = new Set(["loan_sanctioned", "dispatched", "sold"]);

export type ResumeVerdict = { ok: true } | { ok: false; reason: string };

export function decideResume(f: {
  paymentMethod: string | null;
  kycStatus: string | null;
  assignmentStatuses: string[];
  movedToNewCase: boolean;
}): ResumeVerdict {
  if (String(f.paymentMethod ?? "").toLowerCase() !== "finance") {
    return { ok: false, reason: "Only a finance file can be resumed after a lender rejection." };
  }
  if (f.movedToNewCase) {
    return { ok: false, reason: "This file was already resumed as a new case for another dealer — continue there." };
  }
  if (PAST_SANCTION.has(String(f.kycStatus ?? ""))) {
    return { ok: false, reason: "The loan is already sanctioned on this file." };
  }
  if (!f.assignmentStatuses.includes("declined")) {
    return { ok: false, reason: "No NBFC has rejected this file." };
  }
  if (f.assignmentStatuses.some((s) => LIVE_ASSIGNMENT.has(s))) {
    return { ok: false, reason: "A lender is already working on this file." };
  }
  return { ok: true };
}
