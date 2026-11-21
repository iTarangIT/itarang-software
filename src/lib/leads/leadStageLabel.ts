/**
 * 20 Nov (items 5/9) — one plain line for "where is this file now" on the
 * dealer-portal Lead Management list, so a submitted file stays readable when
 * it moves on (dealer check → KYC review → lender → sanction → dispatch).
 * Pure. Wording follows the Pushed files page (pushedFileStage).
 */
import { pushedFileStage } from "./pushedFiles";
import { DEALER_CHECK_PENDING, DEALER_CHECK_REJECTED } from "./dealer-assignment-rules";

export function leadStageLabel(input: {
  kycStatus: string | null | undefined;
  assignmentStatus: string | null | undefined;
  /** Latest lead_dealer_reviews.status for the file, if any. */
  dealerCheckStatus?: string | null;
  hasProductSelection?: boolean;
}): string {
  if (input.assignmentStatus === DEALER_CHECK_PENDING || input.dealerCheckStatus === "pending") {
    return "Dealer check — iTarang House";
  }
  if (input.assignmentStatus === DEALER_CHECK_REJECTED) return "Dealer rejected — re-pick";

  const k = (input.kycStatus ?? "").toLowerCase();
  if (!k || k === "pending" || k === "draft" || k === "in_progress") return "KYC in progress";
  if (k === "kyc_approved" || k === "step_3_cleared") {
    return input.hasProductSelection ? "Lender step (NBFC)" : "KYC approved — choose lender";
  }
  if (k === "kyc_rejected") return "KYC rejected";
  if (k === "awaiting_additional_docs") return "More documents asked";
  return pushedFileStage(k, null);
}
