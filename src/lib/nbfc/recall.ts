/**
 * E-275 — admin recall of a financed file.
 *
 * A lead is "recalled" from the moment an admin recalls it until the admin
 * resubmits it. Both stamps live on `leads` (recalled_at / resubmitted_at), so
 * the predicate is a pure comparison of the two — the same expression the
 * migration's COMMENT documents. There is no SLA on a recall: it is a manual
 * pause, and only the admin's Resubmit ends it.
 */

export type RecallableLead = {
  recalled_at?: Date | string | null;
  resubmitted_at?: Date | string | null;
};

export function isLeadRecalled(lead: RecallableLead | null | undefined): boolean {
  if (!lead?.recalled_at) return false;
  const recalled = new Date(lead.recalled_at).getTime();
  if (!lead.resubmitted_at) return true;
  const resubmitted = new Date(lead.resubmitted_at).getTime();
  return resubmitted < recalled;
}

/** Lead kyc_status values at which an admin may recall the file. */
export const RECALLABLE_KYC_STATUSES = ["pending_final_approval", "awaiting_enach"] as const;

/** The 409 body every NBFC write path returns while a file is recalled. */
export const RECALLED_ERROR = "CONFLICT: File recalled by iTarang — actions are paused until it is resubmitted";
