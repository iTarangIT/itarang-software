import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  digilockerTransactions,
  kycVerificationMetadata,
  kycVerifications,
  personalDetails,
} from "@/lib/db/schema";
import { digilockerInitiateSession } from "@/lib/decentro";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

const DIGILOCKER_CALLBACK_BASE =
  process.env.NEXT_PUBLIC_APP_URL || "https://itarang.com";

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
    const body = await req.json().catch(() => ({}));

    const notificationChannel =
      typeof body.notification_channel === "string"
        ? body.notification_channel.trim()
        : "sms";
    const linkValidityHours =
      typeof body.link_validity_hours === "number"
        ? body.link_validity_hours
        : 24;

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

    const customerPhone = lead.phone || lead.mobile || lead.owner_contact;
    if (!customerPhone) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Customer phone number is required" },
        },
        { status: 400 },
      );
    }

    const personal = personalRows[0];
    const customerEmail = personal?.email || lead.owner_email || null;

    const now = new Date();
    const digiId = createWorkflowId("DIGI", now);
    const referenceId = `DIGI-${leadId}-${Date.now()}`;
    const callbackUrl = `${DIGILOCKER_CALLBACK_BASE}/api/kyc/digilocker/callback/${encodeURIComponent(digiId)}`;

    // Step 1: Initiate DigiLocker session → get auth URL + transaction ID
    // Pass customer phone so Decentro sends the DigiLocker link via SMS
    const decentroRes = await digilockerInitiateSession({
      reference_id: referenceId,
      redirect_url: callbackUrl,
      consent_purpose: "Aadhaar verification for battery loan application",
      mobile_number: customerPhone,
      email: customerEmail,
      notification_channel: notificationChannel as 'sms' | 'whatsapp' | 'email' | 'both',
    });

    console.log("[DigiLocker Initiate] Response:", JSON.stringify(decentroRes));

    const resData = decentroRes?.data || {};
    const sessionId = resData.session_id || null;
    // initiate_session returns auth URL as authorizationUrl (camelCase from Decentro)
    const digilockerUrl = resData.authorizationUrl || resData.authorization_url || resData.digilocker_url || resData.url || null;
    const decentroTxnId = decentroRes?.decentroTxnId || resData.decentroTxnId || resData.decentro_transaction_id || null;
    const expiresAt = resData.expires_at
      ? new Date(resData.expires_at)
      : new Date(now.getTime() + linkValidityHours * 60 * 60 * 1000);

    const apiSuccess =
      (decentroRes?.status === "SUCCESS" || decentroRes?.responseStatus === "SUCCESS") &&
      (digilockerUrl || decentroTxnId);

    if (!apiSuccess) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              decentroRes?.message ||
              "Failed to initiate DigiLocker session",
          },
          data: { rawResponse: decentroRes },
        },
        { status: 502 },
      );
    }

    // Create verification record
    const verificationId = createWorkflowId("KYCVER", now);
    await db.insert(kycVerifications).values({
      id: verificationId,
      lead_id: leadId,
      verification_type: "aadhaar",
      status: "initiating",
      api_provider: "decentro_digilocker",
      api_request: {
        reference_id: referenceId,
        redirect_url: callbackUrl,
        notification_channel: notificationChannel,
        link_validity_hours: linkValidityHours,
      },
      api_response: decentroRes,
      submitted_at: now,
    });

    // Create DigiLocker transaction
    await db.insert(digilockerTransactions).values({
      id: digiId,
      lead_id: leadId,
      verification_id: verificationId,
      reference_id: referenceId,
      decentro_txn_id: decentroTxnId,
      session_id: sessionId,
      status: "link_sent",
      customer_phone: customerPhone,
      customer_email: customerEmail,
      digilocker_url: digilockerUrl,
      notification_channel: notificationChannel,
      link_sent_at: now,
      expires_at: expiresAt,
    });

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
          first_api_type: "aadhaar_digilocker",
          verification_started_at: now,
          updated_at: now,
        })
        .where(eq(kycVerificationMetadata.lead_id, leadId));
    }

    return NextResponse.json({
      success: true,
      data: {
        transactionId: digiId,
        sessionId,
        verificationId,
        digilockerUrl,
        linkSent: true,
        sentTo: {
          mobile: customerPhone,
          email: customerEmail,
        },
        linkExpiresAt: expiresAt.toISOString(),
        message:
          "DigiLocker link sent to customer. Awaiting authorization.",
      },
    });
  } catch (error) {
    console.error("[DigiLocker Initiate] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to initiate DigiLocker";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
