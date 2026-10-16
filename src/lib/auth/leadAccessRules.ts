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
 * ID 119 (decided 16 Oct): the back-office roles that reach EVERY customer
 * file's KYC. Same three as the full-PAN rule. Every other back-office role
 * (sales manager, sales executive, business head, finance controller) reaches
 * only the files it owns — see backOfficeOwnsLead.
 */
export const ALL_LEADS_KYC_ROLES = FULL_ID_ROLES;

/** Back-office roles that reach a lead's KYC only when they own the lead. */
export const OWN_LEADS_KYC_ROLES = ["business_head", "sales_manager", "sales_executive", "finance_controller"] as const;

/**
 * ID 119: does this back-office user own the lead? They uploaded it, it is
 * assigned to them (leads.assigned_to), they are its sales manager
 * (leads.sm_assigned_to), or they own the account of the lead's dealer
 * (account_ownership.owner_user_id). A missing fact is a refusal.
 */
export function backOfficeOwnsLead(input: {
  userId: string | null | undefined;
  uploaderId?: string | null;
  assignedTo?: string | null;
  smAssignedTo?: string | null;
  accountOwnerId?: string | null;
}): boolean {
  const me = (input.userId ?? "").trim();
  if (!me) return false;
  return [input.uploaderId, input.assignedTo, input.smAssignedTo, input.accountOwnerId].some((v) => !!v && v === me);
}

/**
 * ID 119: which customer files a back-office role's KYC LISTS may show —
 * "all" (Admin, CEO, Sales Head), "own" (Business Head, Sales Manager, Sales
 * Executive, Finance Controller: backOfficeOwnsLead) or "none" (anyone else).
 * ownedLeadsWhere() turns this into SQL for the list endpoints.
 */
export function kycLeadScope(role: string | null | undefined): "all" | "own" | "none" {
  const r = (role ?? "").toLowerCase();
  if ((ALL_LEADS_KYC_ROLES as readonly string[]).includes(r)) return "all";
  if ((OWN_LEADS_KYC_ROLES as readonly string[]).includes(r)) return "own";
  return "none";
}

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
