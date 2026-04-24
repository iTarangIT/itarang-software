import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import crypto from "crypto";

import { db } from "@/lib/db";
import { leads, loanSanctions, otpConfirmations } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { generateId } from "@/lib/api-utils";
import { sendDecentroSms } from "@/lib/decentro";

// BRD V2 §3.2 — Step 5 OTP send.
// Generates a 6-digit OTP, stores a SHA-256 hash with 10-minute expiry, and
// sends the OTP via Decentro SMS. Max 3 sends per session — after the 3rd
// send, a 30-minute cooldown is enforced before a new OTP session can begin.

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

    // Generate new OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(now.getTime() + OTP_LIFETIME_MS);

    const smsMessage = loan
      ? `Your iTarang loan is sanctioned. Loan: Rs.${loan.loan_amount} | EMI: Rs.${loan.emi}/mo | Tenure: ${loan.tenure_months}m | Lender: ${loan.loan_approved_by}. OTP to confirm: ${otp}. Valid for 10 min. Do not share.`
      : `Your iTarang sale OTP: ${otp}. Valid for 10 min. Do not share.`;

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

    // Fire SMS (non-blocking on delivery errors — the dealer can resend)
    const smsResult = await sendDecentroSms({
      mobile_number: phone,
      message: smsMessage,
      reference_id: `otp-${leadId}-${Date.now()}`,
    });

    return NextResponse.json({
      success: true,
      data: {
        otpSentTo: maskPhone(phone),
        expiresInSeconds: Math.floor(OTP_LIFETIME_MS / 1000),
        sendCount: existing ? existing.send_count + 1 : 1,
        maxSends: MAX_SENDS,
        smsStatus: smsResult.success ? "sent" : smsResult.skipped ? "skipped" : "failed",
        smsError: smsResult.error,
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
