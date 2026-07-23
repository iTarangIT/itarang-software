/**
 * Primary-applicant Aadhaar DigiLocker service.
 *
 * Extracted verbatim from the admin routes
 *   src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/{initiate,status/[transactionId],resend-sms}/route.ts
 * so both the admin surface and the NBFC Acquire surface can drive the exact
 * same DigiLocker flow (digilocker_transactions + aadhaar kyc_verifications
 * writes) against the shared lead. Auth, publicOrigin resolution and any
 * coupon side-effects stay in the calling route — these helpers are pure
 * business logic.
 *
 * Each helper returns `{ status, body }`; the route does
 *   NextResponse.json(result.body, { status: result.status })
 * so admin and NBFC responses are byte-identical.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

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
  digilockerCheckStatus,
  buildDigilockerSmsMessage,
} from "@/lib/decentro";
import { sendKycSms } from "@/lib/sms";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import {
  crossMatchAadhaarData,
  type CrossMatchResult,
} from "@/lib/kyc/cross-match";

export type DigilockerResult = { status: number; body: Record<string, unknown> };

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

/**
 * Initiate a DigiLocker session for the primary applicant.
 *
 * The caller must resolve `callbackBase` through publicOrigin() (which rejects
 * unsafe hosts) and handle PublicOriginError itself — this helper only builds
 * the callback path off the provided base.
 */
export async function executeDigilockerInitiate(
  leadId: string,
  opts: {
    callbackBase: string;
    notificationChannel?: string;
    linkValidityHours?: number;
    // Stamp the dealer's first-API-execution coupon (BRD §1). Admin-only — the
    // NBFC re-run must NOT consume the coupon, so it leaves this false.
    stampCoupon?: boolean;
  },
): Promise<DigilockerResult> {
  const notificationChannel =
    typeof opts.notificationChannel === "string"
      ? opts.notificationChannel.trim()
      : "sms";
  const linkValidityHours =
    typeof opts.linkValidityHours === "number" ? opts.linkValidityHours : 24;

  // Fetch lead and personal details
  const [leadRows, personalRows] = await Promise.all([
    db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
    db
      .select()
      .from(personalDetails)
      .where(eq(personalDetails.lead_id, leadId))
      .limit(1),
  ]);

  const lead = leadRows[0];
  if (!lead) {
    return {
      status: 404,
      body: { success: false, error: { message: "Lead not found" } },
    };
  }

  const customerPhone = lead.phone || lead.mobile || lead.owner_contact;
  if (!customerPhone) {
    return {
      status: 400,
      body: {
        success: false,
        error: { message: "Customer phone number is required" },
      },
    };
  }

  const personal = personalRows[0];
  const customerEmail = personal?.email || lead.owner_email || null;

  const now = new Date();
  const digiId = createWorkflowId("DIGI", now);
  const referenceId = `DIGI-${leadId}-${Date.now()}`;
  const callbackUrl = `${opts.callbackBase}/api/kyc/digilocker/callback/${encodeURIComponent(digiId)}`;

  // Step 1: Initiate DigiLocker session → get auth URL + transaction ID
  // Pass customer phone so Decentro sends the DigiLocker link via SMS
  const decentroRes = await digilockerInitiateSession({
    reference_id: referenceId,
    redirect_url: callbackUrl,
    consent_purpose: "Aadhaar verification for battery loan application",
    mobile_number: customerPhone,
    email: customerEmail,
    notification_channel: notificationChannel as
      | "sms"
      | "whatsapp"
      | "email"
      | "both",
  });

  console.log("[DigiLocker Initiate] Response:", JSON.stringify(decentroRes));

  const resData = decentroRes?.data || {};
  const sessionId = resData.session_id || null;
  // initiate_session returns auth URL as authorizationUrl (camelCase from Decentro)
  const digilockerUrl =
    resData.authorizationUrl ||
    resData.authorization_url ||
    resData.digilocker_url ||
    resData.url ||
    null;
  const decentroTxnId =
    decentroRes?.decentroTxnId ||
    resData.decentroTxnId ||
    resData.decentro_transaction_id ||
    null;
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
    (decentroRes?.status === "SUCCESS" ||
      decentroRes?.responseStatus === "SUCCESS") &&
    (digilockerUrl || decentroTxnId);

  if (!apiSuccess) {
    return {
      status: 502,
      body: {
        success: false,
        error: {
          message:
            decentroRes?.message || "Failed to initiate DigiLocker session",
        },
        data: { rawResponse: decentroRes },
      },
    };
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

  // Upsert verification record by (lead_id, type='aadhaar', applicant='primary')
  // so re-initiating DigiLocker for the same lead doesn't pile up duplicate
  // rows in the dealer-side Verification Status table.
  const existingAadhaar = await db
    .select({ id: kycVerifications.id })
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.lead_id, leadId),
        eq(kycVerifications.verification_type, "aadhaar"),
        eq(kycVerifications.applicant, "primary"),
      ),
    )
    .limit(1);

  let verificationId: string;
  const verificationFields = {
    status: "initiating" as const,
    api_provider: "decentro_digilocker",
    api_request: {
      reference_id: referenceId,
      redirect_url: callbackUrl,
      notification_channel: notificationChannel,
      link_validity_hours: linkValidityHours,
    },
    api_response: decentroRes,
    updated_at: now,
  };
  if (existingAadhaar[0]) {
    verificationId = existingAadhaar[0].id;
    await db
      .update(kycVerifications)
      .set(verificationFields)
      .where(eq(kycVerifications.id, verificationId));
  } else {
    verificationId = createWorkflowId("KYCVER", now);
    await db.insert(kycVerifications).values({
      id: verificationId,
      lead_id: leadId,
      verification_type: "aadhaar",
      applicant: "primary",
      submitted_at: now,
      ...verificationFields,
    });
  }

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

  // Record first API execution if not set (coupon consumed on first paid API
  // call). Admin-only — the NBFC re-run passes stampCoupon=false so it never
  // consumes the dealer's coupon.
  if (opts.stampCoupon) {
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

  return {
    status: 200,
    body: {
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
    },
  };
}

