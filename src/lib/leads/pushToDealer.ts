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
// ID 33: narrowed to the decision of 8 Oct — Admin and Sales Head only. (Was
// admin/ceo/business_head/sales_head/sales_manager/partner.)
export const PUSH_TO_DEALER_INTERNAL_ROLES = ["admin", "sales_head"] as const;

/** ID 33: only an admin may move a file a second time (still before consent). */
export const PUSH_AGAIN_ROLES = ["admin"] as const;

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
  return isHouseLogin(input);
}

export const NO_ACTIVE_DEALER_MESSAGE = "No active dealer with this number";

// ── ID 33: consent gate ─────────────────────────────────────────────────────
//
// Decided 10 Oct: a file may move to another dealer only until the customer
// signs consent — the consent PDF prints the dealer's name, so a signed consent
// pins the file to that dealer. Every push path (Step 1, bulk, the CRM action,
// WhatsApp) refuses once any consent on the file is signed.

/**
 * consent_records / leads consent statuses that mean "the customer has signed".
 * esign_completed + admin_review_pending = signed, awaiting admin; verified =
 * OTP consent or admin-approved; digitally_signed / manual_uploaded / signed =
 * the older names the same states go by. Pending, link-sent, failed, expired
 * and admin-rejected consents do not count: a fresh consent would be needed
 * anyway and it would carry the new dealer's name.
 */
export const SIGNED_CONSENT_STATUSES = [
  "signed",
  "esign_completed",
  "admin_review_pending",
  "digitally_signed",
  "manual_uploaded",
  "verified",
] as const;

export function isConsentSigned(status: string | null | undefined): boolean {
  return (SIGNED_CONSENT_STATUSES as readonly string[]).includes(
    String(status ?? "").trim().toLowerCase(),
  );
}

/** True when any of the given consent statuses (customer or co-borrower) is signed. */
export function anyConsentSigned(statuses: ReadonlyArray<string | null | undefined>): boolean {
  return statuses.some(isConsentSigned);
}

/** The exact refusal text agreed with business (10 Oct). */
export function consentSignedMessage(dealerName: string | null | undefined): string {
  const name = (dealerName ?? "").trim() || "the current dealer";
  return `Consent is already signed under ${name}; this file can't be moved.`;
}

/** leads.payment_method values that mean the customer needs a loan. */
export const FINANCE_PAYMENT_METHODS = ["finance", "other_finance", "dealer_finance"] as const;

export function needsLoan(paymentMethod: string | null | undefined): boolean {
  return (FINANCE_PAYMENT_METHODS as readonly string[]).includes(paymentMethod ?? "");
}

/**
 * ID 182: the four ways a file moves to a dealer. Only the CRM single-file
 * push ("crm_push") may move a file a second time, and only for an admin.
 */
export type PushVia = "crm_push" | "bulk_dealer_mobile" | "step1_dealer_mobile" | "whatsapp_operator";

/** ID 182: the reason Step 1 and WhatsApp record on their own (decided 14 Oct). */
export const ITARANG_TEAM_PUSH_REASON = "Entered by iTarang team";

/**
 * ID 182: is this login an iTarang house login? Any dealer login whose dealer
 * code IS the house code — the shared dealer@itarang.com and every per-person
 * team login created under the house (Admin › House team logins).
 */
export function isHouseLogin(input: {
  role: string | null | undefined;
  dealerId: string | null | undefined;
  houseDealerCode: string | null | undefined;
}): boolean {
  return (
    input.role === "dealer" &&
    !!input.houseDealerCode &&
    !!input.dealerId &&
    input.dealerId === input.houseDealerCode
  );
}

export interface PushCheckInput {
  /** Who is pushing (users.role). */
  actorRole: string | null | undefined;
  /** True when the pusher is a house login (isHouseLogin); its role is 'dealer'. */
  actorIsHouseLogin?: boolean;
  /**
   * ID 182: which way the file is being pushed. A second move is allowed only
   * through the CRM push (or a caller that does not say — the CRM GET).
   */
  via?: PushVia;
  /** leads.dealer_id today. */
  currentDealerId: string | null | undefined;
  /** Display name of the current dealer, for the consent message. */
  currentDealerName?: string | null;
  houseDealerCode: string;
  /** Any consent on the file signed (see anyConsentSigned). */
  consentSigned: boolean;
  /** The file was pushed before (a LEAD_PUSHED_TO_DEALER row exists). */
  pushedBefore: boolean;
  paymentMethod: string | null | undefined;
  target: { dealerId: string; name: string; financeEnabled: boolean };
}

export type PushCheck = { ok: true } | { ok: false; status: number; message: string };

export const PUSHED_BEFORE_MESSAGE =
  "This file was already pushed to a dealer. Moving it again needs an admin.";
export const NOT_HOUSE_MESSAGE = "Only files with the iTarang house dealer can be pushed to a dealer.";

