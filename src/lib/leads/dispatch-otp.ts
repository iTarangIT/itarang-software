// BRD V2 §3.2 — the Step-5 dispatch OTP, as a session-free service.
//
// Extracted from POST /api/lead/[id]/step-5/send-otp (E-264) for the reason the
// consent service was extracted before it: a WhatsApp turn has no Supabase
// session, so it cannot call a route guarded by requireRole(["dealer"]), and a
// second implementation of an OTP that authorises stock movement would be a
// genuinely dangerous thing to let drift.
//
// WHAT CHANGED IN THE MOVE: a WhatsApp delivery arm.
//
// The ladder was 2Factor voice → MSG91 SMS → hardcoded "123456". Consent OTP has
// had a WhatsApp arm since E-180 while this one did not, even though the
// recipient is the same customer and — for a WhatsApp-originated lead — is
// demonstrably reachable on WhatsApp right now. WhatsApp is tried first when the
// caller asks for it; every other path is untouched.
//
// WHO THE CODE GOES TO: `leads.phone || leads.mobile`, always. Never a number
// from the request. There is nothing here for a caller to redirect.

import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";

import { generateId } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { leads, otpConfirmations } from "@/lib/db/schema";
import { sendMsg91Otp } from "@/lib/msg91";
import { sendTwoFactorVoiceOtp, twoFactorConfigured } from "@/lib/twofactor";

export const OTP_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_SENDS = 3;
export const COOLDOWN_MS = 30 * 60 * 1000;

export type DispatchOtpChannel = "whatsapp" | "call" | "sms" | "dev";

export function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone;
  return `XXXXXX${digits.slice(-4)}`;
}

export type SendDispatchOtpResult =
  | {
      ok: true;
      channel: DispatchOtpChannel;
      maskedPhone: string;
      sendCount: number;
      expiresAt: Date;
      /** Only in dev with no provider configured. */
      devOtp?: string;
    }
  | { ok: false; status: number; error: string; retryAfterMs?: number };

/**
 * Mint (or refresh) the dispatch OTP and deliver it.
 *
 * `prefer: "whatsapp"` puts WhatsApp at the head of the ladder. It falls through
 * to voice/SMS when the send fails, because a customer who cannot receive the
 * code cannot take delivery — silently succeeding here would strand them.
 */