/**
 * Poll DigiLocker status for the primary applicant. `transactionId` is our
 * internal DIGI-... transaction id.
 */
export async function executeDigilockerStatus(
  leadId: string,
  transactionId: string,
): Promise<DigilockerResult> {
  // Fetch transaction
  const txnRows = await db
    .select()
    .from(digilockerTransactions)
    .where(
      and(
        eq(digilockerTransactions.id, transactionId),
        eq(digilockerTransactions.lead_id, leadId),
      ),
    )
    .limit(1);

  const txn = txnRows[0];
  if (!txn) {
    return {
      status: 404,
      body: {
        success: false,
        error: { message: "DigiLocker transaction not found" },
      },
    };
  }

  // Derive a single smsStatus label from the row so every return branch
  // can emit it consistently.
  const smsAttempts = txn.sms_attempts ?? 0;
  const smsStatus =
    smsAttempts === 0
      ? "skipped"
      : txn.sms_delivered_at
        ? "delivered"
        : txn.sms_failed_reason
          ? "failed"
          : "skipped";
  const smsBlock = {
    smsStatus,
    smsStatusMessage: txn.sms_failed_reason ?? null,
    smsMessageId: txn.sms_message_id ?? null,
    smsAttempts,
    smsDeliveredAt: txn.sms_delivered_at?.toISOString() ?? null,
  };

  // If already fetched, return cached data — but only if data is actually populated
  const cachedData = txn.aadhaar_extracted_data as Record<
    string,
    string | null
  > | null;
  const cachedCross = txn.cross_match_result as Record<string, unknown> | null;
  const crossFields = Array.isArray(cachedCross?.fields)
    ? (cachedCross.fields as Record<string, unknown>[])
    : [];
  const hasCorrectFormat =
    crossFields.length > 0 && "leadValue" in (crossFields[0] || {});
  const hasRealData =
    cachedData && (cachedData.name || cachedData.uid) && hasCorrectFormat;
  if (txn.status === "document_fetched" && hasRealData) {
    return {
      status: 200,
      body: {
        success: true,
        data: {
          transactionId: txn.id,
          status: txn.status,
          linkOpened: true,
          digilockerLoginComplete: true,
          consentGiven: true,
          documentFetched: true,
          aadhaarData: txn.aadhaar_extracted_data,
          crossMatchResult: txn.cross_match_result,
          linkExpiresAt: txn.expires_at?.toISOString(),
          timeRemaining: null,
          ...smsBlock,
        },
      },
    };
  }

  // If expired
  if (txn.expires_at && new Date() > txn.expires_at) {
    if (txn.status !== "expired" && txn.status !== "document_fetched") {
      await db
        .update(digilockerTransactions)
        .set({ status: "expired", updated_at: new Date() })
        .where(eq(digilockerTransactions.id, transactionId));
    }

    return {
      status: 200,
      body: {
        success: true,
        data: {
          transactionId: txn.id,
          status: "expired",
          linkOpened: !!txn.link_opened_at,
          digilockerLoginComplete: false,
          consentGiven: false,
          documentFetched: false,
          linkExpiresAt: txn.expires_at?.toISOString(),
          timeRemaining: "0",
          ...smsBlock,
        },
      },
    };
  }

  // Poll Decentro for status if we have a txn ID
  // IMPORTANT: Only call Decentro API after consent_given stage.
  // Calling eAadhaar endpoint too early (during link_sent) can invalidate the session.
  let updatedStatus = txn.status;
  let aadhaarData = txn.aadhaar_extracted_data;
  let crossMatchResult = txn.cross_match_result as CrossMatchResult | null;

  const shouldPollDecentro =
    txn.decentro_txn_id &&
    txn.status !== "failed" &&
    txn.status !== "link_sent" &&
    (txn.status !== "document_fetched" || !hasRealData);

  if (shouldPollDecentro) {
    const statusRes = await digilockerCheckStatus(txn.decentro_txn_id!);
    console.log(
      "[DigiLocker Status] Decentro eAadhaar response:",
      JSON.stringify(statusRes),
    );
    const remoteData = statusRes?.data || {};

    const now = new Date();
    const updates: Record<string, unknown> = { updated_at: now };

    if (remoteData.link_opened && txn.status === "link_sent") {
      updatedStatus = "link_opened";
      updates.status = "link_opened";
      updates.link_opened_at = now;
    }

    if (remoteData.consent_given && updatedStatus !== "document_fetched") {
      updatedStatus = "consent_given";
      updates.status = "consent_given";
      updates.customer_authorized_at = now;
    }

    // Check if eAadhaar data is available — Decentro may return it under various keys
    const hasDocument =
      remoteData.document_fetched ||
      remoteData.aadhaar_data ||
      remoteData.kycResult ||
      remoteData.name || // eAadhaar fields directly in data
      remoteData.proofOfIdentity || // Decentro eAadhaar response format
      remoteData.aadhaarUid ||
      statusRes?.kycResult ||
      (statusRes?.status === "SUCCESS" &&
        statusRes?.responseKey?.includes("eaadhaar")) ||
      (statusRes?.status === "SUCCESS" &&
        typeof statusRes?.message === "string" &&
        statusRes.message.toLowerCase().includes("aadhaar"));

    if (hasDocument) {
      updatedStatus = "document_fetched";
      updates.status = "document_fetched";
      updates.digilocker_raw_response = statusRes;

      // Extract Aadhaar fields — Decentro returns proofOfIdentity + proofOfAddress
      const poi = remoteData.proofOfIdentity || {};
      const poa = remoteData.proofOfAddress || {};
      const raw = remoteData.aadhaar_data || statusRes?.kycResult || remoteData;

      // Build full address from proofOfAddress components
      const addressParts = [
        poa.house,
        poa.street,
        poa.landmark,
        poa.locality,
        poa.vtc,
        poa.subDistrict,
        poa.district,
        poa.state,
        poa.pincode,
      ].filter(Boolean);
      const fullAddress =
        addressParts.length > 0
          ? addressParts.join(", ")
          : raw.address || raw.full_address || null;

      aadhaarData = {
        uid: remoteData.aadhaarUid || raw.uid || raw.aadhaar_number || null,
        name: poi.name || raw.name || null,
        gender: poi.gender || raw.gender || null,
        dob: poi.dob || raw.dob || raw.date_of_birth || null,
        careof: poa.careOf || poa.careof || raw.careof || raw.care_of || null,
        address: fullAddress,
        district: poa.district || raw.dist || raw.district || null,
        state: poa.state || raw.state || null,
        pincode: poa.pincode || raw.pincode || raw.zip || null,
        photo_base64: remoteData.image || raw.photo_base64 || raw.photo || null,
        mobile: poi.hashedMobileNumber || raw.mobile || raw.phone || null,
      };
      updates.aadhaar_extracted_data = aadhaarData;

      // Cross-match with lead data
      const [leadRows, personalRows] = await Promise.all([
        db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
        db
          .select()
          .from(personalDetails)
          .where(eq(personalDetails.lead_id, leadId))
          .limit(1),
      ]);

      const lead = leadRows[0];
      const personal = personalRows[0];

      if (lead) {
        const rawCrossMatch = crossMatchAadhaarData(
          {
            name: (aadhaarData as Record<string, string>).name,
            dob: (aadhaarData as Record<string, string>).dob,
            phone: (aadhaarData as Record<string, string>).mobile,
            address: (aadhaarData as Record<string, string>).address,
            gender: (aadhaarData as Record<string, string>).gender,
            fatherOrHusbandName: (aadhaarData as Record<string, string>).careof,
          },
          {
            name: lead.full_name || lead.owner_name,
            dob: lead.dob
              ? new Date(lead.dob).toISOString().slice(0, 10)
              : personal?.dob
                ? new Date(personal.dob).toISOString().slice(0, 10)
                : null,
            phone: lead.phone || lead.mobile || lead.owner_contact,
            address: personal?.local_address || lead.shop_address || lead.city,
            gender: null,
            fatherOrHusbandName: personal?.father_husband_name,
          },
        );
        // Map to UI-expected format: leadValue/aadhaarValue/pass
        crossMatchResult = {
          ...rawCrossMatch,
          fields: rawCrossMatch.fields.map((f) => ({
            field: f.field,
            leadValue: f.inputValue,
            aadhaarValue: f.documentValue,
            similarity: f.similarity,
            threshold: f.threshold,
            pass: f.matchResult === "strong" || f.matchResult === "moderate",
          })),
        } as unknown as CrossMatchResult;
        updates.cross_match_result = crossMatchResult;
      }

      // Update verification record
      if (txn.verification_id) {
        await db
          .update(kycVerifications)
          .set({
            status: crossMatchResult?.overallPass ? "success" : "failed",
            api_response: statusRes,
            match_score: crossMatchResult?.nameSimilarity
              ? String(crossMatchResult.nameSimilarity)
              : null,
            completed_at: now,
            updated_at: now,
          })
          .where(eq(kycVerifications.id, txn.verification_id));
      }
    }

    if (Object.keys(updates).length > 1) {
      await db
        .update(digilockerTransactions)
        .set(updates)
        .where(eq(digilockerTransactions.id, transactionId));
    }
  }

  // Calculate time remaining
  let timeRemaining: string | null = null;
  if (txn.expires_at) {
    const ms = txn.expires_at.getTime() - Date.now();
    if (ms > 0) {
      const hours = Math.floor(ms / (1000 * 60 * 60));
      const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
      timeRemaining = `${hours} hours ${minutes} minutes`;
    } else {
      timeRemaining = "0";
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      data: {
        transactionId: txn.id,
        status: updatedStatus,
        linkOpened:
          updatedStatus === "link_opened" ||
          updatedStatus === "consent_given" ||
          updatedStatus === "document_fetched",
        digilockerLoginComplete:
          updatedStatus === "consent_given" ||
          updatedStatus === "document_fetched",
        consentGiven:
          updatedStatus === "consent_given" ||
          updatedStatus === "document_fetched",
        documentFetched: updatedStatus === "document_fetched",
        aadhaarData,
        crossMatchResult,
        linkExpiresAt: txn.expires_at?.toISOString(),
        timeRemaining,
        ...smsBlock,
      },
    },
  };
}

