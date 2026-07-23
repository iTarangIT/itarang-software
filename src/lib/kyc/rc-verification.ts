/**
 * Shared RC (registration certificate → chassis) verification.
 *
 * Extracted from the admin RC-verify route so the NBFC Acquire dashboard can run
 * the SAME Decentro RC→chassis check the admin runs, against the same shared,
 * lead-scoped `kyc_verifications` row. The row carries only the OBJECTIVE Decentro
 * result, so re-running it never touches `admin_action` (the admin verdict is
 * preserved) — exactly like the sibling PAN/bank services used by
 * `src/lib/nbfc/run-verification.ts`.
 *
 * This helper deliberately does NOT touch `kyc_verification_metadata`
 * (first_api_execution_at / the dealer's coupon). The admin route stamps that
 * itself after a successful call; the NBFC mirror must not consume the coupon.
 *
 * Returns the SAME response body shape the admin RC route returns, so
 * RCCard.tsx (which reads `data.data.rcDetails.chassisNumber` and
 * `data.data.verificationId` on a fresh verify) keeps working unchanged.
 */
import { and, desc, eq, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  coBorrowers,
  kycVerifications,
  personalDetails,
} from "@/lib/db/schema";
import { verifyRcNumber } from "@/lib/decentro";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";

export type RcApplicant = "primary" | "co_borrower";

export interface RcVerificationResult {
  success: boolean;
  message?: string;
  data?: {
    verificationId: string;
    rcNumber: string;
    rcDetails: { chassisNumber: string | null; rcNumber: string };
    rawResponse: unknown;
  };
  error?: { message: string };
  /**
   * Set ONLY when the helper short-circuits on a validation error (bad/missing
   * RC number, no co-borrower) BEFORE calling Decentro. Callers should surface
   * this as the HTTP status and must NOT stamp the coupon in that case. When a
   * Decentro call actually ran (success OR failure) this is absent.
   */
  status?: number;
}

// Indian RC format: 2-letter state + 1-2 digit district + 0-3 alpha series + 1-4 digit number.
// Examples: MH12AB1234, DL1CAB1234, KA01MA1234.
const RC_PATTERN = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;

/**
 * Run the Decentro RC→chassis verification for a lead's primary applicant or
 * co-borrower and upsert the shared `kyc_verifications` row (verification_type
 * "rc", scoped to the applicant). Never touches metadata / the coupon.
 *
 * RC number resolution:
 *  - primary: opts.rcNumber, else personalDetails.vehicle_rc.
 *  - co_borrower: opts.rcNumber only (co_borrowers has no RC column).
 */
export async function executeRcVerification(
  leadId: string,
  opts: { rcNumber?: string; applicant?: RcApplicant } = {},
): Promise<RcVerificationResult> {
  const applicant: RcApplicant = opts.applicant ?? "primary";
  let rcNumber = typeof opts.rcNumber === "string" ? opts.rcNumber.trim() : "";

  if (applicant === "co_borrower") {
    const [cb] = await db
      .select({ id: coBorrowers.id })
      .from(coBorrowers)
      .where(eq(coBorrowers.lead_id, leadId))
      .limit(1);
    if (!cb) {
      return {
        success: false,
        status: 404,
        error: { message: "Co-borrower not found" },
      };
    }
    if (!rcNumber) {
      return {
        success: false,
        status: 400,
        error: { message: "RC number is required" },
      };
    }
  } else {
    if (!rcNumber) {
      const [pd] = await db
        .select({ vehicle_rc: personalDetails.vehicle_rc })
        .from(personalDetails)
        .where(eq(personalDetails.lead_id, leadId))
        .limit(1);
      rcNumber = pd?.vehicle_rc?.trim() || "";
    }
    if (!rcNumber) {
      return {
        success: false,
        status: 400,
        error: {
          message:
            "RC number is required — provide in request body or ensure it exists in lead details",
        },
      };
    }
  }

  // Normalize: remove dots, dashes, spaces and uppercase.
  rcNumber = rcNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!RC_PATTERN.test(rcNumber) || rcNumber.length < 6 || rcNumber.length > 13) {
    return {
      success: false,
      status: 400,
      error: {
        message:
          applicant === "co_borrower"
            ? `Invalid RC number format: ${rcNumber}`
            : `Invalid RC number format "${rcNumber}". Expected format: MH12AB1234 (state + district + series + number)`,
      },
    };
  }

  // Call Decentro RC to Chassis API.
  const decentroRes = (await verifyRcNumber(rcNumber)) as Record<string, unknown>;
  console.log("[RC to Chassis] Response:", JSON.stringify(decentroRes));

  const responseData = (decentroRes?.data as Record<string, unknown>) || {};
  const responseKey = String(decentroRes?.responseKey || "");
  const isErrorResponse = responseKey.startsWith("error_");
  const chassisNumber =
    (responseData.chassisNumber as string | undefined) ??
    (responseData.chassis_number as string | undefined) ??
    null;
  const overallSuccess =
    !isErrorResponse &&
    (decentroRes?.status === "SUCCESS" || responseKey === "success") &&
    !!chassisNumber;

  const rcDetails = { chassisNumber, rcNumber };
  const now = new Date();

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

  // Upsert the shared row, scoped to the applicant.
  let verificationId: string;
  if (applicant === "co_borrower") {
    const [existing] = await db
      .select({ id: kycVerifications.id })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "rc"),
          eq(kycVerifications.applicant, "co_borrower"),
        ),
      )
      .orderBy(desc(kycVerifications.created_at))
      .limit(1);
    verificationId = existing?.id || createWorkflowId("KYCVER", now);
    if (existing) {
      await db
        .update(kycVerifications)
        .set(verData)
        .where(eq(kycVerifications.id, existing.id));
    } else {
      await db.insert(kycVerifications).values({
        id: verificationId,
        lead_id: leadId,
        verification_type: "rc",
        applicant: "co_borrower",
        submitted_at: now,
        created_at: now,
        ...verData,
      });
    }
  } else {
    const [existing] = await db
      .select({ id: kycVerifications.id })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "rc"),
          or(
            eq(kycVerifications.applicant, "primary"),
            isNull(kycVerifications.applicant),
          ),
        ),
      )
      .limit(1);
    verificationId = existing?.id || createWorkflowId("KYCVER", now);
    if (existing) {
      await db
        .update(kycVerifications)
        .set(verData)
        .where(eq(kycVerifications.id, existing.id));
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
  }

  return {
    success: overallSuccess,
    message: overallSuccess
      ? `RC verified. Chassis: ${chassisNumber}`
      : (decentroRes?.message as string | undefined) || "RC verification failed",
    data: {
      verificationId,
      rcNumber,
      rcDetails,
      rawResponse: decentroRes,
    },
    ...(overallSuccess
      ? {}
      : {
          error: {
            message:
              (decentroRes?.message as string | undefined) ||
              "RC verification failed",
          },
        }),
  };
}
