/**
 * NBFC entity KYC — shared handler for CIN, PAN, and GSTIN verification.
 *
 * The three verification routes under /api/admin/nbfc/[nbfcId]/kyc/* all
 * resolve down to a single Decentro `validateDocument` call with a different
 * `document_type`. This module owns:
 *   1. resolving the id_number from the NBFC row,
 *   2. invoking Decentro,
 *   3. classifying the response into success | failed,
 *   4. persisting a row in nbfc_entity_kyc_verifications,
 *   5. returning a uniform JSON envelope to the caller.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfc, nbfcEntityKycVerifications } from "@/lib/db/schema";
import { validateDocument } from "@/lib/decentro";

export type EntityVerificationType = "cin" | "pan" | "gstin";

const DECENTRO_TYPE: Record<EntityVerificationType, "CIN" | "PAN" | "GSTIN"> = {
  cin: "CIN",
  pan: "PAN",
  gstin: "GSTIN",
};

export type EntityVerificationResult =
  | {
      ok: true;
      status: "success" | "failed";
      verificationId: number;
      providerReferenceId: string | null;
      raw: unknown;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

function classify(raw: unknown): {
  status: "success" | "failed";
  providerRef: string | null;
} {
  // Decentro v2 wraps results in `data` with a top-level responseStatus or
  // status field. The KYC stubs in tests/e2e/helpers/api-stubs.ts return
  // { responseCode, status: 'SUCCESS' | 'FAILURE' | 'ERROR' }.
  const r = (raw ?? {}) as Record<string, unknown>;
  const upstreamStatus =
    (typeof r.status === "string" && r.status.toUpperCase()) ||
    (typeof r.responseStatus === "string" && r.responseStatus.toUpperCase()) ||
    "";
  const isSuccess =
    upstreamStatus === "SUCCESS" ||
    upstreamStatus === "VALID" ||
    upstreamStatus === "OK";
  const ref =
    (typeof r.decentroTxnId === "string" && r.decentroTxnId) ||
    (typeof r.reference_id === "string" && r.reference_id) ||
    null;
  return { status: isSuccess ? "success" : "failed", providerRef: ref };
}

export async function runEntityVerification(args: {
  nbfcId: number;
  type: EntityVerificationType;
  verifiedBy: string | null;
}): Promise<EntityVerificationResult> {
  const { nbfcId, type, verifiedBy } = args;

  const [row] = await db
    .select({
      id: nbfc.id,
      cin: nbfc.cin,
      pan_number: nbfc.pan_number,
      gst_number: nbfc.gst_number,
    })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);

  if (!row) {
    return { ok: false, status: 404, error: "NBFC not found" };
  }

  const idNumber =
    type === "cin"
      ? row.cin
      : type === "pan"
        ? row.pan_number
        : row.gst_number;

  if (!idNumber) {
    return {
      ok: false,
      status: 422,
      error: `NBFC has no ${type.toUpperCase()} on record`,
    };
  }

  // NBFC_KYC_TEST_MODE=1 short-circuits the Decentro round-trip so headed
  // tests don't depend on a third-party sandbox being up. Non-prod only.
  const raw =
    process.env.NODE_ENV !== "production" &&
    process.env.NBFC_KYC_TEST_MODE === "1"
      ? {
          status: "SUCCESS",
          responseStatus: "SUCCESS",
          decentroTxnId: `stub-${type}-${Date.now()}`,
          stub: true,
          document_type: DECENTRO_TYPE[type],
          id_number: idNumber,
        }
      : await validateDocument({
          document_type: DECENTRO_TYPE[type],
          id_number: idNumber,
          consent_purpose: "NBFC entity KYC for onboarding approval",
        });

  const { status, providerRef } = classify(raw);

  const [inserted] = await db
    .insert(nbfcEntityKycVerifications)
    .values({
      nbfc_id: nbfcId,
      verification_type: type,
      id_number: idNumber,
      status,
      provider_reference_id: providerRef ?? null,
      raw_response: raw as object,
      verified_by: verifiedBy,
    })
    .returning({ id: nbfcEntityKycVerifications.id });

  return {
    ok: true,
    status,
    verificationId: inserted.id,
    providerReferenceId: providerRef,
    raw,
  };
}

export async function listEntityVerifications(nbfcId: number) {
  return db
    .select()
    .from(nbfcEntityKycVerifications)
    .where(eq(nbfcEntityKycVerifications.nbfc_id, nbfcId))
    .orderBy(nbfcEntityKycVerifications.verified_at);
}

export async function hasSuccessfulEntityVerifications(
  nbfcId: number,
): Promise<{ ok: boolean; missing: EntityVerificationType[] }> {
  const rows = await listEntityVerifications(nbfcId);
  const successful = new Set(
    rows.filter((r) => r.status === "success").map((r) => r.verification_type),
  );
  const required: EntityVerificationType[] = ["cin", "pan", "gstin"];
  const missing = required.filter((t) => !successful.has(t));
  return { ok: missing.length === 0, missing };
}
