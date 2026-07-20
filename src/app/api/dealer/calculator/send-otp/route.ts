import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";

import { db } from "@/lib/db";
import { calcOtpVerifications } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { isNextRedirectError } from "@/lib/api-utils";
import {
  maskCalcPhone,
  metaWhatsAppConfigured,
  normalizeCalcPhone,
  sendCalcOtpWhatsApp,
} from "@/lib/calculator/whatsapp";
import { sendTwoFactorVoiceOtp, twoFactorConfigured } from "@/lib/twofactor";

// Calculator OTP gate — send. The dealer enters the customer's details; before
// schemes are shown, a 6-digit OTP is delivered to the customer and must be
// verified (verify-otp). Delivery preference: 2Factor VOICE CALL first (the
// customer hears the OTP read out on an automated phone call), then WhatsApp,
// then a dev/hardcoded fallback. Mechanics mirror the Step 5 dispatch OTP:
// SHA-256 hash, 10-min expiry, max 3 sends per session, 30-min cooldown after.

export const dynamic = "force-dynamic";

const OTP_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SENDS = 3;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes after max sends

const bodySchema = z.object({
  customerName: z.string().min(1, "Customer name is required"),
  phone: z.string().min(5, "Phone is required"),
});

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole(["dealer"]);
    const body = bodySchema.parse(await req.json());

    const phone = normalizeCalcPhone(body.phone);
    if (!phone) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Enter a valid 10-digit Indian mobile number.", code: "invalid_phone" },
        },
        { status: 400 },
      );
    }

    // Latest open OTP session for this dealer-user + phone — same row is
    // reused (send_count bumped) until MAX_SENDS is hit.
    const [existing] = await db
      .select()
      .from(calcOtpVerifications)
      .where(
        and(
          eq(calcOtpVerifications.createdBy, user.id),
          eq(calcOtpVerifications.phone, phone),
          isNull(calcOtpVerifications.verifiedAt),
          isNull(calcOtpVerifications.consumedAt),
        ),
      )
      .orderBy(desc(calcOtpVerifications.createdAt))
      .limit(1);

    const now = new Date();
    let session = existing;
    if (session && session.sendCount >= MAX_SENDS) {
      const cutoff = new Date(session.createdAt.getTime() + COOLDOWN_MS);
      if (now < cutoff) {
        const waitMins = Math.ceil((cutoff.getTime() - now.getTime()) / 60000);
        return NextResponse.json(
          {
            success: false,
            error: {
              message: `Max OTP resends reached. Please wait ${waitMins} min before trying again.`,
              code: "cooldown",
            },
          },
          { status: 429 },
        );
      }
      // Cooldown elapsed — close this session and start fresh below.
      await db
        .update(calcOtpVerifications)
        .set({ consumedAt: now })
        .where(eq(calcOtpVerifications.id, session.id));
      session = undefined;
    }

    // Same dev shortcut as Step 5: without a live provider we use a hardcoded
    // OTP so the flow is testable end-to-end; verification still hash-compares
    // through the exact production code path.
    const twofactorConfigured = twoFactorConfigured();
    const waConfigured = metaWhatsAppConfigured();
    const providerConfigured = twofactorConfigured || waConfigured;
    const otp = providerConfigured
      ? Math.floor(100000 + Math.random() * 900000).toString()
      : "123456";
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(now.getTime() + OTP_LIFETIME_MS);

    // Delivery channel surfaced to the UI so the copy matches the wire used.
    let deliveryStatus: "voice_call" | "whatsapp" | "dev_hardcoded" = "dev_hardcoded";
    // Persisted status column keeps its existing vocabulary.
    let waStatus: "sent" | "dev_hardcoded" | "failed" = "dev_hardcoded";

    if (twofactorConfigured) {
      // Primary: 2Factor places an automated phone call reading the OTP aloud.
      const call = await sendTwoFactorVoiceOtp({ mobile_number: phone, otp });
      if (!call.success) {
        if (session) {
          await db
            .update(calcOtpVerifications)
            .set({ sendCount: session.sendCount + 1, waStatus: "failed" })
            .where(eq(calcOtpVerifications.id, session.id));
        }
        return NextResponse.json(
          {
            success: false,
            error: {
              message: `Voice OTP call failed: ${call.error || "unknown error"}`,
              code: "voice_failed",
            },
          },
          { status: 502 },
        );
      }
      deliveryStatus = "voice_call";
      waStatus = "sent";
    } else if (waConfigured) {
      const res = await sendCalcOtpWhatsApp(phone, otp, body.customerName);
      if (!res.ok) {
        // Record the failed attempt on the session (if any) so send_count still counts.
        if (session) {
          await db
            .update(calcOtpVerifications)
            .set({ sendCount: session.sendCount + 1, waStatus: "failed" })
            .where(eq(calcOtpVerifications.id, session.id));
        }
        return NextResponse.json(
          {
            success: false,
            error: {
              message: `WhatsApp delivery failed: ${res.error || "unknown error"}`,
              code: "wa_failed",
            },
          },
          { status: 502 },
        );
      }
      deliveryStatus = "whatsapp";
      waStatus = "sent";
    } else {
      console.log(
        `[Calculator Send OTP] No OTP provider configured — using hardcoded OTP ${otp} for ${maskCalcPhone(phone)}. Set TWOFACTOR_API_KEY (voice call) or Meta WhatsApp creds to switch to live delivery.`,
      );
    }

    if (session) {
      await db
        .update(calcOtpVerifications)
        .set({
          otpHash,
          expiresAt,
          customerName: body.customerName,
          sendCount: session.sendCount + 1,
          attemptCount: 0,
          lockedUntil: null,
          waStatus,
        })
        .where(eq(calcOtpVerifications.id, session.id));
    } else {
      await db.insert(calcOtpVerifications).values({
        createdBy: user.id,
        dealerId: user.dealer_id ?? null,
        phone,
        customerName: body.customerName,
        otpHash,
        expiresAt,
        sendCount: 1,
        attemptCount: 0,
        waStatus,
      });
    }

    const isDev = process.env.NODE_ENV !== "production";
    return NextResponse.json({
      success: true,
      data: {
        otpSentTo: maskCalcPhone(phone),
        expiresInSeconds: Math.floor(OTP_LIFETIME_MS / 1000),
        sendCount: session ? session.sendCount + 1 : 1,
        maxSends: MAX_SENDS,
        deliveryStatus,
        waStatus,
        // Surface the OTP in dev / hardcoded mode so the tester (acting as
        // both dealer and customer) can complete the flow.
        ...(deliveryStatus === "dev_hardcoded" || isDev ? { _devOtp: otp } : {}),
      },
    });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: { message: error.issues[0]?.message ?? "Invalid request" } },
        { status: 400 },
      );
    }
    console.error("[Calculator Send OTP] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to send OTP";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
