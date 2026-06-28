// Verify the Aadhaar that actually signed a Digio consent/agreement matches the
// Aadhaar captured from the signer's documents.
//
// Digio's eSign completes with WHATEVER Aadhaar the signer uses — it does not
// enforce that the signing Aadhaar belongs to the customer/dealer whose KYC we
// collected. Digio does return the signer's MASKED Aadhaar (last 4 digits) on
// the signed event (signing_parties[].aadhaar_masked), which we already store on
// consent_records.signer_aadhaar_masked. This module compares that last-4
// against the captured Aadhaar so a consent/agreement signed with a DIFFERENT
// person's Aadhaar can be rejected.
//
// Limitation: only the last 4 digits are comparable (Digio masks the rest), so a
// match is strong (1-in-10,000) but not unique. We deliberately do NOT block
// when either side is missing (e.g. OCR didn't read the Aadhaar) to avoid false
// rejects — absence is "not comparable", not "mismatch".

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { personalDetails } from "@/lib/db/schema";

/** Last 4 digits of an Aadhaar-ish string (handles masked "XXXXXXXX1234" + full). */
export function aadhaarLast4(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export interface AadhaarCheck {
  /** True only when BOTH a signer last-4 and an expected last-4 are available. */
  comparable: boolean;
  /** True when not comparable OR the last-4 match — callers block on
   *  `comparable && !match`. */
  match: boolean;
  signerLast4: string | null;
  expectedLast4: string | null;
}

/** Compare a captured Aadhaar against the (masked) Aadhaar that signed. */
export function checkAadhaarMatch(
  expectedAadhaar: string | null | undefined,
  signerMaskedAadhaar: string | null | undefined,
): AadhaarCheck {
  const signerLast4 = aadhaarLast4(signerMaskedAadhaar);
  const expectedLast4 = aadhaarLast4(expectedAadhaar);
  if (!signerLast4 || !expectedLast4) {
    return { comparable: false, match: true, signerLast4, expectedLast4 };
  }
  return {
    comparable: true,
    match: signerLast4 === expectedLast4,
    signerLast4,
    expectedLast4,
  };
}

/** The Aadhaar captured (via OCR) from a lead's customer documents, or null. */
export async function getCustomerAadhaarForLead(
  leadId: string,
): Promise<string | null> {
  const [pd] = await db
    .select({ aadhaar_no: personalDetails.aadhaar_no })
    .from(personalDetails)
    .where(eq(personalDetails.lead_id, leadId))
    .limit(1);
  return pd?.aadhaar_no ?? null;
}

/** Human-readable mismatch reason for esign_error_message / audit. */
export function aadhaarMismatchMessage(check: AadhaarCheck): string {
  return (
    `Aadhaar mismatch: the document was signed with an Aadhaar ending ` +
    `${check.signerLast4} but the customer's documents show an Aadhaar ending ` +
    `${check.expectedLast4}. Please re-sign with the customer's own Aadhaar.`
  );
}
