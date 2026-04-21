import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { digilockerTransactions } from "@/lib/db/schema";
import { buildDigilockerSmsMessage } from "@/lib/decentro";
import { sendKycSms } from "@/lib/sms";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

/**
 * Resend the DigiLocker SMS for the customer WITHOUT recreating the
 * Decentro DigiLocker session (which would cost a second credit and issue
 * a new URL). Picks the most recent non-terminal transaction for this lead
 * whose session hasn't expired and pushes a fresh SMS with the same URL.
 *
 * Returns:
 *   - 200 with { smsStatus, smsAttempts } on success/failed-delivery
 *   - 404 if no eligible transaction found
 *   - 410 if the matching session has expired (UI should fall back to full re-initiate)
 */
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
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "No active DigiLocker session to resend. Create a fresh link first.",
          },
        },
        { status: 404 },
      );
    }

    if (!txn.digilocker_url) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "DigiLocker URL missing on this transaction — create a fresh link.",
          },
        },
        { status: 404 },
      );
    }

    if (txn.expires_at && now > txn.expires_at) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "DigiLocker session has expired. Create a fresh link to continue.",
          },
        },
        { status: 410 },
      );
    }

    // Figure out remaining validity window so the SMS text stays honest.
    const remainingMs = txn.expires_at
      ? Math.max(0, txn.expires_at.getTime() - now.getTime())
      : 0;
    const remainingHours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));

    const attempt = (txn.sms_attempts ?? 0) + 1;
    const smsResult = await sendKycSms({
      mobile_number: txn.customer_phone,
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
        sms_failed_reason: smsResult.success
          ? null
          : smsResult.error ?? "unknown",
        sms_attempts: attempt,
        updated_at: now,
      })
      .where(eq(digilockerTransactions.id, txn.id));

    const smsStatus = smsResult.success
      ? "delivered"
      : smsResult.skipped
        ? "skipped"
        : "failed";

    return NextResponse.json({
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
              message:
                smsResult.skipped
                  ? "SMS provider is not enabled on this deploy. Copy the link and share manually."
                  : smsResult.error ?? "SMS resend failed",
            },
          }),
    });
  } catch (error) {
    console.error("[DigiLocker Resend-SMS] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to resend SMS";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}

