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

    const decentroRes = await fetchCibilReport({
      name,
      pan: personal.pan_no,
      dob,
      phone,
      address,
    });

    console.log("[CIBIL Report] Response:", JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = decentroRes?.data || {};

    // /v2/financial_services/credit_bureau/credit_report/summary
    const overallSuccess =
      decentroRes?.responseKey === "success_credit_report" ||
      decentroRes?.status === "SUCCESS";

    // Extract score — credit report summary may return score in various locations
    const scoreDetails = responseData.scoreDetails || responseData.cCRResponse?.scoreDetails;
    const score =
      (Array.isArray(scoreDetails) && scoreDetails.length > 0 && scoreDetails[0]?.value) ||
      (responseData.creditScore?.score ?? responseData.credit_score ?? responseData.score ?? null);

    const interpretation = score ? interpretCibilScore(Number(score)) : null;

    // Build summary from credit report summary response
    const personalInfo = responseData.personalInfo || {};
    const accountSummary = responseData.accountSummary || {};
    const enquirySummary = responseData.enquirySummary || {};
    const summary = {
      fullName: personalInfo.fullName || null,
      dob: personalInfo.dob || null,
      gender: personalInfo.gender || null,
      totalIncome: personalInfo.totalIncome || null,
      occupation: personalInfo.occupation || null,
      panNumber: responseData.identityInfo?.panNumber?.[0]?.idNumber || responseData.document_id || null,
      addresses: responseData.addressInfo || [],
      phones: responseData.phoneInfo || [],
      emails: responseData.emailInfo || [],
      activeLoans: accountSummary.activeAccounts ?? responseData.active_loans ?? null,
      totalOutstanding: accountSummary.totalOutstanding ?? responseData.total_outstanding ?? null,
      creditUtilization: accountSummary.creditUtilization ?? responseData.credit_utilization ?? null,
      paymentDefaults: accountSummary.overdueAccounts ?? responseData.payment_defaults ?? null,
      recentEnquiries: enquirySummary.last30Days ?? responseData.recent_enquiries ?? null,
      oldestAccountAge: accountSummary.oldestAccountAge ?? responseData.oldest_account_age ?? null,
      creditMix: accountSummary.creditMix ?? responseData.credit_mix ?? null,
      accounts: responseData.accounts || responseData.accountDetails || [],
      enquiries: responseData.enquiries || responseData.enquiryDetails || [],
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

    if (existingRows.length > 0) {
      await db
        .update(kycVerifications)
        .set({
          status: overallSuccess ? "success" : "failed",
          api_provider: "decentro",
          api_request: {
            name,
            pan: personal.pan_no,
            dob,
            phone,
            address,
            report_type: "full_report",
          },
          api_response: decentroRes,
          failed_reason: overallSuccess
            ? null
            : decentroRes?.message || "CIBIL report fetch failed",
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
        status: overallSuccess ? "success" : "failed",
        api_provider: "decentro",
        api_request: {
          name,
          pan: personal.pan_no,
          dob,
          phone,
          address,
          report_type: "full_report",
        },
        api_response: decentroRes,
        failed_reason: overallSuccess
          ? null
          : decentroRes?.message || "CIBIL report fetch failed",
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
      success: overallSuccess,
      data: {
        verificationId,
        score: score ? Number(score) : null,
        interpretation,
        summary,
        reportId: responseData.report_id || null,
        generatedAt: now.toISOString(),
        rawResponse: decentroRes,
      },
      ...(overallSuccess
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
