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
import {
  digilockerInitiateSession,
  buildDigilockerSmsMessage,
} from "@/lib/decentro";
import { sendKycSms } from "@/lib/sms";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";

// Decentro returns notification info in different shapes depending on the
// product / version. Walk the response defensively and surface whatever
// SMS-delivery signal we can find so the UI can show "sent" vs "needs
// manual share". Never throws — unknown shape just returns smsDelivered:null.
function extractNotificationStatus(decentroRes: any): {
  smsAttempted: boolean;
  smsDelivered: boolean | null;
  message: string | null;
} {
  const data = decentroRes?.data ?? {};
  const notif = data?.notifications ?? data?.notification ?? decentroRes?.notifications;
  const sms = notif?.sms ?? notif?.SMS ?? null;

  if (!sms) {
    return { smsAttempted: false, smsDelivered: null, message: null };
  }

  const status = String(sms.status ?? sms.delivery_status ?? "").toLowerCase();
  const delivered =
    status === "sent" ||
    status === "delivered" ||
    status === "success" ||
    sms.delivered === true;

  const failed =
    status === "failed" ||
    status === "error" ||
    status === "rejected" ||
    sms.delivered === false;

  return {
    smsAttempted: true,
    smsDelivered: delivered ? true : failed ? false : null,
    message: sms.message ?? sms.error ?? sms.reason ?? null,
  };
}

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
    // publicOrigin applies a safe-host allow-list. Refuses ngrok / localhost
    // in production so a teammate's local dev tunnel can't get stored as a
    // Decentro callback URL (see 2026-04-23 incident in src/lib/public-origin.ts).
    let callbackBase: string;
    try {
      callbackBase = publicOrigin({ req });
    } catch (err) {
      if (err instanceof PublicOriginError) {
        return NextResponse.json(
          {
            success: false,
            error: {
              message:
                "Cannot initiate DigiLocker: no safe callback URL available. " +
                "Ask ops to set NEXT_PUBLIC_APP_URL to the deployed origin.",
              code: err.code,
            },
          },
          { status: 500 },
        );
      }
      throw err;
    }
    const callbackUrl = `${callbackBase}/api/kyc/digilocker/callback/${encodeURIComponent(digiId)}`;

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

    // Surface Decentro's notification delivery status. Decentro returns
    // success on link generation regardless of whether SMS actually went
    // out — so we have to peek into their response shape to see if the
    // SMS sub-request succeeded. If they explicitly report a failure or
    // skip it, we tell the UI so the rep can fall back to copying the link.
    const notificationStatus = extractNotificationStatus(decentroRes);
    if (notificationStatus.smsAttempted && !notificationStatus.smsDelivered) {
      console.warn(
        `[DigiLocker Initiate] SMS notification did NOT deliver for lead ${leadId}: ${notificationStatus.message ?? "no detail"}. Customer phone: ${customerPhone}`,
      );
    }

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

    // ── Send SMS via configured provider (SMS_PROVIDER env) ───────────
    // Defaults to Gupshup; flip to Decentro with SMS_PROVIDER=decentro.
    // If the chosen provider is disabled or misconfigured, sendKycSms()
    // skips cleanly and the admin falls back to Copy/Open on the UI. A
    // failed send NEVER blocks session creation.
    const smsResult = digilockerUrl
      ? await sendKycSms({
          mobile_number: customerPhone,
          message: buildDigilockerSmsMessage(digilockerUrl, linkValidityHours),
          reference_id: `${referenceId}-SMS`,
          // Matches the approved Gupshup template body: {{1}} = link, {{2}} = hours.
          templateParams: [digilockerUrl, String(linkValidityHours)],
        })
      : {
          success: false,
          skipped: true,
          messageId: null,
          error: "no_url",
          raw: null,
        };

    const smsStatusLabel = smsResult.success
      ? "delivered"
      : smsResult.skipped
        ? "skipped"
        : "failed";

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
      sms_message_id: smsResult.messageId,
      sms_delivered_at: smsResult.success ? now : null,
      sms_failed_reason: smsResult.success ? null : smsResult.error ?? null,
      sms_attempts: smsResult.skipped ? 0 : 1,
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

    // smsStatus priority: our own Decentro-SMS result if attempted, else
    // fall back to whatever the embedded notifications block reports.
    const finalSmsStatus = smsResult.skipped
      ? notificationStatus.smsDelivered === true
        ? "delivered"
        : notificationStatus.smsDelivered === false
          ? "failed"
          : "skipped"
      : smsStatusLabel;

    const finalSmsMessage = smsResult.error ?? notificationStatus.message;

    return NextResponse.json({
      success: true,
      data: {
        transactionId: digiId,
        sessionId,
        verificationId,
        digilockerUrl,
        linkSent: finalSmsStatus === "delivered",
        smsStatus: finalSmsStatus, // "delivered" | "failed" | "skipped"
        smsStatusMessage: finalSmsMessage,
        smsMessageId: smsResult.messageId,
        smsAttempts: smsResult.skipped ? 0 : 1,
        sentTo: {
          mobile: customerPhone,
          email: customerEmail,
        },
        linkExpiresAt: expiresAt.toISOString(),
        message:
          finalSmsStatus === "failed"
            ? "DigiLocker link generated, but SMS delivery failed. Tap Resend SMS or copy the link and share it with the customer."
            : finalSmsStatus === "skipped"
              ? "DigiLocker link generated. Copy the link and share it with the customer — SMS provider is not enabled yet."
              : "DigiLocker link sent via SMS. Awaiting customer authorization.",
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
