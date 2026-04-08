import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dealerLeads,
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
        .from(dealerLeads)
        .where(eq(dealerLeads.id, leadId))
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
          error: { message: "PAN number is required for CIBIL check" },
        },
        { status: 400 },
      );
    }

    const name = lead.dealer_name || "";
    const dob = personal.dob
      ? new Date(personal.dob).toISOString().slice(0, 10)
      : "";
    const phone = lead.phone || "";
    const address = personal.local_address || lead.location || "";

    // Call Decentro CIBIL API
    const decentroRes = await fetchCibilScore({
      name,
      pan: personal.pan_no,
      dob,
      phone,
      address,
    });

    const now = new Date();
    const score =
      decentroRes?.data?.credit_score ??
      decentroRes?.data?.score ??
      null;
    const overallSuccess =
      decentroRes?.status === "SUCCESS" && score !== null;

    const interpretation = score ? interpretCibilScore(Number(score)) : null;

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
          api_request: { name, pan: personal.pan_no, dob, phone, address },
          api_response: decentroRes,
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
        api_request: { name, pan: personal.pan_no, dob, phone, address },
        api_response: decentroRes,
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
        score: score ? Number(score) : null,
        interpretation,
        reportId: decentroRes?.data?.report_id || null,
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
