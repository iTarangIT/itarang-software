// Dealer address reconstruction helpers shared by the admin dealer-verification
// GET detail route and the agreement initiation route. Both need the same
// "resolve the dealer's office address" logic: prefer the business_address
// column, fall back to the GST Principal Place of Business in the snapshot.

/**
 * Normalise the `business_address` value into a single display line.
 * `business_address` is a TEXT column that may hold a raw address string or a
 * JSON-encoded object like '{"address":"Pune"}'. Parse first so callers never
 * see the wrapper braces/quotes.
 */
export function extractAddress(value: unknown): string {
  if (!value) return "";
  let normalized: unknown = value;
  if (typeof normalized === "string") {
    const trimmed = normalized.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { normalized = JSON.parse(trimmed); } catch { return trimmed; }
    } else {
      return trimmed;
    }
  }
  if (typeof normalized === "object" && normalized !== null) {
    const obj = normalized as Record<string, any>;
    return (
      obj.address ||
      obj.fullAddress ||
      [obj.line1, obj.line2, obj.city, obj.state, obj.pincode].filter(Boolean).join(", ")
    );
  }
  return "";
}

/**
 * The GST Principal Place of Business address as a single line, read from the
 * submissionSnapshot.gstAddresses snapshot. Used as the Company Address fallback
 * when the business_address column is empty (WhatsApp dealers onboarded before
 * the column was written — the GST address is always in this snapshot).
 */
export function gstPrincipalAddress(snapshotGst: unknown): string {
  const p = (snapshotGst as { principal?: Record<string, string> } | null)?.principal;
  if (!p) return "";
  return (
    p.raw ||
    [p.addressLine1, p.city, p.district, p.state, p.pincode].filter(Boolean).join(", ")
  );
}

/**
 * Resolve the dealer's office/company address: prefer the business_address
 * column, fall back to the GST principal place of business from the snapshot.
 */
export function resolveDealerAddress(
  businessAddress: unknown,
  gstAddressesSnapshot: unknown,
): string {
  return extractAddress(businessAddress) || gstPrincipalAddress(gstAddressesSnapshot);
}

/**
 * Default signatory designation for the dealer, derived from the firm type.
 * Mirrors the web onboarding wizard (StepAgreement dealerSignatoryOptions) so
 * WhatsApp dealers — which never capture a designation — print the same value.
 */
export function defaultDealerDesignation(companyType?: string | null): string {
  switch ((companyType || "").toLowerCase()) {
    case "sole_proprietorship":
    case "proprietorship":
      return "Owner";
    case "partnership_firm":
    case "partnership":
      return "Partner";
    case "private_limited_firm":
    case "private_limited":
    case "pvt_ltd":
      return "Director";
    case "llp":
      return "Designated Partner";
    default:
      return "Authorized Signatory";
  }
}