export async function sendDispatchOtp(opts: {
  leadId: string;
  prefer?: DispatchOtpChannel;
}): Promise<SendDispatchOtpResult> {
  const { leadId } = opts;
  const now = new Date();

  const [lead] = await db
    .select({
      id: leads.id,
      kyc_status: leads.kyc_status,
      phone: leads.phone,
      mobile: leads.mobile,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead) return { ok: false, status: 404, error: "Lead not found" };
  if (lead.kyc_status !== "loan_sanctioned") {
    return {
      ok: false,
      status: 409,
      error: "This loan is not sanctioned yet, so dispatch cannot start.",
    };
  }

  const phone = lead.phone || lead.mobile || "";
  if (!phone) {
    return { ok: false, status: 400, error: "No customer phone number on file" };
  }

  const [existing] = await db
    .select()
    .from(otpConfirmations)
    .where(
      and(
        eq(otpConfirmations.lead_id, leadId),
        eq(otpConfirmations.otp_type, "dispatch_confirmation"),
        eq(otpConfirmations.is_used, false),
      ),
    )
    .orderBy(desc(otpConfirmations.created_at))
    .limit(1);

  // Max sends reached → 30-minute cooldown before a NEW session may begin.
  if (existing && (existing.send_count ?? 0) >= MAX_SENDS) {
    const since = now.getTime() - new Date(existing.created_at!).getTime();
    if (since < COOLDOWN_MS) {
      return {
        ok: false,
        status: 429,
        error: "Too many codes sent. Please try again in a little while.",
        retryAfterMs: COOLDOWN_MS - since,
      };
    }
  }

  const providerConfigured =
    twoFactorConfigured() ||
    !!(process.env.MSG91_AUTH_KEY?.trim() && process.env.MSG91_TEMPLATE_ID?.trim()) ||
    opts.prefer === "whatsapp";
  const otp = providerConfigured
    ? Math.floor(100000 + Math.random() * 900000).toString()
    : "123456";
  const expiresAt = new Date(now.getTime() + OTP_LIFETIME_MS);

  const reuse =
    existing && (existing.send_count ?? 0) < MAX_SENDS ? existing : null;
  const sendCount = reuse ? (reuse.send_count ?? 0) + 1 : 1;
  const otpRecordId = reuse ? reuse.id : await generateId("OTP");

  if (reuse) {
    await db
      .update(otpConfirmations)
      .set({
        otp_hash: hashOtp(otp),
        expires_at: expiresAt,
        send_count: sendCount,
        // A fresh code restarts the attempt budget; otherwise a customer who
        // fat-fingered the previous one is locked out of the new one.
        attempt_count: 0,
        phone_sent_to: phone,
      })
      .where(eq(otpConfirmations.id, reuse.id));
  } else {
    await db.insert(otpConfirmations).values({
      id: otpRecordId,
      lead_id: leadId,
      otp_type: "dispatch_confirmation",
      otp_hash: hashOtp(otp),
      phone_sent_to: phone,
      created_at: now,
      expires_at: expiresAt,
      send_count: sendCount,
      attempt_count: 0,
      is_used: false,
    });
  }

  const channel = await deliver(opts.prefer, phone, otp);

  if (!channel) {
    return {
      ok: false,
      status: 502,
      error: "We couldn't deliver the code. Please try again.",
    };
  }

  return {
    ok: true,
    channel,
    maskedPhone: maskPhone(phone),
    sendCount,
    expiresAt,
    devOtp: channel === "dev" ? otp : undefined,
  };
}

/** Try the preferred wire first, then the standing ladder. Null = all failed. */
async function deliver(
  prefer: DispatchOtpChannel | undefined,
  phone: string,
  otp: string,
): Promise<DispatchOtpChannel | null> {
  if (prefer === "whatsapp") {
    try {
      const { sendDispatchOtpWhatsApp } = await import(
        "@/lib/whatsapp/dispatch-otp-send"
      );
      if (await sendDispatchOtpWhatsApp(phone, otp)) return "whatsapp";
    } catch (err) {
      console.error("[dispatch-otp] WhatsApp send failed:", err);
    }
  }

  if (twoFactorConfigured()) {
    const call = await sendTwoFactorVoiceOtp({ mobile_number: phone, otp });
    if (call.success) return "call";
    console.error("[dispatch-otp] voice call failed:", call.error);
  }

  if (process.env.MSG91_AUTH_KEY?.trim() && process.env.MSG91_TEMPLATE_ID?.trim()) {
    const sms = await sendMsg91Otp({
      mobile_number: phone,
      otp,
      otp_expiry_minutes: Math.floor(OTP_LIFETIME_MS / 60000),
    });
    if (sms.success) return "sms";
    console.error("[dispatch-otp] SMS failed:", sms.error);
  }

  // No provider at all — the hardcoded-OTP dev path the route has always had.
  if (process.env.NODE_ENV !== "production") {
    console.log(`[dispatch-otp] DEV plaintext OTP: ${otp}`);
    return "dev";
  }
  return null;
}

export type VerifyDispatchOtpResult =
  | { ok: true }
  | { ok: false; status: number; error: string; attemptsLeft?: number };

/** Max wrong guesses before the session is locked. */
export const MAX_ATTEMPTS = 3;
const LOCK_MS = 5 * 60 * 1000;

/**
 * Check the code WITHOUT consuming it.
 *
 * Deliberately non-consuming, exactly as the existing verify-otp route is:
 * confirm-dispatch re-checks and consumes the row inside the dispatch
 * transaction, so that the code cannot be spent by a check that then fails to
 * move any stock.
 */
export async function verifyDispatchOtp(opts: {
  leadId: string;
  otp: string;
}): Promise<VerifyDispatchOtpResult> {
  const now = new Date();
  const [row] = await db
    .select()
    .from(otpConfirmations)
    .where(
      and(
        eq(otpConfirmations.lead_id, opts.leadId),
        eq(otpConfirmations.otp_type, "dispatch_confirmation"),
        eq(otpConfirmations.is_used, false),
      ),
    )
    .orderBy(desc(otpConfirmations.created_at))
    .limit(1);

  if (!row) {
    return { ok: false, status: 404, error: "No active code. Please request a new one." };
  }
  if (row.locked_until && new Date(row.locked_until) > now) {
    return { ok: false, status: 429, error: "Too many wrong attempts. Please wait a few minutes." };
  }
  if (row.expires_at && new Date(row.expires_at) < now) {
    return { ok: false, status: 410, error: "That code has expired. Please request a new one." };
  }

  if (hashOtp(opts.otp) !== row.otp_hash) {
    const attempts = (row.attempt_count ?? 0) + 1;
    const locked = attempts >= MAX_ATTEMPTS;
    await db
      .update(otpConfirmations)
      .set({
        attempt_count: attempts,
        locked_until: locked ? new Date(now.getTime() + LOCK_MS) : null,
      })
      .where(eq(otpConfirmations.id, row.id));
    return {
      ok: false,
      status: 400,
      error: locked
        ? "Too many wrong attempts. Please wait a few minutes and request a new code."
        : "That code didn't match.",
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts),
    };
  }

  return { ok: true };
}
