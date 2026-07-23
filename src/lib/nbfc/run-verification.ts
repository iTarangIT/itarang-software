/**
 * NBFC-side KYC document re-run (Decentro) — the NBFC runs the SAME verification
 * APIs the admin runs, from its own Acquire dashboard.
 *
 * Design: this reuses the admin service layer verbatim
 * (executePanVerification / executeBankVerification / the co-borrower services /
 * verifyRcNumber / the credit-bureau provider), which refresh the shared,
 * lead-scoped `kyc_verifications` row for the document. That row carries only the
 * OBJECTIVE Decentro result — re-running it does NOT touch `admin_action`, so the
 * admin's accept/reject verdict is preserved, and the NBFC's own opinion lives
 * separately in `nbfc_document_verifications` (the /verify-doc route). Two NBFCs
 * on one lead share the same objective result, which is correct (it's the same
 * PAN/bank/RC/CIBIL). Inputs are auto-resolved from the captured KYC data so the
 * NBFC just clicks "Run".
 *
 * Unlike the admin routes, this deliberately does NOT stamp
 * kyc_verification_metadata.first_api_execution_at (that consumes the dealer's
 * coupon — an NBFC re-run must not).
 *
 * Aadhaar/DigiLocker is async (needs the customer) and is handled by the
 * separate initiate/status routes, not here.
 */
import { and, desc, eq, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  coBorrowers,
  kycVerifications,
  leads,
  personalDetails,
} from "@/lib/db/schema";
import { executePanVerification } from "@/lib/kyc/pan-verification";
import { executeBankVerification } from "@/lib/kyc/bank-verification";
import { executeCoBorrowerPanVerification } from "@/lib/kyc/coborrower-verification";
import { verifyRcNumber } from "@/lib/decentro";
import { getCreditBureauProvider } from "@/lib/credit-bureau";
import { interpretCibilScore } from "@/lib/kyc/cibil-interpreter";

export type RunDocKey = "pan" | "bank" | "rc" | "cibil";
export type RunDocFor = "primary" | "co_borrower";

export const RUNNABLE_DOC_KEYS: RunDocKey[] = ["pan", "bank", "rc", "cibil"];

export type RunOutcome =
  | { success: boolean; message?: string; data?: unknown }
  | { success: false; status: number; error: string | { message: string } };

function newVerId(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `KYCVER-${dateStr}-${seq}`;
}

/** Mirror of admin RC route (rc/verify) — Decentro RC→chassis, upsert the shared
 *  primary `rc` verification row. No coupon/metadata side-effects. */
async function runPrimaryRc(leadId: string, rcInput?: string): Promise<RunOutcome> {
  let rcNumber = (rcInput ?? "").trim();
  if (!rcNumber) {
    const [pd] = await db
      .select({ vehicle_rc: personalDetails.vehicle_rc })
      .from(personalDetails)
      .where(eq(personalDetails.lead_id, leadId))
      .limit(1);
    rcNumber = pd?.vehicle_rc?.trim() || "";
  }
  if (!rcNumber) {
    return { success: false, status: 400, error: "No RC number on file for this customer" };
  }
  rcNumber = rcNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const rcPattern = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;
  if (!rcPattern.test(rcNumber) || rcNumber.length < 6 || rcNumber.length > 13) {
    return { success: false, status: 400, error: `Invalid RC number format: ${rcNumber}` };
  }

  const decentroRes = (await verifyRcNumber(rcNumber)) as Record<string, unknown>;
  const responseData = (decentroRes?.data as Record<string, unknown>) || {};
  const responseKey = String(decentroRes?.responseKey || "");
  const isErrorResponse = responseKey.startsWith("error_");
  const overallSuccess =
    !isErrorResponse &&
    (decentroRes?.status === "SUCCESS" || responseKey === "success") &&
    !!(responseData.chassisNumber || responseData.chassis_number);

  const now = new Date();
  const [existing] = await db
    .select({ id: kycVerifications.id })
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.lead_id, leadId),
        eq(kycVerifications.verification_type, "rc"),
        or(eq(kycVerifications.applicant, "primary"), isNull(kycVerifications.applicant)),
      ),
    )
    .limit(1);
  const verData = {
    status: overallSuccess ? "success" : "failed",
    api_provider: "decentro",
    api_request: { rc_number: rcNumber } as Record<string, unknown>,
    api_response: decentroRes as Record<string, unknown>,
    failed_reason: overallSuccess
      ? null
      : (decentroRes?.message as string | undefined) || "RC verification failed",
    completed_at: now,
    updated_at: now,
  };
  const verificationId = existing?.id || newVerId();
  if (existing) {
    await db.update(kycVerifications).set(verData).where(eq(kycVerifications.id, existing.id));
  } else {
    await db.insert(kycVerifications).values({
      id: verificationId,
      lead_id: leadId,
      verification_type: "rc",
      applicant: "primary",
      submitted_at: now,
      created_at: now,
      ...verData,
    });
  }
  return {
    success: overallSuccess,
    message: overallSuccess
      ? `RC verified. Chassis: ${responseData.chassisNumber || responseData.chassis_number}`
      : "RC verification failed",
    data: { verificationId, rcNumber },
  };
}

/** Mirror of admin CIBIL score route — provider-routed score fetch, upsert the
 *  shared primary `cibil` verification row. No coupon/metadata side-effects. */
