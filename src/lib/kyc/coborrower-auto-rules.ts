// E-264 — when a co-borrower is required by policy rather than by judgement.
//
// Three rules, all evaluated from what the customer's own documents already say:
//
//   • age under 18   — cannot contract for a loan alone
//   • age over 55    — tenure would run past typical earning years
//   • female applicant
//
// WHERE THE INPUTS COME FROM.
//
// Date of birth is on `leads.dob` / `personal_details.dob`, filled by the
// Aadhaar and PAN extraction. Gender has NO column anywhere in the schema — but
// the Aadhaar extraction prompt has always asked for it, so it is sitting in
// `kyc_documents.ocr_data` on the aadhaar_front row. We read it from there
// rather than adding a column: the value is already captured, and a migration
// to duplicate it would need applying to every environment before this rule
// could run anywhere.
//
// WHAT THIS DELIBERATELY DOES NOT DO: decide on its own. It returns a verdict
// and a human-readable reason; the caller decides when to act on it, and the
// reason is what lands in `co_borrower_requests.reason` so anyone reviewing the
// file later can see exactly which rule fired.

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { coBorrowers, kycDocuments, leads, personalDetails } from "@/lib/db/schema";

export const MIN_SOLO_AGE = 18;
export const MAX_SOLO_AGE = 55;

export interface AutoCoBorrowerVerdict {
  required: boolean;
  /** Human-readable, and written verbatim into the request. */
  reason: string | null;
  /** Every rule that fired, for logging. */
  rules: string[];
  age: number | null;
  gender: string | null;
}

export async function evaluateAutoCoBorrower(
  leadId: string,
): Promise<AutoCoBorrowerVerdict> {
  const empty: AutoCoBorrowerVerdict = {
    required: false,
    reason: null,
    rules: [],
    age: null,
    gender: null,
  };

  const [lead] = await db
    .select({ dob: leads.dob, has_co_borrower: leads.has_co_borrower })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return empty;

  // Already has one — nothing to decide.
  if (lead.has_co_borrower) return empty;

  const [pd] = await db
    .select({ dob: personalDetails.dob })
    .from(personalDetails)
    .where(eq(personalDetails.lead_id, leadId))
    .limit(1);

  const age = ageFrom(lead.dob ?? pd?.dob ?? null);
  const gender = await readGender(leadId);

  const rules: string[] = [];
  if (age !== null && age < MIN_SOLO_AGE) {
    rules.push(`applicant is ${age} (under ${MIN_SOLO_AGE})`);
  }
  if (age !== null && age > MAX_SOLO_AGE) {
    rules.push(`applicant is ${age} (over ${MAX_SOLO_AGE})`);
  }
  if (gender === "female") {
    rules.push("applicant is female");
  }

  if (rules.length === 0) return { ...empty, age, gender };

  return {
    required: true,
    reason: `Co-borrower required by policy — ${rules.join("; ")}.`,
    rules,
    age,
    gender,
  };
}

/** Whole years, or null when the date is missing or unparseable. */
export function ageFrom(dob: string | Date | null): number | null {
  if (!dob) return null;
  const d = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Gender as printed on the customer's Aadhaar, normalised.
 *
 * Reads the extraction blob because there is no column. Aadhaar prints "MALE" /
 * "FEMALE" (and Hindi equivalents), so anything that is not recognisably one of
 * the two returns null and the rule simply does not fire — a missing value must
 * never be guessed into a lending decision.
 */
async function readGender(leadId: string): Promise<string | null> {
  const [doc] = await db
    .select({ ocr_data: kycDocuments.ocr_data })
    .from(kycDocuments)
    .where(
      and(
        eq(kycDocuments.lead_id, leadId),
        eq(kycDocuments.doc_for, "customer"),
        eq(kycDocuments.doc_type, "aadhaar_front"),
      ),
    )
    .orderBy(desc(kycDocuments.created_at))
    .limit(1);

  const raw = (doc?.ocr_data as Record<string, unknown> | null)?.gender;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.startsWith("f") || v.includes("महिला") || v.includes("स्त्री")) return "female";
  if (v.startsWith("m") || v.includes("पुरुष")) return "male";
  return null;
}

/** True when a co-borrower row already exists and has been handed back. */
export async function coBorrowerAlreadySubmitted(
  leadId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ submitted: coBorrowers.verification_submitted_at })
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);
  return Boolean(row?.submitted);
}