/**
 * ID 33 / 182: why this file can't be pushed right now by this actor, whatever
 * the target dealer — or null when it can. Shared by every push path: the CRM
 * button (GET: show or hide it), the CRM push, the house bulk push, Step 1 and
 * the WhatsApp operator.
 *  1. never after consent is signed (exact agreed message);
 *  2. one push per file: once a file carries a push, only an admin moving it
 *     through the CRM push may move it again — never a house login, never
 *     Step 1 / bulk / WhatsApp — even if it is back with the house dealer;
 *  3. a file that is not with the house dealer and was never pushed is a
 *     dealer's own lead and never movable.
 * 16 Oct: the 14 Oct "house login may push a file it pushed out again" rule
 * is gone (decision: the house pushes a file once; a second move needs Admin).
 */
export function pushBlockedReason(
  input: Omit<PushCheckInput, "target" | "paymentMethod">,
): { status: number; message: string } | null {
  if (input.consentSigned) {
    return { status: 409, message: consentSignedMessage(input.currentDealerName) };
  }
  const viaCrm = input.via === undefined || input.via === "crm_push";
  const adminAgain =
    viaCrm &&
    !input.actorIsHouseLogin &&
    (PUSH_AGAIN_ROLES as readonly string[]).includes(input.actorRole ?? "") &&
    input.pushedBefore;
  if (input.pushedBefore && !adminAgain) return { status: 409, message: PUSHED_BEFORE_MESSAGE };
  const withHouse = !!input.houseDealerCode && input.currentDealerId === input.houseDealerCode;
  if (!withHouse && !adminAgain) return { status: 409, message: NOT_HOUSE_MESSAGE };
  return null;
}

/**
 * ID 33: the push rules, in the order business sees them:
 *  1. never after consent is signed (exact agreed message);
 *  2. not to the dealer it is already with;
 *  3. one push per file (see pushBlockedReason);
 *  4. a customer who needs a loan only to a finance-enabled dealer.
 */
export function checkPush(input: PushCheckInput): PushCheck {
  if (input.consentSigned) {
    return { ok: false, status: 409, message: consentSignedMessage(input.currentDealerName) };
  }
  if (input.currentDealerId === input.target.dealerId) {
    return { ok: false, status: 409, message: `This file is already with ${input.target.name}.` };
  }
  const blocked = pushBlockedReason(input);
  if (blocked) return { ok: false, ...blocked };
  if (needsLoan(input.paymentMethod) && !input.target.financeEnabled) {
    return { ok: false, status: 422, message: `${input.target.name} is not enabled for finance leads.` };
  }
  return { ok: true };
}

/**
 * ID 33: the dealer picker — when the customer needs a loan only
 * finance-enabled dealers are offered (the push would be refused anyway).
 */
export function pickerDealers<T extends { financeEnabled: boolean }>(
  dealers: T[],
  opts: { financeOnly?: boolean } = {},
): T[] {
  return opts.financeOnly ? dealers.filter((d) => d.financeEnabled) : dealers;
}

// ── ID 33: reason ───────────────────────────────────────────────────────────

export const PUSH_REASON_MIN = 3;
export const PUSH_REASON_MAX = 500;
export const PUSH_REASON_REQUIRED_MESSAGE = "Give a reason for the push";

/** Trimmed reason when it is long enough, else null. Over-long text is cut. */
export function normalizePushReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const r = reason.trim();
  return r.length >= PUSH_REASON_MIN ? r.slice(0, PUSH_REASON_MAX) : null;
}

// ── ID 33: what leaves with the old dealer ──────────────────────────────────
//
// A coupon is the dealer's own stock (coupon_codes.dealer_id): a coupon the old
// dealer reserved on this file goes back to that dealer's pool and the new
// dealer applies their own. A coupon already USED (fee paid at KYC submission)
// is spent — it stays on the file as a record; there is nothing to give back.
// The old dealer's salesperson (leads.salesperson_id, E-277) is cleared too —
// the new dealer assigns their own.

export type CouponOnPush = "none" | "release" | "keep_used";

export function couponOnPush(
  couponCode: string | null | undefined,
  couponStatus: string | null | undefined,
): CouponOnPush {
  if (!couponCode || !couponCode.trim()) return "none";
  return String(couponStatus ?? "").trim().toLowerCase() === "used" ? "keep_used" : "release";
}

// ── ID 33: WhatsApp operator "Which dealer is this for?" answer ─────────────

export const OPERATOR_DEALER_SKIP_ID = "op_cust_skip";

export type OperatorDealerAnswer =
  | { kind: "skip" }
  | { kind: "mobile"; mobile: string }
  | { kind: "invalid" };

/** Parse the operator's reply: the Skip button / word, a mobile, or neither. */
export function parseOperatorDealerAnswer(text: string | null | undefined): OperatorDealerAnswer {
  const t = (text ?? "").trim();
  if (t.toLowerCase() === OPERATOR_DEALER_SKIP_ID || /^(skip|no|none|house|itarang)$/i.test(t)) {
    return { kind: "skip" };
  }
  const mobile = tenDigitMobile(t);
  return mobile ? { kind: "mobile", mobile } : { kind: "invalid" };
}
