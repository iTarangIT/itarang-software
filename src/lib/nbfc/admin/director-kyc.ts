/**
 * NBFC director KYC — shared handler for PAN, Aadhaar, and RC verification.
 *
 * Mirrors `entity-kyc.ts` but resolves against `nbfc_directors` rather than
 * the NBFC master row. Decentro coverage:
 *   - PAN     -> validateDocument({ document_type: 'PAN', id_number })
 *   - Aadhaar -> aadhaarGenerateOtp(); we record the txn and treat OTP issue
 *                as a successful "initiate" step for sanchit's review queue.
 *                Full OTP validation is out-of-scope for the loop; the audit
 *                row carries the decentro_txn_id so a manual operator can
 *                complete the OTP flow if needed.
 *   - RC      -> verifyRcNumber(rc_number)
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  nbfcDirectors,
  nbfcDirectorKycVerifications,
} from "@/lib/db/schema";
import {
  aadhaarGenerateOtp,
  validateDocument,
  verifyRcNumber,
} from "@/lib/decentro";

export type DirectorVerificationType = "pan" | "aadhaar" | "rc";

export type DirectorVerificationResult =
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

function pickProviderRef(raw: unknown): string | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.decentroTxnId === "string") return r.decentroTxnId;
  if (typeof r.decentro_txn_id === "string") return r.decentro_txn_id;
  if (typeof r.reference_id === "string") return r.reference_id;
  return null;
}

function isUpstreamSuccess(raw: unknown): boolean {
  const r = (raw ?? {}) as Record<string, unknown>;
  const upstream =
    (typeof r.status === "string" && r.status.toUpperCase()) ||
    (typeof r.responseStatus === "string" && r.responseStatus.toUpperCase()) ||
    "";
  return (
    upstream === "SUCCESS" ||
    upstream === "VALID" ||
    upstream === "OK" ||
    upstream === "OTP_SENT"
  );
}

export async function runDirectorVerification(args: {
  directorId: number;
  type: DirectorVerificationType;
  payload?: { aadhaarNumber?: string; rcNumber?: string };
  verifiedBy: string | null;
}): Promise<DirectorVerificationResult> {
  const { directorId, type, payload, verifiedBy } = args;

  const [director] = await db
    .select()
    .from(nbfcDirectors)
    .where(eq(nbfcDirectors.id, directorId))
    .limit(1);

  if (!director) {
    return { ok: false, status: 404, error: "Director not found" };
  }

  // NBFC_KYC_TEST_MODE=1 short-circuits all Decentro round-trips so the
  // headed journey is deterministic. Non-prod only.
  const stubMode =
    process.env.NODE_ENV !== "production" &&
    process.env.NBFC_KYC_TEST_MODE === "1";

  let raw: unknown;
  if (type === "pan") {
    if (!director.pan_number) {
      return { ok: false, status: 422, error: "Director has no PAN on record" };
    }
    raw = stubMode
      ? {
          status: "SUCCESS",
          responseStatus: "SUCCESS",
          decentroTxnId: `stub-director-pan-${Date.now()}`,
          stub: true,
          id_number: director.pan_number,
        }
      : await validateDocument({
          document_type: "PAN",
          id_number: director.pan_number,
          consent_purpose: "NBFC director KYC for onboarding approval",
        });
  } else if (type === "aadhaar") {
    const aadhaar = payload?.aadhaarNumber;
    if (!aadhaar || !/^\d{12}$/.test(aadhaar)) {
      return {
        ok: false,
        status: 422,
        error: "Valid 12-digit Aadhaar number required",
      };
    }
    raw = stubMode
      ? {
          status: "OTP_SENT",
          responseStatus: "OTP_SENT",
          decentroTxnId: `stub-director-aadhaar-${Date.now()}`,
          stub: true,
          aadhaar_last4: aadhaar.slice(-4),
        }
      : await aadhaarGenerateOtp(aadhaar);
    await db
      .update(nbfcDirectors)
      .set({ aadhaar_last4: aadhaar.slice(-4), updated_at: new Date() })
      .where(eq(nbfcDirectors.id, directorId));
  } else if (type === "rc") {
    const rc = payload?.rcNumber || director.rc_number || null;
    if (!rc) {
      return { ok: false, status: 422, error: "RC number required" };
    }
    raw = stubMode
      ? {
          status: "SUCCESS",
          responseStatus: "SUCCESS",
          decentroTxnId: `stub-director-rc-${Date.now()}`,
          stub: true,
          rc_number: rc,
        }
      : await verifyRcNumber(rc);
    if (!director.rc_number || director.rc_number !== rc) {
      await db
        .update(nbfcDirectors)
        .set({ rc_number: rc, updated_at: new Date() })
        .where(eq(nbfcDirectors.id, directorId));
    }
  } else {
    return { ok: false, status: 400, error: "Unknown verification type" };
  }

  const status = isUpstreamSuccess(raw) ? "success" : "failed";
  const providerRef = pickProviderRef(raw);

  const [inserted] = await db
    .insert(nbfcDirectorKycVerifications)
    .values({
      director_id: directorId,
      verification_type: type,
      status,
      provider_reference_id: providerRef ?? null,
      raw_response: raw as object,
      verified_by: verifiedBy,
    })
    .returning({ id: nbfcDirectorKycVerifications.id });

  return {
    ok: true,
    status,
    verificationId: inserted.id,
    providerReferenceId: providerRef,
    raw,
  };
}

export async function hasSuccessfulDirectorVerifications(
  nbfcId: number,
): Promise<{ ok: boolean; missing: DirectorVerificationType[] }> {
  const directors = await db
    .select({ id: nbfcDirectors.id })
    .from(nbfcDirectors)
    .where(eq(nbfcDirectors.nbfc_id, nbfcId));
  if (directors.length === 0) {
    // No director recorded — treat all three as missing so reviewers know
    // they need to populate the director subject before approving.
    return { ok: false, missing: ["pan", "aadhaar", "rc"] };
  }
  const directorIds = directors.map((d) => d.id);
  const allVerifs = await db
    .select()
    .from(nbfcDirectorKycVerifications);
  const successful = new Set<DirectorVerificationType>();
  for (const v of allVerifs) {
    if (!directorIds.includes(v.director_id)) continue;
    if (v.status === "success") {
      successful.add(v.verification_type as DirectorVerificationType);
    }
  }
  const required: DirectorVerificationType[] = ["pan", "aadhaar", "rc"];
  const missing = required.filter((t) => !successful.has(t));
  return { ok: missing.length === 0, missing };
}
