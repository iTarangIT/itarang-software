import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import crypto from "crypto";

import { db } from "@/lib/db";
import { leads, loanSanctions, otpConfirmations } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { generateId } from "@/lib/api-utils";
import { sendMsg91Otp } from "@/lib/msg91";

// BRD V2 §3.2 — Step 5 OTP send.
// Generates a 6-digit OTP, stores a SHA-256 hash with 10-minute expiry, and
// sends the OTP via MSG91 (server passes the OTP to MSG91; MSG91 substitutes
// it into the approved template body and delivers the SMS). Max 3 sends per
// session — after the 3rd send, a 30-minute cooldown is enforced before a
// new OTP session can begin.

const OTP_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SENDS = 3;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes after max sends

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone;
  return `XXXXXX${digits.slice(-4)}`;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }
    if (lead.kyc_status !== "loan_sanctioned") {
      return NextResponse.json(
        { success: false, error: { message: `Step 5 OTP only available after loan sanction (current: ${lead.kyc_status})` } },
        { status: 400 },
      );
    }

    const phone = lead.phone || lead.mobile;
    if (!phone) {
      return NextResponse.json(
        { success: false, error: { message: "Lead has no phone number on file" } },
        { status: 400 },
      );
    }

    // Grab the latest OTP record (if any) — we keep the same row and bump
    // send_count, refreshing expiry, until MAX_SENDS is hit.
    const [existing] = await db
      .select()
      .from(otpConfirmations)
      .where(
        and(
          eq(otpConfirmations.lead_id, leadId),
          eq(otpConfirmations.is_used, false),
        ),
      )
      .orderBy(desc(otpConfirmations.created_at))
      .limit(1);

    const now = new Date();
    if (existing && existing.send_count >= MAX_SENDS) {
      const cutoff = new Date(existing.created_at.getTime() + COOLDOWN_MS);
      if (now < cutoff) {
        const waitMins = Math.ceil((cutoff.getTime() - now.getTime()) / 60000);
        return NextResponse.json(
          {
            success: false,
            error: { message: `Max OTP resends reached. Please wait ${waitMins} min before trying again.` },
          },
          { status: 429 },
        );
      }
      // Cooldown elapsed — start a fresh session below by marking this one as used/expired.
      await db
        .update(otpConfirmations)
        .set({ is_used: true, used_at: now })
        .where(eq(otpConfirmations.id, existing.id));
    }

    // Fetch loan details for the SMS body
    const [loan] = await db
      .select()
      .from(loanSanctions)
      .where(
        and(
          eq(loanSanctions.lead_id, leadId),
          eq(loanSanctions.status, "sanctioned"),
        ),
      )
      .orderBy(desc(loanSanctions.created_at))
      .limit(1);

    // OTP value:
    //   - If MSG91 env is configured → random 6-digit, MSG91 delivers the SMS.
    //   - Otherwise (dev / not yet integrated) → hardcoded "123456" so the
    //     team can run end-to-end Step 5 testing without a live SMS provider.
    //     Verification (in confirm-dispatch) still hash-compares, so this path
    //     uses the exact same code that production will use once MSG91 is
    //     wired — only the SMS delivery step is short-circuited.
    void loan;
    const msg91Configured = !!(
      process.env.MSG91_AUTH_KEY?.trim() &&
      process.env.MSG91_TEMPLATE_ID?.trim()
    );
    const otp = msg91Configured
      ? Math.floor(100000 + Math.random() * 900000).toString()
      : "123456";
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(now.getTime() + OTP_LIFETIME_MS);

    let otpRecordId: string;
    if (existing && existing.send_count < MAX_SENDS) {
      // Same session — replace the hash and bump send_count
      otpRecordId = existing.id;
      await db
        .update(otpConfirmations)
        .set({
          otp_hash: otpHash,
          expires_at: expiresAt,
          send_count: existing.send_count + 1,
          attempt_count: 0,
          locked_until: null,
        })
        .where(eq(otpConfirmations.id, existing.id));
    } else {
      otpRecordId = await generateId("OTP");
      await db.insert(otpConfirmations).values({
        id: otpRecordId,
        lead_id: leadId,
        otp_type: "dispatch_confirmation",
        otp_hash: otpHash,
        phone_sent_to: phone,
        created_at: now,
        expires_at: expiresAt,
        send_count: 1,
        attempt_count: 0,
        is_used: false,
      });
    }

    // Deliver via MSG91 only when configured. In dev/no-provider mode we
    // skip the network call and return the hardcoded OTP to the dealer UI
    // so the tester can paste it back into the form (acting as both
    // customer and dealer).
    const isDev = process.env.NODE_ENV !== "production";
    let smsStatus: "sent" | "dev_hardcoded" = "dev_hardcoded";

    if (msg91Configured) {
      const smsResult = await sendMsg91Otp({
        mobile_number: phone,
        otp,
        otp_expiry_minutes: Math.floor(OTP_LIFETIME_MS / 60000),
      });
      if (!smsResult.success) {
        const reason = `SMS delivery failed: ${smsResult.error || "unknown error"}`;
        return NextResponse.json(
          { success: false, error: { message: reason, smsStatus: "failed" } },
          { status: 502 },
        );
      }
      smsStatus = "sent";
    } else {
      console.log(
        `[Step 5 Send OTP] MSG91 not configured — using hardcoded OTP ${otp} for ${leadId}. Set MSG91_AUTH_KEY + MSG91_TEMPLATE_ID to switch to live SMS.`,
      );
    }

    if (isDev) {
      console.log(`[Step 5 Send OTP] DEV-ONLY plaintext OTP for ${leadId}: ${otp}`);
    }

    return NextResponse.json({
      success: true,
      data: {
        otpSentTo: maskPhone(phone),
        expiresInSeconds: Math.floor(OTP_LIFETIME_MS / 1000),
        sendCount: existing ? existing.send_count + 1 : 1,
        maxSends: MAX_SENDS,
        smsStatus,
        // Surface the OTP to the UI in dev OR whenever we used the
        // hardcoded path — the dealer needs to see it to test the flow.
        ...(smsStatus === "dev_hardcoded" || isDev ? { _devOtp: otp } : {}),
      },
    });
  } catch (error) {
    console.error("[Step 5 Send OTP] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to send OTP";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
