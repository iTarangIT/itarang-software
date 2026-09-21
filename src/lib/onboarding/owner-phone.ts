// Owner-phone helpers shared by the WhatsApp onboarding orchestrator and the
// admin initiate-agreement route.
//
// Udyam certificates (and some bank statements) print the registered mobile
// MASKED — e.g. "98*****366". Gemini faithfully extracts that string, and it
// used to be written straight into owner_phone. Stripping non-digits then left
// "98366", which failed the agreement's signer-phone check with "Dealer and
// iTarang Signer 1 must have valid name, email, and phone."

/** Last 10 digits of a phone, or "" when it isn't a usable 10–15 digit number. */
function tenDigits(value?: string | null): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return "";
  return digits.slice(-10);
}

/** True when the value carries mask characters (e.g. "98*****366", "XXXXXX1234"). */
export function isMaskedPhone(value?: string | null): boolean {
  return /[*xX•]/.test(String(value || ""));
}

/**
 * A usable phone extracted from a document, or "" when it is masked or too
 * short. Callers treat "" as "not present" so a masked value never overwrites
 * a real one.
 */
export function usablePhone(value?: string | null): string {
  if (isMaskedPhone(value)) return "";
  return tenDigits(value) ? String(value).trim() : "";
}

/**
 * Resolve the dealer owner's signing phone (10 digits) or "" if none is usable.
 *
 * A valid owner_phone wins. When owner_phone is masked, the WhatsApp number the
 * application was collected from is used — but ONLY if it agrees with the
 * visible digits of the mask. For operator-run sessions wa_phone is the
 * operator's number, not the dealer's, so an unconditional fallback would put
 * the wrong person on the agreement.
 */
export function resolveOwnerPhone(
  ownerPhone?: string | null,
  waPhone?: string | null,
): string {
  const direct = usablePhone(ownerPhone);
  if (direct) return tenDigits(direct);

  const wa = tenDigits(waPhone);
  if (!wa || !isMaskedPhone(ownerPhone)) return "";

  // "98*****366" → leading "98", trailing "366" must match the WhatsApp number.
  const masked = String(ownerPhone).replace(/\s|-/g, "");
  const lead = (masked.match(/^\+?(\d*)/)?.[1] || "").replace(/^91(?=\d{2,})/, "");
  const trail = masked.match(/(\d*)$/)?.[1] || "";
  if (!lead && !trail) return "";
  if (lead && !wa.startsWith(lead)) return "";
  if (trail && !wa.endsWith(trail)) return "";
  return wa;
}