async function runPrimaryCibil(leadId: string): Promise<RunOutcome> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return { success: false, status: 404, error: "Lead not found" };
  const [pd] = await db
    .select()
    .from(personalDetails)
    .where(eq(personalDetails.lead_id, leadId))
    .limit(1);

  const name = lead.full_name || lead.owner_name || "";
  const phone = lead.phone || lead.mobile || lead.owner_contact || "";
  if (!name || !phone) {
    return { success: false, status: 400, error: "Name and phone are required for a credit score" };
  }
  const dob = pd?.dob
    ? new Date(pd.dob).toISOString().slice(0, 10)
    : lead.dob
      ? new Date(lead.dob).toISOString().slice(0, 10)
      : "";
  const address = pd?.local_address || lead.local_address || lead.current_address || "";

  const result = await getCreditBureauProvider(null).fetchScore({
    name,
    pan: pd?.pan_no || "",
    dob,
    phone,
    address,
  });
  const decentroRes = (result.raw as Record<string, unknown> | null) || {};
  const score = result.score;
  const overallSuccess = result.error === null && score !== null;
  const interpretation =
    score !== null && !Number.isNaN(score) ? interpretCibilScore(score) : null;

  const now = new Date();
  const existingData =
    decentroRes.data && typeof decentroRes.data === "object"
      ? (decentroRes.data as Record<string, unknown>)
      : {};
  const apiResponseEnriched = {
    ...decentroRes,
    data: {
      ...existingData,
      interpretation,
      reportId: (decentroRes.decentroTxnId as string) || null,
      generatedAt: now.toISOString(),
    },
  };

  const [existing] = await db
    .select({ id: kycVerifications.id })
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.lead_id, leadId),
        eq(kycVerifications.verification_type, "cibil"),
        or(eq(kycVerifications.applicant, "primary"), isNull(kycVerifications.applicant)),
      ),
    )
    .limit(1);
  const verData = {
    status: overallSuccess ? "success" : "failed",
    api_provider: "decentro",
    api_request: { name, pan: pd?.pan_no || "", dob, phone, address } as Record<string, unknown>,
    api_response: apiResponseEnriched as Record<string, unknown>,
    failed_reason: overallSuccess
      ? null
      : (decentroRes.message as string | undefined) || "CIBIL score fetch failed",
    match_score: score ? String(score) : null,
    completed_at: now,
    updated_at: now,
  };
  const verificationId = existing?.id || newVerId();
  if (existing) {
    await db.update(kycVerifications).set(verData).where(eq(kycVerifications.id, existing.id));
  } else {
    await db.insert(kycVerifications).values({
      id: verificationId,
      lead_id: leadId,
      verification_type: "cibil",
      applicant: "primary",
      submitted_at: now,
      created_at: now,
      ...verData,
    });
  }
  return {
    success: overallSuccess,
    message: overallSuccess ? `Credit score: ${score}` : (verData.failed_reason ?? "CIBIL fetch failed"),
    data: { verificationId, score, interpretation },
  };
}

async function getCoBorrowerRow(leadId: string) {
  const [cb] = await db
    .select()
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);
  return cb ?? null;
}

/**
 * Run one document's Decentro verification for the given applicant. Inputs are
 * auto-resolved from the captured KYC data. Returns the underlying service's
 * result (which also persisted to kyc_verifications).
 */
export async function runNbfcDocVerification(opts: {
  leadId: string;
  docKey: RunDocKey;
  docFor: RunDocFor;
}): Promise<RunOutcome> {
  const { leadId, docKey, docFor } = opts;

  if (docFor === "co_borrower") {
    const cb = await getCoBorrowerRow(leadId);
    if (!cb) return { success: false, status: 404, error: "No co-borrower on this lead" };
    switch (docKey) {
      case "pan":
        if (!cb.pan_no) return { success: false, status: 400, error: "No PAN on file for the co-borrower" };
        return executeCoBorrowerPanVerification(leadId, { panNumber: cb.pan_no });
      case "bank":
        // The co-borrower record has no bank columns; the service needs
        // account_number + ifsc, which aren't captured for co-borrowers.
        return {
          success: false,
          status: 400,
          error: "Bank details are not captured for the co-borrower — cannot run a penny-drop.",
        };
      case "rc":
        return {
          success: false,
          status: 400,
          error: "No RC number is captured for the co-borrower.",
        };
      case "cibil":
        return {
          success: false,
          status: 400,
          error: "Co-borrower credit-bureau pull is not available yet.",
        };
      default:
        return { success: false, status: 400, error: `Unknown document '${docKey}'` };
    }
  }

  // Primary applicant.
  const [pd] = await db
    .select()
    .from(personalDetails)
    .where(eq(personalDetails.lead_id, leadId))
    .limit(1);

  switch (docKey) {
    case "pan":
      if (!pd?.pan_no) return { success: false, status: 400, error: "No PAN on file for this customer" };
      return executePanVerification(leadId, { panNumber: pd.pan_no });
    case "bank":
      if (!pd?.bank_account_number || !pd?.bank_ifsc) {
        return {
          success: false,
          status: 400,
          error: "Bank account number and IFSC are not on file for this customer",
        };
      }
      return executeBankVerification(leadId, {
        accountNumber: pd.bank_account_number,
        ifsc: pd.bank_ifsc,
        performNameMatch: true,
        validationType: "pennydrop",
      });
    case "rc":
      return runPrimaryRc(leadId);
    case "cibil":
      return runPrimaryCibil(leadId);
    default:
      return { success: false, status: 400, error: `Unknown document '${docKey}'` };
  }
}
