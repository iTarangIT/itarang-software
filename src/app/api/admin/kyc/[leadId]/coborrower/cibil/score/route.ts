import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { coBorrowers, kycVerifications } from "@/lib/db/schema";
import { fetchCibilScore } from "@/lib/decentro";
import { interpretCibilScore } from "@/lib/kyc/cibil-interpreter";
import { humanizeCibilError } from "@/lib/kyc/cibil-friendly-errors";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

// Mirrors the primary CIBIL score route at
// src/app/api/admin/kyc/[leadId]/cibil/score/route.ts but sources name / pan /
// dob / phone / address from the coBorrowers row and persists with
// applicant='co_borrower'.
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

    const name = cb.full_name || "";
    const phone = cb.phone || "";
    if (!name || !phone) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "Co-borrower name and phone number are required for credit score",
          },
        },
        { status: 400 },
      );
    }

    const dob = cb.dob ? new Date(cb.dob).toISOString().slice(0, 10) : "";
    const address = cb.address || cb.current_address || "";

    const decentroRes = await fetchCibilScore({
      name,
      pan: cb.pan_no || "",
      dob,
      phone,
      address,
    });

    console.log("[Co-Borrower CIBIL Score] Response:", JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = decentroRes?.data || {};
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

    const apiRequest = { name, pan: cb.pan_no || "", dob, phone, address };

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
        applicant: "co_borrower",
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

    const friendly = overallSuccess
      ? null
      : humanizeCibilError({
          endpoint: "score",
          responseKey,
          rawMessage: decentroRes?.message ?? null,
        });

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
    console.error("[Co-Borrower CIBIL Score] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch CIBIL score";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
