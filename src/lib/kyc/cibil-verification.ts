/**
 * Shared CIBIL / credit-bureau execution helpers.
 *
 * Extracted verbatim from the four admin CIBIL routes
 * (`api/admin/kyc/[leadId]/cibil/{score,report}` and their `coborrower/`
 * siblings) so the NBFC Acquire workspace can re-run the exact same
 * verification and produce the exact same `kyc_verifications` row + response
 * shape that `CIBILCard.tsx` already speaks.
 *
 * The `applicant` option selects the data source: `"primary"` reads
 * `leads` + `personalDetails`; `"co_borrower"` reads `coBorrowers`. The
 * persisted row is tagged with the matching `applicant` value.
 *
 * IMPORTANT: these helpers deliberately do NOT touch
 * `kycVerificationMetadata` — the coupon / first-API-execution stamp is a
 * caller (admin-only) concern and lives in the admin route handlers.
 */
import { and, desc, eq, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  coBorrowers,
  kycVerifications,
  leads,
  personalDetails,
} from "@/lib/db/schema";
import { interpretCibilScore } from "@/lib/kyc/cibil-interpreter";
import { getCreditBureauProvider } from "@/lib/credit-bureau";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";

export type CibilApplicant = "primary" | "co_borrower";

export type CibilVerificationResult = {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { message: string; suggestion?: string | null; code?: string };
  // Set only for early-return failures (validation / not-found / thrown error)
  // that the admin routes returned with a non-200 status. When undefined the
  // provider actually ran (HTTP 200, regardless of success).
  status?: number;
};

// Resolve the bureau input for the given applicant. Returns either the input
// fields or an early-return result to surface as the HTTP response.
async function resolveScoreInput(
  leadId: string,
  applicant: CibilApplicant,
): Promise<
  | { ok: true; name: string; pan: string; dob: string; phone: string; address: string }
  | { ok: false; result: CibilVerificationResult }
> {
  if (applicant === "co_borrower") {
    const cbRows = await db
      .select()
      .from(coBorrowers)
      .where(eq(coBorrowers.lead_id, leadId))
      .limit(1);
    const cb = cbRows[0];
    if (!cb) {
      return {
        ok: false,
        result: {
          success: false,
          error: { message: "Co-borrower not found" },
          status: 404,
        },
      };
    }

    const name = cb.full_name || "";
    const phone = cb.phone || "";
    if (!name || !phone) {
      return {
        ok: false,
        result: {
          success: false,
          error: {
            message:
              "Co-borrower name and phone number are required for credit score",
          },
          status: 400,
        },
      };
    }

    const dob = cb.dob ? new Date(cb.dob).toISOString().slice(0, 10) : "";
    const address = cb.address || cb.current_address || "";
    return { ok: true, name, pan: cb.pan_no || "", dob, phone, address };
  }

  const [leadRows, personalRows] = await Promise.all([
    db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
    db
      .select()
      .from(personalDetails)
      .where(eq(personalDetails.lead_id, leadId))
      .limit(1),
  ]);

  const lead = leadRows[0];
  if (!lead) {
    return {
      ok: false,
      result: {
        success: false,
        error: { message: "Lead not found" },
        status: 404,
      },
    };
  }

  const personal = personalRows[0];
  const name = lead.full_name || lead.owner_name || "";
  const phone = lead.phone || lead.mobile || lead.owner_contact || "";
  if (!name || !phone) {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          message: "Name and phone number are required for credit score",
        },
        status: 400,
      },
    };
  }

  const dob = personal?.dob
    ? new Date(personal.dob).toISOString().slice(0, 10)
    : lead.dob
      ? new Date(lead.dob).toISOString().slice(0, 10)
      : "";
  const address =
    personal?.local_address || lead.local_address || lead.current_address || "";
  return { ok: true, name, pan: personal?.pan_no || "", dob, phone, address };
}

