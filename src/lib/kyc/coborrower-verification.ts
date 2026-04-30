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

// Mirrors src/lib/kyc/pan-verification.ts:computeMatch so co-borrower PAN
// cross-match rows ship with the same { score, pass } shape the primary
// produces and PANCard.tsx already knows how to render.
function computeMatch(
  a: string | null | undefined,
  b: string | null | undefined,
  type: "similarity" | "exact" | "phone" = "similarity",
): { score: number | null; pass: boolean } {
  if (!a || !b) return { score: null, pass: true };
  if (type === "exact") {
    const match = a.trim().toLowerCase() === b.trim().toLowerCase();
    return { score: match ? 100 : 0, pass: match };
  }
  if (type === "phone") {
    const match =
      a.replace(/\D/g, "").slice(-10) === b.replace(/\D/g, "").slice(-10);
    return { score: match ? 100 : 0, pass: match };
  }
  const sim = nameSimilarity(a, b);
  return { score: sim, pass: sim >= 80 };
}

function formatDob(value: unknown): string {
  if (!value) return "";
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
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

  // Mirror primary's allCrossMatchFields shape (pan-verification.ts:376-432)
  // so the front-end Verification Match Results table renders the same set of
  // rows on the co-borrower side. Aadhaar column stays null until we wire in
  // the co-borrower DigiLocker extracted data.
  const cbFatherName = (cb.father_or_husband_name as string | null) || null;
  const cbAddress = (cb.address as string | null) || (cb.current_address as string | null) || null;
  const cbDob = formatDob(cb.dob);
  const cbPhone = (cb.phone as string | null) || null;

  const panDob = (kycResult.dateOfBirth || kycResult.dob || "") as string;
  const panAddressRaw = kycResult.address as unknown;
  const panAddress =
    panAddressRaw && typeof panAddressRaw === "object" && (panAddressRaw as { full?: string }).full
      ? ((panAddressRaw as { full: string }).full)
      : typeof panAddressRaw === "string"
        ? panAddressRaw
        : "";
  const panMobile = (kycResult.mobile || kycResult.phone || kycResult.mobileNumber || "") as string;
  const panGender = (kycResult.gender || "") as string;
  const panFather = (kycResult.fatherName || "") as string;

  const dobMatch = computeMatch(cbDob, panDob, "exact");
  const addressMatch = computeMatch(cbAddress, panAddress);
  const mobileMatch = computeMatch(cbPhone, panMobile, "phone");
  const fatherMatch = computeMatch(cbFatherName, panFather);

  const allCrossMatchFields = [
    {
      field: "Name",
      leadValue: cb.full_name || null,
      panValue: panName || null,
      aadhaarValue: null,
      matchScore,
      pass: matchScore === null ? true : matchScore >= 80,
    },
    {
      field: "Gender",
      leadValue: null,
      panValue: panGender || null,
      aadhaarValue: null,
      matchScore: null,
      pass: true,
    },
    {
      field: "DOB",
      leadValue: cbDob || null,
      panValue: panDob || null,
      aadhaarValue: null,
      matchScore: dobMatch.score,
      pass: dobMatch.pass,
    },
    {
      field: "Address",
      leadValue: cbAddress,
      panValue: panAddress || null,
      aadhaarValue: null,
      matchScore: addressMatch.score,
      pass: addressMatch.pass,
    },
    {
      field: "Mobile",
      leadValue: cbPhone,
      panValue: panMobile || null,
      aadhaarValue: null,
      matchScore: mobileMatch.score,
      pass: mobileMatch.pass,
    },
    {
      field: "Father/Husband Name",
      leadValue: cbFatherName,
      panValue: panFather || null,
      aadhaarValue: null,
      matchScore: fatherMatch.score,
      pass: fatherMatch.pass,
    },
  ];

  const crossMatchFields = allCrossMatchFields.filter((f) => f.leadValue || f.panValue);

  const verificationId = await upsertCoBorrowerVerification(leadId, "pan", {
    status: overallSuccess ? "success" : "failed",
    api_request: { pan_number: input.panNumber },
    api_response: {
      ...decentroRes,
      data: {
        crossMatchFields,
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
      crossMatchFields,
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
    perform_name_match?: boolean;
    validation_type?: "penniless" | "pennydrop" | "hybrid";
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
    ifsc: input.ifsc.toUpperCase().trim(),
    name: input.name || cb.full_name || undefined,
    perform_name_match: input.perform_name_match,
    validation_type: input.validation_type ?? "pennydrop",
  });

  // Mirror primary handler's misconfig short-circuit (bank-verification.ts:55-68)
  // so the BankCard front-end's existing config-banner branch (BankCard.tsx:110-114)
  // lights up cleanly on the co-borrower side too.
  const isMisconfig =
    typeof decentroRes.message === "string" &&
    /must be set in \.env/i.test(decentroRes.message);
  if (isMisconfig) {
    return {
      success: false,
      status: 503,
      error: {
        message:
          "Bank verification is not available on this server — contact the administrator to configure it.",
        code: "bank_verify_misconfigured",
      },
    };
  }

  // Decentro v2 /core_banking returns fields at the top level (no `data` envelope),
  // but the older mocked shape nests them under `data`. Flatten both like primary
  // does at bank-verification.ts:135-136 so accountStatus / beneficiaryName resolve
  // regardless of which shape we get.
  const nested = (decentroRes.data || null) as Record<string, unknown> | null;
  const flat: Record<string, unknown> = { ...decentroRes, ...(nested || {}) };
  const accountStatus = String(
    (flat.accountStatus as string) || (flat.status as string) || "",
  ).toUpperCase();
  const beneficiaryName = String(
    (flat.beneficiaryName as string) || (flat.accountHolderName as string) || "",
  );
  const bankReferenceNumber =
    (flat.bankReferenceNumber as string | undefined) ||
    (flat.bank_reference_number as string | undefined) ||
    null;

  const nameMatch = cb.full_name && beneficiaryName
    ? nameSimilarity(beneficiaryName, cb.full_name)
    : null;
  const overallSuccess = accountStatus === "SUCCESS" || accountStatus === "VALID";

  const verificationId = await upsertCoBorrowerVerification(leadId, "bank", {
    status: overallSuccess ? "success" : "failed",
    api_request: {
      account_number: input.account_number,
      ifsc: input.ifsc,
      perform_name_match: input.perform_name_match,
      validation_type: input.validation_type,
    },
    api_response: {
      ...decentroRes,
      data: {
        beneficiaryName,
        accountStatus,
        bankReferenceNumber,
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
      : `Bank verification failed${accountStatus ? `: ${accountStatus}` : ""}`,
    data: {
      verificationId,
      beneficiaryName,
      accountStatus,
      bankReferenceNumber,
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
  // Caller must pass a validated redirect_url. The route handler runs it
  // through publicOrigin() which rejects unsafe hosts (localhost, ngrok,
  // .local) in production — this used to fall back to a raw
  // process.env.NEXT_PUBLIC_APP_URL which on sandbox was set to
  // http://localhost:3003 and caused Decentro to redirect customers to a
  // host their browsers couldn't reach.
  if (!input.redirect_url) {
    return {
      success: false,
      status: 500,
      error:
        "redirect_url is required (caller must resolve it via publicOrigin to ensure a safe public host)",
    };
  }
  const decentroRes = await digilockerInitiateSession({
    reference_id,
    redirect_url: input.redirect_url,
    consent_purpose: "Co-borrower KYC Aadhaar verification",
    notification_channel: "sms",
    mobile_number: phone,
    email: input.email,
  });

  // Decentro's /v2/kyc/digilocker/initiate_session returns the auth URL under
  // `data.authorizationUrl` (camelCase) — see how the primary handler extracts
  // it at src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts:165.
  // The previous co-borrower extraction read `data.digilockerUrl`, which Decentro
  // never returns, so digilocker_url was always null and the URL panel never
  // rendered. Mirror primary's priority chain.
  const resData = (decentroRes?.data as Record<string, unknown> | undefined) || {};
  const sessionId =
    (resData.session_id as string | undefined) ||
    (resData.sessionId as string | undefined) ||
    (decentroRes?.sessionId as string | undefined) ||
    null;
  const digilocker_url =
    (resData.authorizationUrl as string | undefined) ||
    (resData.authorization_url as string | undefined) ||
    (resData.digilocker_url as string | undefined) ||
    (resData.url as string | undefined) ||
    null;

  // If Decentro didn't actually generate a URL, surface the failure rather than
  // storing a useless in_progress row that the UI can't act on.
  const apiSuccess =
    (decentroRes?.status === "SUCCESS" ||
      decentroRes?.responseStatus === "SUCCESS" ||
      decentroRes?.api_status === "Success") &&
    !!digilocker_url;
  if (!apiSuccess) {
    return {
      success: false,
      status: 502,
      error:
        (decentroRes?.message as string | undefined) ||
        "Failed to initiate DigiLocker session for co-borrower",
    };
  }

  // Decentro sends the DigiLocker SMS itself when notification_channel='sms'.
  // We don't get back a per-channel ack on co-borrower today, so optimistically
  // mark sms as delivered (matches what the primary path does when its own SMS
  // send succeeds). The resend-sms endpoint will overwrite these on retry.
  const now = new Date();
  const initData: Record<string, unknown> = {
    sessionId,
    digilocker_url,
    reference_id,
    sms_attempts: 1,
    sms_delivered_at: now.toISOString(),
    sms_failed_reason: null,
  };

  const verificationId = await upsertCoBorrowerVerification(leadId, "aadhaar", {
    status: "in_progress",
    api_request: { reference_id, phone },
    api_response: {
      ...decentroRes,
      data: initData,
    },
    failed_reason: null,
  });

  // Mirror primary's response shape (src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts:329-345)
  // so AadhaarCard.tsx:handleInitiate (which reads camelCase keys) populates
  // digilockerUrl + smsStatus + smsAttempts after a fresh init on the
  // co-borrower side too. snake_case keys are kept for any consumer that
  // already speaks them.
  return {
    success: true,
    message: "DigiLocker session initiated for co-borrower.",
    data: {
      verificationId,
      transactionId: verificationId,
      sessionId,
      digilockerUrl: digilocker_url,
      digilocker_url,
      reference_id,
      linkSent: true,
      smsStatus: "delivered" as const,
      smsStatusMessage: null,
      smsAttempts: 1,
      sentTo: { mobile: phone },
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
