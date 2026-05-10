/**
 * E-101 — Canonical payment-mode mapping utility.
 *
 * Sync Audit G-02 / G-07. Three different payment-method representations exist
 * across leads, warranty (deployedAssets) and after_sales_records:
 *
 *   leads.payment_method           : 'Cash' | 'Other finance' | 'Dealer finance'
 *                                    (3-value, mixed-case — source of truth)
 *   warranty / after_sales records : 'cash' | 'finance'
 *                                    (2-value lowercase, collapsed at write time)
 *
 * Per BRD V2 §6 Resolution B.1, the collapsing must happen through a single
 * named function so the mapping cannot drift between warranty creation and
 * after-sales creation. Inline string juggling is forbidden.
 *
 *   'Cash'           → 'cash'
 *   'Other finance'  → 'finance'
 *   'Dealer finance' → 'finance'
 *
 * Unknown inputs throw `PaymentModeMappingError` instead of silently defaulting,
 * so ENUM drift surfaces at the call site in development rather than in the
 * downstream column.
 *
 * The function also tolerates a small set of historical/legacy payment_method
 * values found in this codebase (`'cash'`, `'upfront'`, `'finance'`,
 * `'other_finance'`, `'dealer_finance'`) — these collapse the same way as
 * their canonical counterparts. Anything else is rejected.
 */

export type CanonicalPaymentMethod = "Cash" | "Other finance" | "Dealer finance";
export type CollapsedPaymentMode = "cash" | "finance";

export class PaymentModeMappingError extends Error {
  readonly input: unknown;
  constructor(input: unknown) {
    super(
      `toPaymentMode: unknown payment_method input ${JSON.stringify(input)}. ` +
        `Expected one of 'Cash' | 'Other finance' | 'Dealer finance' ` +
        `(or a known legacy variant: cash, upfront, finance, other_finance, dealer_finance).`,
    );
    this.name = "PaymentModeMappingError";
    this.input = input;
  }
}

/**
 * Canonical inputs from BRD V2 §6 Resolution B.1.
 * These are the only values authored documentation guarantees.
 */
const CANONICAL_MAP: Record<CanonicalPaymentMethod, CollapsedPaymentMode> = {
  Cash: "cash",
  "Other finance": "finance",
  "Dealer finance": "finance",
};

/**
 * Legacy variants discovered in this codebase (e.g. lowercase `'cash'`,
 * underscore `'other_finance'`, the `'upfront'` synonym used in some KYC
 * code paths). Canonicalised so historical data still maps deterministically.
 *
 * Keys are normalised: lowercased, trimmed, spaces → underscores.
 */
const LEGACY_NORMALISED_MAP: Record<string, CollapsedPaymentMode> = {
  cash: "cash",
  upfront: "cash",
  finance: "finance",
  other_finance: "finance",
  dealer_finance: "finance",
};

function normaliseLegacy(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Collapse a 3-value `leads.payment_method` ENUM to the 2-value
 * `'cash' | 'finance'` ENUM written to warranty / after_sales_records.
 *
 * Throws `PaymentModeMappingError` on unknown / null / empty input.
 */
export function toPaymentMode(input: string | null | undefined): CollapsedPaymentMode {
  if (input === null || input === undefined || input === "") {
    throw new PaymentModeMappingError(input);
  }
  if (typeof input !== "string") {
    throw new PaymentModeMappingError(input);
  }
  // Canonical match first (case + spelling sensitive — the BRD-approved values).
  if (Object.prototype.hasOwnProperty.call(CANONICAL_MAP, input)) {
    return CANONICAL_MAP[input as CanonicalPaymentMethod];
  }
  // Legacy fallback — case-insensitive, underscore-tolerant.
  const norm = normaliseLegacy(input);
  if (Object.prototype.hasOwnProperty.call(LEGACY_NORMALISED_MAP, norm)) {
    return LEGACY_NORMALISED_MAP[norm];
  }
  throw new PaymentModeMappingError(input);
}

/**
 * Convenience guard for code that wants to branch without throwing.
 * Returns null if the input is unknown.
 */
export function tryToPaymentMode(input: string | null | undefined): CollapsedPaymentMode | null {
  try {
    return toPaymentMode(input);
  } catch {
    return null;
  }
}