// Find the existing shared kyc_verifications row to update (applicant-scoped).
async function findExistingCibilRow(leadId: string, applicant: CibilApplicant) {
  if (applicant === "co_borrower") {
    return db
      .select({ id: kycVerifications.id })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "cibil"),
          eq(kycVerifications.applicant, "co_borrower"),
        ),
      )
      .orderBy(desc(kycVerifications.created_at))
      .limit(1);
  }

  // Primary: match applicant='primary' OR legacy NULL so a co_borrower row is
  // never hijacked by the primary run.
  return db
    .select({ id: kycVerifications.id })
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.lead_id, leadId),
        eq(kycVerifications.verification_type, "cibil"),
        or(
          eq(kycVerifications.applicant, "primary"),
          isNull(kycVerifications.applicant),
        ),
      ),
    )
    .limit(1);
}

/**
 * Fetch the applicant's CIBIL score, persist the shared kyc_verifications row,
 * and return the exact shape the admin score route returns.
 */
export async function executeCibilScore(
  leadId: string,
  opts: { applicant?: CibilApplicant } = {},
): Promise<CibilVerificationResult> {
  const applicant = opts.applicant ?? "primary";
  const logLabel =
    applicant === "co_borrower" ? "[Co-Borrower CIBIL Score]" : "[CIBIL Score]";

  try {
    const input = await resolveScoreInput(leadId, applicant);
    if (!input.ok) return input.result;

    const { name, pan, dob, phone, address } = input;

    // Provider-routed (BRD Addendum §4.3). Passing null lands on
    // DEFAULT_PLATFORM_BUREAU, currently 'cibil' (the working provider) until
    // the Equifax stub is provisioned.
    const result = await getCreditBureauProvider(null).fetchScore({
      name,
      pan,
      dob,
      phone,
      address,
    });
    const decentroRes = result.raw as Record<string, any> | null;

    console.log(`${logLabel} Response:`, JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = (decentroRes?.data as Record<string, any>) || {};
    const score = result.score;
    const overallSuccess = result.error === null && score !== null;

    const interpretation =
      score !== null && !isNaN(score) ? interpretCibilScore(score) : null;

    const existingRows = await findExistingCibilRow(leadId, applicant);

    const verificationId = existingRows[0]?.id || createWorkflowId("KYCVER", now);

    const apiRequest = { name, pan, dob, phone, address };

    const existingData =
      (decentroRes as Record<string, unknown>)?.data &&
      typeof (decentroRes as Record<string, unknown>).data === "object"
        ? ((decentroRes as Record<string, unknown>).data as Record<string, unknown>)
        : {};
    const apiResponseEnriched = {
      ...(decentroRes as Record<string, unknown>),
      data: {
        ...existingData,
        interpretation,
        reportId: decentroRes?.decentroTxnId || responseData.report_id || null,
        generatedAt: now.toISOString(),
      },
    };

    if (existingRows.length > 0) {
      await db
        .update(kycVerifications)
        .set({
          status: overallSuccess ? "success" : "failed",
          api_provider: "decentro",
          api_request: apiRequest,
          api_response: apiResponseEnriched,
          failed_reason: overallSuccess
            ? null
            : decentroRes?.message || "CIBIL score fetch failed",
          match_score: score ? String(score) : null,
          completed_at: now,
          updated_at: now,
        })
        .where(eq(kycVerifications.id, verificationId));
    } else {
      await db.insert(kycVerifications).values({
        id: verificationId,
        lead_id: leadId,
        verification_type: "cibil",
        applicant,
        status: overallSuccess ? "success" : "failed",
        api_provider: "decentro",
        api_request: apiRequest,
        api_response: apiResponseEnriched,
        failed_reason: overallSuccess
          ? null
          : decentroRes?.message || "CIBIL score fetch failed",
        match_score: score ? String(score) : null,
        submitted_at: now,
        completed_at: now,
      });
    }

    return {
      success: overallSuccess,
      data: {
        verificationId,
        score,
        interpretation,
        reportId: decentroRes?.decentroTxnId || responseData.report_id || null,
        generatedAt: now.toISOString(),
        rawResponse: decentroRes,
      },
      ...(result.error
        ? {
            error: {
              message: result.error.message,
              suggestion: result.error.suggestion,
              code: result.error.category,
            },
          }
        : {}),
    };
  } catch (error) {
    console.error(`${logLabel} Error:`, error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch CIBIL score";
    return { success: false, error: { message }, status: 500 };
  }
}

/**
 * Fetch the applicant's full CIBIL report, persist the shared
 * kyc_verifications row, and return the exact shape the admin report route
 * returns (including the computed summary + consumer-not-found handling).
 */
export async function executeCibilReport(
  leadId: string,
  opts: { applicant?: CibilApplicant } = {},
): Promise<CibilVerificationResult> {
  const applicant = opts.applicant ?? "primary";
  const logLabel =
    applicant === "co_borrower"
      ? "[Co-Borrower CIBIL Report]"
      : "[CIBIL Report]";

  try {
    // Resolve inputs (report requires PAN specifically).
    let name: string;
    let pan: string;
    let dob: string;
    let phone: string;
    let address: string;

    if (applicant === "co_borrower") {
      const cbRows = await db
        .select()
        .from(coBorrowers)
        .where(eq(coBorrowers.lead_id, leadId))
        .limit(1);
      const cb = cbRows[0];
      if (!cb) {
        return {
          success: false,
          error: { message: "Co-borrower not found" },
          status: 404,
        };
      }
      if (!cb.pan_no) {
        return {
          success: false,
          error: { message: "Co-borrower PAN is required for CIBIL report" },
          status: 400,
        };
      }
      name = cb.full_name || "";
      dob = cb.dob ? new Date(cb.dob).toISOString().slice(0, 10) : "";
      phone = cb.phone || "";
      address = cb.address || cb.current_address || "";
      pan = cb.pan_no;
    } else {
      const [leadRows, personalRows] = await Promise.all([
        db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
        db
          .select()
          .from(personalDetails)
          .where(eq(personalDetails.lead_id, leadId))
          .limit(1),
      ]);

      const lead = leadRows[0];
      if (!lead) {
        return {
          success: false,
          error: { message: "Lead not found" },
          status: 404,
        };
      }

      const personal = personalRows[0];
      if (!personal?.pan_no) {
        return {
          success: false,
          error: { message: "PAN number is required for CIBIL report" },
          status: 400,
        };
      }

      name = lead.full_name || lead.owner_name || "";
      dob = personal.dob
        ? new Date(personal.dob).toISOString().slice(0, 10)
        : lead.dob
          ? new Date(lead.dob).toISOString().slice(0, 10)
          : "";
      phone = lead.phone || lead.mobile || lead.owner_contact || "";
      address =
        personal.local_address ||
        lead.local_address ||
        lead.current_address ||
        "";
      pan = personal.pan_no;
    }

    // Extract 6-digit Indian pincode — Decentro CIBIL needs it for bureau match.
    const pincode = address.match(/\b\d{6}\b/)?.[0] || "";

    // Provider-routed (BRD Addendum §4.3). Null → DEFAULT_PLATFORM_BUREAU.
    const result = await getCreditBureauProvider(null).fetchReport({
      name,
      pan,
      dob,
      phone,
      address,
      pincode,
      address_type: "H",
    });
    const decentroRes = result.raw as Record<string, any> | null;

    console.log(`${logLabel} Response:`, JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = (decentroRes?.data as Record<string, any>) || {};

    // Consumer-not-found is a bureau-level result, not an API failure.
    const consumerNotFound = result.error?.category === "consumer_not_found";

    const reportDataLst = responseData.cCRResponse?.cIRReportDataLst;
    const bureauError =
      Array.isArray(reportDataLst) && reportDataLst[0]?.error
        ? reportDataLst[0].error
        : null;
    const reportData =
      (Array.isArray(reportDataLst) &&
        !bureauError &&
        reportDataLst[0]?.cIRReportData) ||
      responseData.cCRResponse?.cIRReportData ||
      responseData.cCRResponse ||
      responseData;

    const score = result.score;
    const overallSuccess = result.error === null && score !== null;
    const interpretation =
      score !== null && !isNaN(score) ? interpretCibilScore(score) : null;

    const idContact = reportData.iDAndContactInfo || {};
    const personalInfo =
      idContact.personalInfo ||
      reportData.personalInfo ||
      responseData.personalInfo ||
      {};
    const identityInfo =
      idContact.identityInfo ||
      reportData.identityInfo ||
      responseData.identityInfo ||
      {};
    const retailSummary =
      reportData.retailAccountsSummary ||
      reportData.accountSummary ||
      responseData.accountSummary ||
      {};
    const recentActivities = reportData.recentActivities || {};
    const enquirySummary =
      reportData.enquirySummary || responseData.enquirySummary || {};
    const otherKeyInd = reportData.otherKeyInd || {};

    const fullName =
      personalInfo.name?.fullName?.trim() ||
      personalInfo.fullName?.trim() ||
      null;
    const reportedDob = personalInfo.dateOfBirth || personalInfo.dob || null;

    const panFromV2 = Array.isArray(identityInfo.pANId)
      ? identityInfo.pANId[0]?.idNumber
      : null;
    const panFromOld = Array.isArray(identityInfo.panNumber)
      ? identityInfo.panNumber[0]?.idNumber
      : null;

    const totalBalance = Number(retailSummary.totalBalanceAmount ?? NaN);
    const totalLimit = Number(retailSummary.totalCreditLimit ?? NaN);
    const totalSanctioned = Number(retailSummary.totalSanctionAmount ?? NaN);
    let creditUtilization: string | null = null;
    if (!isNaN(totalBalance) && !isNaN(totalLimit) && totalLimit > 0) {
      creditUtilization = `${Math.round((totalBalance / totalLimit) * 100)}%`;
    } else if (
      !isNaN(totalBalance) &&
      !isNaN(totalSanctioned) &&
      totalSanctioned > 0
    ) {
      creditUtilization = `${Math.round((totalBalance / totalSanctioned) * 100)}%`;
    } else if (retailSummary.creditUtilization !== undefined) {
      creditUtilization = String(retailSummary.creditUtilization);
    }

    let oldestAccountAge: string | null = null;
    const ageMonthsRaw =
      otherKeyInd.ageOfOldestTrade ?? retailSummary.oldestAccountAge;
    if (
      ageMonthsRaw !== undefined &&
      ageMonthsRaw !== null &&
      String(ageMonthsRaw).trim() !== ""
    ) {
      const months = Number(ageMonthsRaw);
      if (!isNaN(months) && months > 0) {
        const y = Math.floor(months / 12);
        const m = months % 12;
        oldestAccountAge = y > 0 ? (m > 0 ? `${y}y ${m}m` : `${y}y`) : `${m}m`;
      } else {
        oldestAccountAge = String(ageMonthsRaw);
      }
    }

    const totalAccounts = retailSummary.noOfAccounts;
    const activeAccounts = retailSummary.noOfActiveAccounts;
    let creditMix: string | null = retailSummary.creditMix ?? null;
    if (!creditMix && totalAccounts !== undefined && activeAccounts !== undefined) {
      creditMix = `${totalAccounts} total · ${activeAccounts} active`;
    }

    const formatAmount = (v: unknown): string | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      if (isNaN(n)) return String(v);
      return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
    };

    const summary = {
      fullName,
      dob: reportedDob,
      gender: personalInfo.gender || null,
      totalIncome: personalInfo.totalIncome || null,
      occupation: personalInfo.occupation || null,
      panNumber: panFromV2 || panFromOld || responseData.document_id || null,
      addresses:
        idContact.addressInfo ||
        reportData.addressInfo ||
        responseData.addressInfo ||
        [],
      phones:
        idContact.phoneInfo ||
        reportData.phoneInfo ||
        responseData.phoneInfo ||
        [],
      emails:
        idContact.emailAddressInfo ||
        reportData.emailInfo ||
        responseData.emailInfo ||
        [],
      activeLoans:
        retailSummary.noOfActiveAccounts ??
        retailSummary.activeAccounts ??
        responseData.active_loans ??
        null,
      totalOutstanding: formatAmount(
        retailSummary.totalBalanceAmount ??
          retailSummary.totalOutstanding ??
          responseData.total_outstanding,
      ),
      creditUtilization,
      paymentDefaults:
        retailSummary.noOfPastDueAccounts ??
        retailSummary.overdueAccounts ??
        responseData.payment_defaults ??
        null,
      recentEnquiries:
        recentActivities.totalInquiries ??
        enquirySummary.last30Days ??
        enquirySummary.numberOfEnquiries ??
        responseData.recent_enquiries ??
        null,
      oldestAccountAge,
      creditMix,
      accounts:
        reportData.retailAccountDetails ||
        responseData.accounts ||
        responseData.accountDetails ||
        [],
      enquiries:
        reportData.enquiryDetails ||
        responseData.enquiries ||
        responseData.enquiryDetails ||
        [],
    };

    const existingRows = await findExistingCibilRow(leadId, applicant);

    const verificationId = existingRows[0]?.id || createWorkflowId("KYCVER", now);

    const dbStatus = overallSuccess
      ? "success"
      : consumerNotFound
        ? "success"
        : "failed";
    const failedReason = overallSuccess
      ? null
      : consumerNotFound
        ? "Consumer not found in credit bureau — no credit history"
        : decentroRes?.message || "CIBIL report fetch failed";

    const apiRequest = {
      name,
      pan,
      dob,
      phone,
      address,
      pincode,
      address_type: "H",
      report_type: "full_report",
    };

    const existingData =
      (decentroRes as Record<string, unknown>)?.data &&
      typeof (decentroRes as Record<string, unknown>).data === "object"
        ? ((decentroRes as Record<string, unknown>).data as Record<string, unknown>)
        : {};
    const apiResponseEnriched = {
      ...(decentroRes as Record<string, unknown>),
      data: {
        ...existingData,
        summary: overallSuccess ? summary : null,
        interpretation,
        reportId: decentroRes?.decentroTxnId || responseData.report_id || null,
        generatedAt: now.toISOString(),
        consumerNotFound,
      },
    };

    if (existingRows.length > 0) {
      await db
        .update(kycVerifications)
        .set({
          status: dbStatus,
          api_provider: "decentro",
          api_request: apiRequest,
          api_response: apiResponseEnriched,
          failed_reason: failedReason,
          match_score: score ? String(score) : null,
          completed_at: now,
          updated_at: now,
        })
        .where(eq(kycVerifications.id, verificationId));
    } else {
      await db.insert(kycVerifications).values({
        id: verificationId,
        lead_id: leadId,
        verification_type: "cibil",
        applicant,
        status: dbStatus,
        api_provider: "decentro",
        api_request: apiRequest,
        api_response: apiResponseEnriched,
        failed_reason: failedReason,
        match_score: score ? String(score) : null,
        submitted_at: now,
        completed_at: now,
      });
    }

    return {
      success: overallSuccess || consumerNotFound,
      data: {
        verificationId,
        score,
        interpretation,
        summary: overallSuccess ? summary : null,
        consumerNotFound,
        bureauError: bureauError?.errorDesc || null,
        reportOrderNumber: responseData.reportOrderNumber || null,
        reportId: decentroRes?.decentroTxnId || responseData.report_id || null,
        generatedAt: now.toISOString(),
        rawResponse: decentroRes,
      },
      ...(result.error && !consumerNotFound
        ? {
            error: {
              message: result.error.message,
              suggestion: result.error.suggestion,
              code: result.error.category,
            },
          }
        : {}),
    };
  } catch (error) {
    console.error(`${logLabel} Error:`, error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch CIBIL report";
    return { success: false, error: { message }, status: 500 };
  }
}