/**
 * Resend the DigiLocker SMS for the primary applicant WITHOUT recreating the
 * Decentro DigiLocker session (which would cost a second credit and issue a
 * new URL). Picks the most recent non-terminal transaction for this lead whose
 * session hasn't expired and pushes a fresh SMS with the same URL.
 */
export async function executeDigilockerResendSms(
  leadId: string,
): Promise<DigilockerResult> {
  const now = new Date();

  // Most recent non-terminal transaction for this lead, still within its
  // session TTL. Sessions that already reached consent_given or
  // document_fetched also still need SMS retry — the URL is usable until
  // expiry regardless of intermediate status.
  const [txn] = await db
    .select()
    .from(digilockerTransactions)
    .where(
      and(
        eq(digilockerTransactions.lead_id, leadId),
        inArray(digilockerTransactions.status, [
          "link_sent",
          "link_opened",
          "consent_given",
        ]),
      ),
    )
    .orderBy(desc(digilockerTransactions.created_at))
    .limit(1);

  if (!txn) {
    return {
      status: 404,
      body: {
        success: false,
        error: {
          message:
            "No active DigiLocker session to resend. Create a fresh link first.",
        },
      },
    };
  }

  if (!txn.digilocker_url) {
    return {
      status: 404,
      body: {
        success: false,
        error: {
          message:
            "DigiLocker URL missing on this transaction — create a fresh link.",
        },
      },
    };
  }

  if (txn.expires_at && now > txn.expires_at) {
    return {
      status: 410,
      body: {
        success: false,
        error: {
          message:
            "DigiLocker session has expired. Create a fresh link to continue.",
        },
      },
    };
  }

  // Figure out remaining validity window so the SMS text stays honest.
  const remainingMs = txn.expires_at
    ? Math.max(0, txn.expires_at.getTime() - now.getTime())
    : 0;
  const remainingHours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));

  const attempt = (txn.sms_attempts ?? 0) + 1;
  const smsResult = await sendKycSms({
    mobile_number: txn.customer_phone ?? "",
    message: buildDigilockerSmsMessage(txn.digilocker_url, remainingHours),
    reference_id: `${txn.reference_id}-RESEND-${attempt}`,
    // Matches the approved Gupshup template body: {{1}} = link, {{2}} = hours.
    templateParams: [txn.digilocker_url, String(remainingHours)],
  });

  // Always bump the counter so the UI reflects that a retry occurred even
  // if the provider failed to deliver. Keeps retry accounting accurate.
  await db
    .update(digilockerTransactions)
    .set({
      sms_message_id: smsResult.messageId ?? txn.sms_message_id,
      sms_delivered_at: smsResult.success ? now : txn.sms_delivered_at,
      sms_failed_reason: smsResult.success ? null : smsResult.error ?? "unknown",
      sms_attempts: attempt,
      updated_at: now,
    })
    .where(eq(digilockerTransactions.id, txn.id));

  const smsStatus = smsResult.success
    ? "delivered"
    : smsResult.skipped
      ? "skipped"
      : "failed";

  return {
    status: 200,
    body: {
      success: smsResult.success,
      data: {
        transactionId: txn.id,
        smsStatus,
        smsStatusMessage: smsResult.error,
        smsMessageId: smsResult.messageId,
        smsAttempts: attempt,
        expiresAt: txn.expires_at?.toISOString() ?? null,
      },
      ...(smsResult.success
        ? {}
        : {
            error: {
              message: smsResult.skipped
                ? "SMS provider is not enabled on this deploy. Copy the link and share manually."
                : smsResult.error ?? "SMS resend failed",
            },
          }),
    },
  };
}
