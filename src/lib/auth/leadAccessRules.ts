// Pure lead-ownership rules used by requireLeadAccess (tracker ID 119).
// No db import, so the rule can be unit-tested on its own.

/**
 * May a caller whose dealership is `callerDealerCode` act on a lead whose
 * leads.dealer_id is `leadDealerId`? Both are dealer CODES. A missing value on
 * either side is a refusal, never a match: two nulls must not count as "same
 * dealer".
 */
export function dealerOwnsLead(
  leadDealerId: string | null | undefined,
  callerDealerCode: string | null | undefined,
): boolean {
  const lead = (leadDealerId ?? "").trim();
  const caller = (callerDealerCode ?? "").trim();
  if (!lead || !caller) return false;
  return lead === caller;
}

/**
 * Who sees a customer's FULL PAN (tracker ID 119, with the ID 166 rule decided
 * 10 Oct: files open only for Admin, the owner, the Sales Head and the CEO).
 * Full Aadhaar is never sent to the browser at all; this is the PAN rule.
 */
export const FULL_ID_ROLES = ["admin", "ceo", "sales_head"] as const;

/**
 * May this caller read the lead's full PAN? Admin, Sales Head, CEO; the dealer
 * whose lead it is; the person who uploaded the lead; the iTarang owner of the
 * dealer's account. Every other back-office role (sales manager, sales
 * executive, business head, finance controller, …) gets it masked. A missing
 * fact is a refusal.
 */
export function mayReadFullIds(input: {
  role: string | null | undefined;
  userId: string | null | undefined;
  leadUploaderId?: string | null;
  accountOwnerId?: string | null;
  /** The caller is the dealer whose lead this is (dealerOwnsLead). */
  dealerOwnsLead?: boolean;
}): boolean {
  const role = (input.role ?? "").toLowerCase();
  if ((FULL_ID_ROLES as readonly string[]).includes(role)) return true;
  if (role === "dealer") return input.dealerOwnsLead === true;
  const me = (input.userId ?? "").trim();
  if (!me) return false;
  return input.leadUploaderId === me || input.accountOwnerId === me;
}
