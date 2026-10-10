// ID 33 — pure rules for web leads the iTarang team pushes to a dealer by the
// dealer's mobile number (leads.dealer_assigned_at is set only by that push).
// No DB imports: used by ./customer-lead and ./pushedLeadNotice, tested alone.

/**
 * Lead states that still count as "a draft the dealer can pick up in chat".
 * Anything past these has left the dealer's hands (submitted, sanctioned,
 * dispatched, sold) and belongs to the portal — the old filter keyed only on
 * the admin KYC queue, which let a SOLD cash lead sit in Save Drafts forever.
 */
export const DRAFT_KYC_STATUSES = ["pending", "draft"];

/**
 * The web Step-1 commit leaves a pushed lead at 'not_started' (finance) or
 * 'not_required' (cash), which is still "nothing captured yet" — so for a
 * PUSHED lead those count as a draft too. WhatsApp-created leads keep the
 * narrower DRAFT_KYC_STATUSES.
 */
export const PUSHED_DRAFT_KYC_STATUSES = ["not_started", "not_required"];

/** Still a draft the dealer can pick up in chat. */
export function isOpenDraftStatus(kycStatus: string | null, pushed: boolean): boolean {
  if (!kycStatus) return true;
  if (DRAFT_KYC_STATUSES.includes(kycStatus)) return true;
  return pushed && PUSHED_DRAFT_KYC_STATUSES.includes(kycStatus);
}

/** The dealer-facing WhatsApp notice that a lead was added for them. */
export function pushedLeadNoticeBody(input: {
  greetName: string;
  customerName: string;
  referenceId: string;
}): string {
  return (
    `Hi ${input.greetName}, the iTarang team has added a new lead for you.\n\n` +
    `👤 *${input.customerName}*\n🔖 Ref: ${input.referenceId}\n\n` +
    "Send *menu* and tap *Save Drafts* to continue it here, or open it on the dealer portal."
  );
}
