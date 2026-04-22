import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  kycVerificationMetadata,
  kycVerifications,
  personalDetails,
} from "@/lib/db/schema";
import { fetchCibilScore } from "@/lib/decentro";
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

    // Call Decentro Credit Score API (only needs mobile + name)
    const decentroRes = await fetchCibilScore({
      name,
      pan: personal?.pan_no || "",
      dob,
      phone,
      address,
    });

    console.log("[CIBIL Score] Response:", JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = decentroRes?.data || {};
    // /v2/bytes/credit-score returns score in data.scoreDetails[0].value
    // Also check nested cCRResponse for some API versions
    const scoreDetails =
      responseData.scoreDetails ||
      responseData.cCRResponse?.cIRReportData?.scoreDetails ||
      responseData.cCRResponse?.scoreDetails;
    const rawScore =
      (Array.isArray(scoreDetails) && scoreDetails.length > 0
        ? scoreDetails[0]?.value
        : null) ||
      responseData.creditScore?.score ||
      responseData.credit_score ||
      responseData.score ||
      decentroRes?.data?.credit_score ||
      null;
    const score = rawScore !== null && rawScore !== undefined ? Number(rawScore) : null;
    const responseKey = decentroRes?.responseKey || "";
    const isErrorResponse = responseKey.startsWith("error_");
    const overallSuccess =
      !isErrorResponse &&
      (responseKey === "success_credit_score" ||
       responseKey === "success" ||
       decentroRes?.status === "SUCCESS") &&
      score !== null &&
      !isNaN(score);

    const interpretation = score !== null && !isNaN(score) ? interpretCibilScore(score) : null;

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
      ...(overallSuccess
        ? {}
        : {
            error: {
              message:
                decentroRes?.message || "Failed to fetch CIBIL score",
            },
          }),
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
