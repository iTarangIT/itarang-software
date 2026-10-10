// Tracker ID 33 — an internal (iTarang-team) lead submission can be pushed to
// an onboarded dealer by typing the dealer's mobile number at Step 1.
//
// Pure helpers only (no db import) so they can be unit-tested and imported
// from anywhere. The db lookup lives in ./dealerByMobile.

/**
 * Internal CRM roles allowed to look a dealer up by mobile. The iTarang team
 * submits customer files through the house-dealer login (role 'dealer',
 * dealer_id = the house dealer's code), so that login is admitted separately
 * by canUsePushToDealer — an ordinary dealer is not.
 */
export const PUSH_TO_DEALER_INTERNAL_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "partner",
] as const;

/** Last 10 digits of an Indian mobile, or null when it isn't one. */
export function tenDigitMobile(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/**
 * May this user push a lead to another dealer? Internal roles, or the house
 * dealer's own login (the iTarang team's web submissions). An ordinary dealer
 * never may — they would be able to dump leads on a competitor.
 */
export function canUsePushToDealer(input: {
  role: string | null | undefined;
  dealerId: string | null | undefined;
  houseDealerCode: string | null | undefined;
}): boolean {
  if ((PUSH_TO_DEALER_INTERNAL_ROLES as readonly string[]).includes(input.role ?? "")) return true;
  return (
    input.role === "dealer" &&
    !!input.houseDealerCode &&
    !!input.dealerId &&
    input.dealerId === input.houseDealerCode
  );
}

export const NO_ACTIVE_DEALER_MESSAGE = "No active dealer with this number";
