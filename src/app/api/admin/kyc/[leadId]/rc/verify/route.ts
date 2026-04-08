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

    // Call Decentro RC API
    const decentroRes = await verifyRcNumber(rcNumber);

    const now = new Date();
    const responseData = decentroRes?.data || {};
    const overallSuccess = decentroRes?.status === "SUCCESS";

    const rcDetails = {
      chassisNumber: responseData.chassis_number ?? responseData.chassisNumber ?? null,
      engineNumber: responseData.engine_number ?? responseData.engineNumber ?? null,
      ownerName: responseData.owner_name ?? responseData.ownerName ?? null,
      registrationDate: responseData.registration_date ?? responseData.registrationDate ?? null,
      vehicleClass: responseData.vehicle_class ?? responseData.vehicleClass ?? null,
      fuelType: responseData.fuel_type ?? responseData.fuelType ?? null,
      makerModel: responseData.maker_model ?? responseData.makerModel ?? null,
      fitnessUpto: responseData.fitness_upto ?? responseData.fitnessUpto ?? null,
      insuranceUpto: responseData.insurance_upto ?? responseData.insuranceUpto ?? null,
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
