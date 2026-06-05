import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  kycVerificationMetadata,
  kycVerifications,
  personalDetails,
} from "@/lib/db/schema";
import { interpretCibilScore } from "@/lib/kyc/cibil-interpreter";
import { getCreditBureauProvider } from "@/lib/credit-bureau";
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

    // Fetch lead and personal details
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

    const name = lead.full_name || lead.owner_name || "";
    const phone = lead.phone || lead.mobile || lead.owner_contact || "";

    if (!name || !phone) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Name and phone number are required for credit score" },
        },
        { status: 400 },
      );
    }

    const dob = personal?.dob
      ? new Date(personal.dob).toISOString().slice(0, 10)
      : (lead.dob ? new Date(lead.dob).toISOString().slice(0, 10) : "");
    const address = personal?.local_address || lead.local_address || lead.current_address || "";

    // Provider-routed (BRD Addendum §4.3). Passing null lands on
    // DEFAULT_PLATFORM_BUREAU, currently 'cibil' (the working provider) until
    // the Equifax stub is provisioned. KYC runs before Section G, so there is
    // no matched product to read credit_bureau from at this point; the
    // per-product column is reserved for future bureau policy and not consulted
    // here.
    const result = await getCreditBureauProvider(null).fetchScore({
      name,
      pan: personal?.pan_no || "",
      dob,
      phone,
      address,
    });
    const decentroRes = result.raw as Record<string, any> | null;

    console.log("[CIBIL Score] Response:", JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = (decentroRes?.data as Record<string, any>) || {};
    const score = result.score;
    const overallSuccess = result.error === null && score !== null;

    const interpretation = score !== null && !isNaN(score) ? interpretCibilScore(score) : null;

    // Upsert kycVerifications. Filter by applicant so a previously-created
    // co-borrower CIBIL row (applicant='co_borrower') doesn't get
    // hijacked by primary's update — that produced a row with primary's
    // data tagged co_borrower, which case-review then routed away from
    // verificationCards (the primary-applicant array) and the Final
    // Decision validator reported "CIBIL verification not run yet" even
    // though primary CIBIL had been run and accepted.
    const existingRows = await db
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

    const verificationId =
      existingRows[0]?.id || createWorkflowId("KYCVER", now);

    const apiRequest = { name, pan: personal?.pan_no || "", dob, phone, address };

    // Enrich the raw Decentro response so CIBILCard can rehydrate score /
    // interpretation / report metadata after a page refresh.
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
        applicant: "primary",
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
    });
  } catch (error) {
    console.error("[CIBIL Score] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to fetch CIBIL score";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
