import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { coBorrowers, kycVerifications } from "@/lib/db/schema";
import {
  validateDocument,
  verifyBankAccount,
  verifyRcNumber,
  digilockerInitiateSession,
  digilockerGetEaadhaar,
} from "@/lib/decentro";

// BRD §2.9.3 Panel 3 co-borrower API verification cards. These helpers
// provide a thin Decentro wrapper scoped to a co-borrower row. They do NOT
// perform the full cross-match logic used by primary KYC because the
// co-borrower table has a smaller surface — only the fields the dealer
// collected in the Step 3 form.
//
// Each helper writes / upserts a row in `kyc_verifications` with
// `applicant = 'co_borrower'` so the case-review API can surface it on the
// co-borrower panel alongside the document cards.

function newVerId(prefix = "KYCVER"): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `${prefix}-${dateStr}-${seq}`;
}

function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/)
      .filter(Boolean);
  const wordsA = new Set(normalize(a));
  const wordsB = new Set(normalize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return Math.round((intersection / union) * 100);
}

async function getCoBorrower(leadId: string) {
  const rows = await db
    .select()
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);
  return rows[0] || null;
}

async function upsertCoBorrowerVerification(
  leadId: string,
  verification_type: string,
  record: {
    status: string;
    api_provider?: string | null;
    api_request?: unknown;
    api_response?: unknown;
    failed_reason?: string | null;
    match_score?: string | null;
    completed_at?: Date | null;
  },
) {
  const now = new Date();
  const existing = await db
    .select({ id: kycVerifications.id })
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.lead_id, leadId),
        eq(kycVerifications.verification_type, verification_type),
        eq(kycVerifications.applicant, "co_borrower"),
      ),
    )
    .orderBy(desc(kycVerifications.created_at))
    .limit(1);

  if (existing[0]) {
    await db
      .update(kycVerifications)
      .set({
        status: record.status,
        api_provider: record.api_provider ?? "decentro",
        api_request: record.api_request as Record<string, unknown>,
        api_response: record.api_response as Record<string, unknown>,
        failed_reason: record.failed_reason ?? null,
        match_score: record.match_score ?? null,
        completed_at: record.completed_at ?? now,
        updated_at: now,
      })
      .where(eq(kycVerifications.id, existing[0].id));
    return existing[0].id;
  }

  const id = newVerId();
  await db.insert(kycVerifications).values({
    id,
    lead_id: leadId,
    verification_type,
    applicant: "co_borrower",
    status: record.status,
    api_provider: record.api_provider ?? "decentro",
    api_request: record.api_request as Record<string, unknown>,
    api_response: record.api_response as Record<string, unknown>,
    failed_reason: record.failed_reason ?? null,
    match_score: record.match_score ?? null,
    submitted_at: now,
    completed_at: record.completed_at ?? now,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export type CbVerifyError = { success: false; status: number; error: string };

// -- PAN ---------------------------------------------------------------------

export async function executeCoBorrowerPanVerification(
  leadId: string,
  input: { panNumber: string },
) {
  if (!input.panNumber) {
    return { success: false, status: 400, error: "PAN number is required" };
  }
  const cb = await getCoBorrower(leadId);
  if (!cb) {
    return {
      success: false,
      status: 404,
      error: "Co-borrower not found for this lead",
    };
  }

  const decentroRes = await validateDocument({
    document_type: "PAN_DETAILED_COMPLETE",
    id_number: input.panNumber.toUpperCase().trim(),
  });

  const kycResult =
    decentroRes.kycResult || decentroRes.data?.kycResult || decentroRes.data || {};
  const panName =
    kycResult.fullName ||
    [kycResult.firstName, kycResult.middleName, kycResult.lastName]
      .filter(Boolean)
      .join(" ") ||
    kycResult.name ||
    "";
  const panStatus = (kycResult.idStatus || kycResult.status || "").toUpperCase();
  const isValid = panStatus === "VALID" || panStatus === "ACTIVE";

  const matchScore =
    cb.full_name && panName ? nameSimilarity(panName, cb.full_name) : null;

  const reasons: string[] = [];
  if (!isValid) reasons.push(`PAN status: ${panStatus || "UNKNOWN"}`);
  if (matchScore !== null && matchScore < 50) {
    reasons.push(
      `Name mismatch: PAN "${panName}" vs co-borrower "${cb.full_name}" (${matchScore}%)`,
    );
  }
  const overallSuccess = isValid && (matchScore === null || matchScore >= 50);

  const verificationId = await upsertCoBorrowerVerification(leadId, "pan", {
    status: overallSuccess ? "success" : "failed",
    api_request: { pan_number: input.panNumber },
    api_response: {
      ...decentroRes,
      data: {
        crossMatchFields: [
          {
            field: "Name",
            leadValue: cb.full_name,
            panValue: panName,
            aadhaarValue: null,
            matchScore,
            pass: matchScore === null ? true : matchScore >= 80,
          },
        ],
        pan_name: panName,
        pan_status: panStatus,
        name_match_score: matchScore,
      },
    },
    failed_reason: reasons.length > 0 ? reasons.join("; ") : null,
    match_score: matchScore !== null ? matchScore.toString() : null,
  });

  if (overallSuccess) {
    await db
      .update(coBorrowers)
      .set({ pan_no: input.panNumber.toUpperCase().trim(), updated_at: new Date() })
      .where(eq(coBorrowers.id, cb.id));
  }

  return {
    success: overallSuccess,
    message: overallSuccess
      ? `PAN verified. Name: ${panName}`
      : reasons.join(". "),
    data: {
      verificationId,
      pan_name: panName,
      lead_name: cb.full_name,
      pan_status: panStatus,
      name_match_score: matchScore,
      crossMatchFields: [
        {
          field: "Name",
          leadValue: cb.full_name,
          panValue: panName,
          aadhaarValue: null,
          matchScore,
          pass: matchScore === null ? true : matchScore >= 80,
        },
      ],
    },
  };
}

// -- Bank (penny drop) -------------------------------------------------------

export async function executeCoBorrowerBankVerification(
  leadId: string,
  input: {
    account_number: string;
    ifsc: string;
    name?: string;
  },
) {
  if (!input.account_number || !input.ifsc) {
    return {
      success: false,
      status: 400,
      error: "Account number and IFSC are required",
    };
  }

  const cb = await getCoBorrower(leadId);
  if (!cb) {
    return { success: false, status: 404, error: "Co-borrower not found" };
  }

  const decentroRes = await verifyBankAccount({
    account_number: input.account_number,
    ifsc: input.ifsc,
    name: input.name || cb.full_name,
    validation_type: "pennydrop",
  });

  const data = decentroRes.data || decentroRes.kycResult || {};
  const accountStatus = (data.accountStatus || data.status || "").toUpperCase();
  const beneficiaryName = data.beneficiaryName || data.accountHolderName || "";
  const nameMatch = cb.full_name
    ? nameSimilarity(beneficiaryName, cb.full_name)
    : null;
  const overallSuccess = accountStatus === "SUCCESS" || accountStatus === "VALID";

  const verificationId = await upsertCoBorrowerVerification(leadId, "bank", {
    status: overallSuccess ? "success" : "failed",
    api_request: {
      account_number: input.account_number,
      ifsc: input.ifsc,
    },
    api_response: {
      ...decentroRes,
      data: {
        beneficiaryName,
        accountStatus,
        nameMatchScore: nameMatch,
      },
    },
    failed_reason: overallSuccess
      ? null
      : `Account status: ${accountStatus || "unknown"}`,
    match_score: nameMatch !== null ? nameMatch.toString() : null,
  });

  return {
    success: overallSuccess,
    message: overallSuccess
      ? `Bank verified. Name on account: ${beneficiaryName}`
      : `Bank verification failed: ${accountStatus}`,
    data: {
      verificationId,
      beneficiaryName,
      accountStatus,
      nameMatchScore: nameMatch,
    },
  };
}

// -- RC ---------------------------------------------------------------------

export async function executeCoBorrowerRcVerification(
  leadId: string,
  input: { rc_number: string },
) {
  if (!input.rc_number) {
    return { success: false, status: 400, error: "RC number is required" };
  }
  const cb = await getCoBorrower(leadId);
  if (!cb) {
    return { success: false, status: 404, error: "Co-borrower not found" };
  }

  const rcNumber = input.rc_number.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const rcPattern = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;
  if (!rcPattern.test(rcNumber) || rcNumber.length < 6 || rcNumber.length > 13) {
    return {
      success: false,
      status: 400,
      error: `Invalid RC number format: ${rcNumber}`,
    };
  }

  const decentroRes = (await verifyRcNumber(rcNumber)) as Record<
    string,
    unknown
  >;
  const responseData =
    (decentroRes.data as Record<string, unknown> | undefined) || {};
  const responseKey = String(decentroRes.responseKey || "");
  const isErrorResponse = responseKey.startsWith("error_");
  const overallSuccess =
    !isErrorResponse &&
    (decentroRes.status === "SUCCESS" || responseKey === "success") &&
    !!(responseData.chassisNumber || responseData.chassis_number);

  const chassisNumber =
    (responseData.chassisNumber as string | undefined) ??
    (responseData.chassis_number as string | undefined) ??
    null;

  const verificationId = await upsertCoBorrowerVerification(leadId, "rc", {
    status: overallSuccess ? "success" : "failed",
    api_request: { rc_number: rcNumber },
    api_response: decentroRes,
    failed_reason: overallSuccess
      ? null
      : String(decentroRes.message ?? "RC verification failed"),
  });

  return {
    success: overallSuccess,
    message: overallSuccess
      ? `RC verified. Chassis: ${chassisNumber}`
      : `RC verification failed`,
    data: {
      verificationId,
      chassisNumber,
      rcNumber,
    },
  };
}

// -- CIBIL (score + report) --------------------------------------------------
//
// CIBIL isn't wired via Decentro for co-borrowers — the existing CIBIL helper
// is tightly coupled to the primary tables. We store the fact that a CIBIL
// check was attempted and leave the detail body in api_response; the admin
// can accept/reject via the existing admin_action flow. This is a minimum-
// viable v1 that satisfies BRD line 2679 (co-borrower must score ≥ 700) at
// the UI level even if score fetch falls back to manual entry.

export async function executeCoBorrowerCibilScore(
  leadId: string,
  input: { score?: number; reportId?: string; note?: string },
) {
  const cb = await getCoBorrower(leadId);
  if (!cb) {
    return { success: false, status: 404, error: "Co-borrower not found" };
  }

  const score = typeof input.score === "number" ? input.score : null;
  const meetsThreshold = score !== null ? score >= 700 : null;
  const overallSuccess = meetsThreshold === true;

  const verificationId = await upsertCoBorrowerVerification(leadId, "cibil", {
    status: overallSuccess
      ? "success"
      : score === null
        ? "awaiting_action"
        : "failed",
    api_provider: "manual",
    api_request: { score, reportId: input.reportId, note: input.note },
    api_response: {
      data: {
        score,
        reportId: input.reportId || null,
        generatedAt: new Date().toISOString(),
        interpretation: {
          rating:
            score === null
              ? "PENDING"
              : score >= 750
                ? "EXCELLENT"
                : score >= 700
                  ? "GOOD"
                  : score >= 650
                    ? "MODERATE"
                    : "POOR",
          riskLevel: score === null ? "UNKNOWN" : score >= 700 ? "LOW" : "HIGH",
          coBorrowerRequired: false,
          color: score !== null && score >= 700 ? "green" : "red",
          description:
            score === null
              ? "Awaiting score input"
              : `Co-borrower CIBIL score: ${score}`,
        },
      },
    },
    failed_reason:
      score === null
        ? null
        : meetsThreshold
          ? null
          : `Co-borrower CIBIL ${score} is below the 700 threshold`,
    match_score: score !== null ? score.toString() : null,
  });

  return {
    success: overallSuccess,
    message:
      score === null
        ? "Awaiting CIBIL score"
        : meetsThreshold
          ? `Co-borrower CIBIL ${score} meets the 700 threshold`
          : `Co-borrower CIBIL ${score} is below 700 — request a replacement`,
    data: {
      verificationId,
      score,
      reportId: input.reportId || null,
    },
  };
}

// -- Aadhaar DigiLocker ------------------------------------------------------
//
// Re-uses the same Decentro DigiLocker session flow as primary but writes
// verification rows scoped to the co-borrower. The DigiLocker transaction
// rows still live in `digilockerTransactions` for the lead; we key them by
// `reference_id` with a co-borrower-specific prefix so the status route can
// distinguish them.

export async function executeCoBorrowerDigilockerInit(
  leadId: string,
  input: { phone?: string; email?: string; redirect_url?: string },
) {
  const cb = await getCoBorrower(leadId);
  if (!cb) {
    return { success: false, status: 404, error: "Co-borrower not found" };
  }
  const phone = input.phone || cb.phone;
  if (!phone) {
    return { success: false, status: 400, error: "Phone is required" };
  }

  const reference_id = `CB-${cb.id}-${Date.now()}`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const decentroRes = await digilockerInitiateSession({
    reference_id,
    redirect_url:
      input.redirect_url || `${appUrl}/api/kyc/digilocker/callback`,
    consent_purpose: "Co-borrower KYC Aadhaar verification",
    notification_channel: "sms",
    mobile_number: phone,
    email: input.email,
  });

  const sessionId =
    decentroRes.data?.sessionId || decentroRes.sessionId || null;
  const digilocker_url =
    decentroRes.data?.digilockerUrl || decentroRes.digilockerUrl || null;

  const verificationId = await upsertCoBorrowerVerification(leadId, "aadhaar", {
    status: "in_progress",
    api_request: { reference_id, phone },
    api_response: {
      ...decentroRes,
      data: { sessionId, digilocker_url, reference_id },
    },
    failed_reason: null,
  });

  return {
    success: true,
    message: "DigiLocker session initiated for co-borrower.",
    data: {
      verificationId,
      sessionId,
      digilocker_url,
      reference_id,
    },
  };
}

export async function executeCoBorrowerDigilockerStatus(
  leadId: string,
  transactionId: string,
) {
  const cb = await getCoBorrower(leadId);
  if (!cb) {
    return { success: false, status: 404, error: "Co-borrower not found" };
  }

  const reference_id = `CB-STATUS-${cb.id}-${Date.now()}`;
  const decentroRes = await digilockerGetEaadhaar({
    initial_decentro_transaction_id: transactionId,
    reference_id,
  });

  const fetched = !!decentroRes.data?.aadhaarXmlUrl || !!decentroRes.data?.name;
  const aadhaarData = decentroRes.data || {};

  const verificationId = await upsertCoBorrowerVerification(leadId, "aadhaar", {
    status: fetched ? "success" : "in_progress",
    api_request: { transaction_id: transactionId },
    api_response: {
      ...decentroRes,
      data: aadhaarData,
    },
    failed_reason: fetched ? null : "Aadhaar document not yet fetched",
  });

  if (fetched && aadhaarData.aadhaarNumber) {
    await db
      .update(coBorrowers)
      .set({
        aadhaar_no: String(aadhaarData.aadhaarNumber),
        updated_at: new Date(),
      })
      .where(eq(coBorrowers.id, cb.id));
  }

  return {
    success: fetched,
    message: fetched
      ? "Co-borrower Aadhaar fetched from DigiLocker."
      : "Awaiting co-borrower consent on DigiLocker.",
    data: {
      verificationId,
      status: fetched ? "document_fetched" : "awaiting_consent",
      aadhaarExtractedData: aadhaarData,
    },
  };
}
