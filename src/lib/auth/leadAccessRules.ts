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
