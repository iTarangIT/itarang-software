import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  kycVerificationMetadata,
  kycVerifications,
  personalDetails,
} from "@/lib/db/schema";
import { verifyRcNumber } from "@/lib/decentro";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

export async function POST(
  req: NextRequest,
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
    const body = await req.json();

    // RC number from request body or from personalDetails
    let rcNumber =
      typeof body.rc_number === "string" ? body.rc_number.trim() : "";

    if (!rcNumber) {
      const personalRows = await db
        .select({ vehicle_rc: personalDetails.vehicle_rc })
        .from(personalDetails)
        .where(eq(personalDetails.lead_id, leadId))
        .limit(1);

      rcNumber = personalRows[0]?.vehicle_rc?.trim() || "";
    }

    if (!rcNumber) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "RC number is required — provide in request body or ensure it exists in lead details",
          },
        },
        { status: 400 },
      );
    }

    // Normalize: remove dots, dashes, spaces and uppercase
    rcNumber = rcNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");

    // Validate Indian RC format: 2-letter state + 1-2 digit district + 1-4 alpha/digit series + 1-4 digit number
    // Examples: MH12AB1234, DL1CAB1234, KA01MA1234
    const rcPattern = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;
    if (!rcPattern.test(rcNumber) || rcNumber.length < 6 || rcNumber.length > 13) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Invalid RC number format "${rcNumber}". Expected format: MH12AB1234 (state + district + series + number)`,
          },
        },
        { status: 400 },
      );
    }

    // Call Decentro RC to Chassis API
    const decentroRes = await verifyRcNumber(rcNumber);

    console.log("[RC to Chassis] Response:", JSON.stringify(decentroRes));

    const now = new Date();
    const responseData = decentroRes?.data || {};
    const responseKey = decentroRes?.responseKey || "";
    const isErrorResponse = responseKey.startsWith("error_");
    const overallSuccess =
      !isErrorResponse &&
      (decentroRes?.status === "SUCCESS" ||
       responseKey === "success") &&
      !!(responseData.chassisNumber || responseData.chassis_number);

    const rcDetails = {
      chassisNumber: responseData.chassisNumber ?? responseData.chassis_number ?? null,
      rcNumber: rcNumber,
    };

    // Upsert kycVerifications
    const existingRows = await db
      .select({ id: kycVerifications.id })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "rc"),
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
          api_request: { rc_number: rcNumber },
          api_response: decentroRes,
          failed_reason: overallSuccess
            ? null
            : decentroRes?.message || "RC verification failed",
          completed_at: now,
          updated_at: now,
        })
        .where(eq(kycVerifications.id, verificationId));
    } else {
      await db.insert(kycVerifications).values({
        id: verificationId,
        lead_id: leadId,
        verification_type: "rc",
        status: overallSuccess ? "success" : "failed",
        api_provider: "decentro",
        api_request: { rc_number: rcNumber },
        api_response: decentroRes,
        failed_reason: overallSuccess
          ? null
          : decentroRes?.message || "RC verification failed",
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
          first_api_type: "rc",
          verification_started_at: now,
          updated_at: now,
        })
        .where(eq(kycVerificationMetadata.lead_id, leadId));
    }

    return NextResponse.json({
      success: overallSuccess,
      data: {
        verificationId,
        rcNumber,
        rcDetails,
        rawResponse: decentroRes,
      },
      ...(overallSuccess
        ? {}
        : {
            error: {
              message:
                decentroRes?.message || "RC verification failed",
            },
          }),
    });
  } catch (error) {
    console.error("[RC Verification] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to verify RC";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
