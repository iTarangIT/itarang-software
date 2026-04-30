import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { coBorrowers, kycVerifications } from "@/lib/db/schema";
import { fetchCibilReport } from "@/lib/decentro";
import { interpretCibilScore } from "@/lib/kyc/cibil-interpreter";
import { humanizeCibilError } from "@/lib/kyc/cibil-friendly-errors";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

// Mirrors the primary CIBIL report route at
// src/app/api/admin/kyc/[leadId]/cibil/report/route.ts but sources data from
// the coBorrowers row and persists with applicant='co_borrower'. Same Decentro
// endpoint, same response-shape contract that CIBILCard.tsx already speaks.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;

    const cbRows = await db
      .select()
      .from(coBorrowers)
      .where(eq(coBorrowers.lead_id, leadId))
      .limit(1);
    const cb = cbRows[0];
    if (!cb) {
      return NextResponse.json(
        { success: false, error: { message: "Co-borrower not found" } },
        { status: 404 },
      );
    }

    if (!cb.pan_no) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Co-borrower PAN is required for CIBIL report" },
        },
        { status: 400 },
      );
    }

    const name = cb.full_name || "";
    const dob = cb.dob ? new Date(cb.dob).toISOString().slice(0, 10) : "";
    const phone = cb.phone || "";
    const address = cb.address || cb.current_address || "";
    const pincode = address.match(/\b\d{6}\b/)?.[0] || "";

    const decentroRes = await fetchCibilReport({
      name,
      pan: cb.pan_no,
      dob,
      phone,
      address,
      pincode,
      address_type: "H",
    });

    console.log("[Co-Borrower CIBIL Report] Response:", JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = decentroRes?.data || {};

    const responseKey = decentroRes?.responseKey || "";
    const isErrorResponse = responseKey.startsWith("error_");
    const apiCallSucceeded =
      !isErrorResponse &&
      (responseKey === "success_credit_report" ||
        responseKey === "success" ||
        decentroRes?.status === "SUCCESS");

    const reportDataLst = responseData.cCRResponse?.cIRReportDataLst;
    const bureauError =
      Array.isArray(reportDataLst) && reportDataLst[0]?.error
        ? reportDataLst[0].error
        : null;
    const consumerNotFound = bureauError?.errorDesc === "Consumer not found in bureau";

    const reportData =
      (Array.isArray(reportDataLst) && !bureauError && reportDataLst[0]?.cIRReportData) ||
      responseData.cCRResponse?.cIRReportData ||
      responseData.cCRResponse ||
      responseData;

    const scoreDetails = reportData.scoreDetails || responseData.scoreDetails;
    const rawScore =
      (Array.isArray(scoreDetails) && scoreDetails.length > 0
        ? scoreDetails[0]?.value
        : null) ||
      reportData.creditScore?.score ||
      responseData.creditScore?.score ||
      responseData.credit_score ||
      responseData.score ||
      null;
    const score = rawScore !== null && rawScore !== undefined ? Number(rawScore) : null;

    const overallSuccess = apiCallSucceeded && !consumerNotFound && score !== null && !isNaN(score);
    const interpretation = score !== null && !isNaN(score) ? interpretCibilScore(score) : null;

    const idContact = reportData.iDAndContactInfo || {};
    const personalInfo = idContact.personalInfo || reportData.personalInfo || responseData.personalInfo || {};
    const identityInfo = idContact.identityInfo || reportData.identityInfo || responseData.identityInfo || {};
    const retailSummary = reportData.retailAccountsSummary || reportData.accountSummary || responseData.accountSummary || {};
    const recentActivities = reportData.recentActivities || {};
    const enquirySummary = reportData.enquirySummary || responseData.enquirySummary || {};
    const otherKeyInd = reportData.otherKeyInd || {};

    const fullName = personalInfo.name?.fullName?.trim() || personalInfo.fullName?.trim() || null;
    const reportedDob = personalInfo.dateOfBirth || personalInfo.dob || null;

    const panFromV2 = Array.isArray(identityInfo.pANId) ? identityInfo.pANId[0]?.idNumber : null;
    const panFromOld = Array.isArray(identityInfo.panNumber) ? identityInfo.panNumber[0]?.idNumber : null;

    const totalBalance = Number(retailSummary.totalBalanceAmount ?? NaN);
    const totalLimit = Number(retailSummary.totalCreditLimit ?? NaN);
    const totalSanctioned = Number(retailSummary.totalSanctionAmount ?? NaN);
    let creditUtilization: string | null = null;
    if (!isNaN(totalBalance) && !isNaN(totalLimit) && totalLimit > 0) {
      creditUtilization = `${Math.round((totalBalance / totalLimit) * 100)}%`;
    } else if (!isNaN(totalBalance) && !isNaN(totalSanctioned) && totalSanctioned > 0) {
      creditUtilization = `${Math.round((totalBalance / totalSanctioned) * 100)}%`;
    } else if (retailSummary.creditUtilization !== undefined) {
      creditUtilization = String(retailSummary.creditUtilization);
    }

    let oldestAccountAge: string | null = null;
    const ageMonthsRaw = otherKeyInd.ageOfOldestTrade ?? retailSummary.oldestAccountAge;
    if (ageMonthsRaw !== undefined && ageMonthsRaw !== null && String(ageMonthsRaw).trim() !== "") {
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
      addresses: idContact.addressInfo || reportData.addressInfo || responseData.addressInfo || [],
      phones: idContact.phoneInfo || reportData.phoneInfo || responseData.phoneInfo || [],
      emails: idContact.emailAddressInfo || reportData.emailInfo || responseData.emailInfo || [],
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
      accounts: reportData.retailAccountDetails || responseData.accounts || responseData.accountDetails || [],
      enquiries: reportData.enquiryDetails || responseData.enquiries || responseData.enquiryDetails || [],
    };

    const existingRows = await db
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

    const verificationId =
      existingRows[0]?.id || createWorkflowId("KYCVER", now);

    const dbStatus = overallSuccess ? "success" : (consumerNotFound ? "success" : "failed");
    const failedReason = overallSuccess
      ? null
      : consumerNotFound
        ? "Consumer not found in credit bureau — no credit history"
        : decentroRes?.message || "CIBIL report fetch failed";

    const apiRequest = {
      name,
      pan: cb.pan_no,
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
        applicant: "co_borrower",
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

    const friendly =
      overallSuccess || consumerNotFound
        ? null
        : humanizeCibilError({
            endpoint: "report",
            responseKey,
            rawMessage: decentroRes?.message ?? null,
            bureauErrorDesc: bureauError?.errorDesc ?? null,
          });

    return NextResponse.json({
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
      ...(friendly
        ? {
            error: {
              message: friendly.message,
              suggestion: friendly.suggestion,
              code: friendly.code,
            },
          }
        : {}),
    });
  } catch (error) {
    console.error("[Co-Borrower CIBIL Report] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch CIBIL report";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
