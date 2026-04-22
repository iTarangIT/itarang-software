import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  kycVerificationMetadata,
  kycVerifications,
  personalDetails,
} from "@/lib/db/schema";
import { fetchCibilReport } from "@/lib/decentro";
import { interpretCibilScore } from "@/lib/kyc/cibil-interpreter";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

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

    const [leadRows, personalRows] = await Promise.all([
      db
        .select()
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1),
      db
        .select()
        .from(personalDetails)
        .where(eq(personalDetails.lead_id, leadId))
        .limit(1),
    ]);

    const lead = leadRows[0];
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const personal = personalRows[0];
    if (!personal?.pan_no) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "PAN number is required for CIBIL report" },
        },
        { status: 400 },
      );
    }

    const name = lead.full_name || lead.owner_name || "";
    const dob = personal.dob
      ? new Date(personal.dob).toISOString().slice(0, 10)
      : (lead.dob ? new Date(lead.dob).toISOString().slice(0, 10) : "");
    const phone = lead.phone || lead.mobile || lead.owner_contact || "";
    const address = personal.local_address || lead.local_address || lead.current_address || "";
    // Extract 6-digit Indian pincode — Decentro CIBIL needs it for bureau match.
    const pincode = address.match(/\b\d{6}\b/)?.[0] || "";

    const decentroRes = await fetchCibilReport({
      name,
      pan: personal.pan_no,
      dob,
      phone,
      address,
      pincode,
      address_type: "H",
    });

    console.log("[CIBIL Report] Response:", JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = decentroRes?.data || {};

    // /v2/financial_services/credit_bureau/credit_report/summary
    const responseKey = decentroRes?.responseKey || "";
    const isErrorResponse = responseKey.startsWith("error_");
    const apiCallSucceeded =
      !isErrorResponse &&
      (responseKey === "success_credit_report" ||
       responseKey === "success" ||
       decentroRes?.status === "SUCCESS");

    // Check for bureau-level "Consumer not found" error inside cIRReportDataLst
    const reportDataLst = responseData.cCRResponse?.cIRReportDataLst;
    const bureauError =
      Array.isArray(reportDataLst) && reportDataLst[0]?.error
        ? reportDataLst[0].error
        : null;
    const consumerNotFound = bureauError?.errorDesc === "Consumer not found in bureau";

    // The actual report data may be in cIRReportDataLst[0].cIRReportData or at cCRResponse level
    const reportData =
      (Array.isArray(reportDataLst) && !bureauError && reportDataLst[0]?.cIRReportData) ||
      responseData.cCRResponse?.cIRReportData ||
      responseData.cCRResponse ||
      responseData;

    // Extract score — credit report summary may return score in various locations
    const scoreDetails =
      reportData.scoreDetails ||
      responseData.scoreDetails;
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

    // Build summary from credit report summary response.
    //
    // Decentro's actual V2 shape (confirmed from prod response 20-Apr-2026):
    //   reportData.iDAndContactInfo.personalInfo.{name,dateOfBirth,gender}
    //   reportData.iDAndContactInfo.identityInfo.pANId[]
    //   reportData.iDAndContactInfo.{addressInfo,phoneInfo,emailAddressInfo}
    //   reportData.retailAccountsSummary.{noOfActiveAccounts,totalBalanceAmount,...}
    //   reportData.recentActivities.totalInquiries
    //   reportData.otherKeyInd.ageOfOldestTrade (in months)
    //
    // We keep the old field names as fallbacks so older/alternate Decentro
    // responses still work if they change shape again.
    const idContact = reportData.iDAndContactInfo || {};
    const personalInfo = idContact.personalInfo || reportData.personalInfo || responseData.personalInfo || {};
    const identityInfo = idContact.identityInfo || reportData.identityInfo || responseData.identityInfo || {};
    const retailSummary = reportData.retailAccountsSummary || reportData.accountSummary || responseData.accountSummary || {};
    const recentActivities = reportData.recentActivities || {};
    const enquirySummary = reportData.enquirySummary || responseData.enquirySummary || {};
    const otherKeyInd = reportData.otherKeyInd || {};

    // Name may be nested under personalInfo.name.fullName OR flat .fullName
    const fullName = personalInfo.name?.fullName?.trim() || personalInfo.fullName?.trim() || null;
    const reportedDob = personalInfo.dateOfBirth || personalInfo.dob || null;

    // PAN may be under identityInfo.pANId[] (Decentro v2) or identityInfo.panNumber[]
    const panFromV2 = Array.isArray(identityInfo.pANId) ? identityInfo.pANId[0]?.idNumber : null;
    const panFromOld = Array.isArray(identityInfo.panNumber) ? identityInfo.panNumber[0]?.idNumber : null;

    // Credit utilization — Decentro doesn't return a ready-to-display percentage,
    // but we can derive it when both total outstanding and total credit limit
    // are present (this reflects how heavily the customer is using their
    // revolving/credit limits). Returns null if either is missing or zero.
    const totalBalance = Number(retailSummary.totalBalanceAmount ?? NaN);
    const totalLimit = Number(retailSummary.totalCreditLimit ?? NaN);
    const totalSanctioned = Number(retailSummary.totalSanctionAmount ?? NaN);
    let creditUtilization: string | null = null;
    if (!isNaN(totalBalance) && !isNaN(totalLimit) && totalLimit > 0) {
      creditUtilization = `${Math.round((totalBalance / totalLimit) * 100)}%`;
    } else if (!isNaN(totalBalance) && !isNaN(totalSanctioned) && totalSanctioned > 0) {
      // Fallback: ratio against total sanctioned amount across all credit lines
      creditUtilization = `${Math.round((totalBalance / totalSanctioned) * 100)}%`;
    } else if (retailSummary.creditUtilization !== undefined) {
      creditUtilization = String(retailSummary.creditUtilization);
    }

    // Oldest account age — Decentro returns months under otherKeyInd.ageOfOldestTrade.
    // Convert to a human-friendly "X years Y months" string.
    let oldestAccountAge: string | null = null;
    const ageMonthsRaw = otherKeyInd.ageOfOldestTrade ?? retailSummary.oldestAccountAge;
    if (ageMonthsRaw !== undefined && ageMonthsRaw !== null && String(ageMonthsRaw).trim() !== '') {
      const months = Number(ageMonthsRaw);
      if (!isNaN(months) && months > 0) {
        const y = Math.floor(months / 12);
        const m = months % 12;
        oldestAccountAge = y > 0 ? (m > 0 ? `${y}y ${m}m` : `${y}y`) : `${m}m`;
      } else {
        oldestAccountAge = String(ageMonthsRaw);
      }
    }

    // Credit mix — Decentro v2 doesn't surface a pre-computed mix label. Best we
    // can do is expose the "X accounts (Y active)" shape that reviewers can
    // interpret at a glance. Falls back to raw field if Decentro ever adds it.
    const totalAccounts = retailSummary.noOfAccounts;
    const activeAccounts = retailSummary.noOfActiveAccounts;
    let creditMix: string | null = retailSummary.creditMix ?? null;
    if (!creditMix && totalAccounts !== undefined && activeAccounts !== undefined) {
      creditMix = `${totalAccounts} total · ${activeAccounts} active`;
    }

    // Format large currency numbers as rupees with thousands separators.
    const formatAmount = (v: unknown): string | null => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (isNaN(n)) return String(v);
      return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
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

    // Upsert kycVerifications
    const existingRows = await db
      .select({ id: kycVerifications.id })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "cibil"),
        ),
      )
      .limit(1);

    const verificationId =
      existingRows[0]?.id || createWorkflowId("KYCVER", now);

    // DB status: "success" if we got a score, "failed" only if API call itself failed
    // Consumer not found is a valid result — store as "success" with no score
    const dbStatus = overallSuccess ? "success" : (consumerNotFound ? "success" : "failed");
    const failedReason = overallSuccess
      ? null
      : consumerNotFound
        ? "Consumer not found in credit bureau — no credit history"
        : decentroRes?.message || "CIBIL report fetch failed";

    const apiRequest = {
      name,
      pan: personal.pan_no,
      dob,
      phone,
      address,
      pincode,
      address_type: "H",
      report_type: "full_report",
    };

    // Enrich the raw Decentro response with the *computed* summary /
    // interpretation so CIBILCard can rehydrate the full report view after
    // a page refresh (it reads `apiResponse.data.summary`, etc.). Storing
    // only the raw Decentro response meant those fields existed in the POST
    // response body but disappeared on reload.
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

    // Record first API execution if not set
    const metadataRows = await db
      .select({
        first_api_execution_at: kycVerificationMetadata.first_api_execution_at,
      })
      .from(kycVerificationMetadata)
      .where(eq(kycVerificationMetadata.lead_id, leadId))
      .limit(1);

    if (metadataRows[0] && !metadataRows[0].first_api_execution_at) {
      await db
        .update(kycVerificationMetadata)
        .set({
          first_api_execution_at: now,
          first_api_type: "cibil",
          verification_started_at: now,
          updated_at: now,
        })
        .where(eq(kycVerificationMetadata.lead_id, leadId));
    }

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
      ...(overallSuccess || consumerNotFound
        ? {}
        : {
            error: {
              message:
                decentroRes?.message || "Failed to fetch CIBIL report",
            },
          }),
    });
  } catch (error) {
    console.error("[CIBIL Report] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to fetch CIBIL report";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
