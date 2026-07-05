export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import {
  sendConsentForLead,
  sendConsentOtp,
  type ConsentFor,
  type ConsentOtpChannel,
} from "@/lib/kyc/consent-service";

type RouteContext = {
  params: Promise<{ leadId: string }>;
};

// OTP-based consent is the active mechanism (E-180). CONSENT_OTP_ENABLED defaults
// ON — set it to "0" to fall back to the dormant Digio Aadhaar e-sign path (for
// in-flight Digio consents / instant rollback). A request may also force a path
// with body.method = "otp" | "digio".
function resolveConsentMethod(bodyMethod: unknown): "otp" | "digio" {
  const forced = String(bodyMethod || "").toLowerCase();
  if (forced === "otp" || forced === "digio") return forced;
  return process.env.CONSENT_OTP_ENABLED === "0" ? "digio" : "otp";
}

// Thin wrapper: authenticate, resolve dealer name, then delegate to the shared
// consent service (src/lib/kyc/consent-service.ts) so the web portal and the
// WhatsApp chatbot drive identical consent logic.
export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(["dealer", "admin", "ceo", "sales_head"]);
    const { leadId } = await params;
    const body = await req.json().catch(() => ({}));
    const channel = String(body?.channel || "call").toLowerCase();

    if (!["call", "sms", "whatsapp"].includes(channel)) {
      return NextResponse.json(
        { success: false, error: { message: "Channel must be call, sms or whatsapp" } },
        { status: 400 }
      );
    }

    let dealerName = "";
    if (user.id) {
      const userRows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (userRows.length) dealerName = userRows[0].name || "";
    }

    const consentFor = (body?.consent_for as ConsentFor) ?? "customer";

    // ── OTP consent (default) ────────────────────────────────────────────────
    if (resolveConsentMethod(body?.method) === "otp") {
      const otpResult = await sendConsentOtp({
        leadId,
        channel: channel as ConsentOtpChannel,
        consentFor,
        dealerName,
        requestedBy: user.id ?? null,
      });

      if (!otpResult.ok) {
        return NextResponse.json(
          { success: false, error: { message: otpResult.error } },
          { status: otpResult.status }
        );
      }

      return NextResponse.json({
        success: true,
        hasDigioIntegration: false,
        data: {
          consentId: otpResult.consentId,
          leadId,
          channel: otpResult.channel,
          phone: otpResult.phone,
          otpSentTo: otpResult.otpSentTo,
          previewUrl: otpResult.previewUrl,
          expiresInSeconds: otpResult.expiresInSeconds,
          sendCount: otpResult.sendCount,
          maxSends: otpResult.maxSends,
          deliveryStatus: otpResult.deliveryStatus,
          message: `Consent OTP sent to ${otpResult.otpSentTo} via ${otpResult.channel}. Ask the customer to read it out.`,
          ...(otpResult.devOtp ? { _devOtp: otpResult.devOtp } : {}),
        },
      });
    }

    // ── Legacy Digio Aadhaar e-sign (dormant; CONSENT_OTP_ENABLED=0) ──────────
    // Digio only supports sms/whatsapp delivery — coerce the new 'call' channel.
    const result = await sendConsentForLead({
      leadId,
      channel: channel === "whatsapp" ? "whatsapp" : "sms",
      consentFor,
      dealerName,
    });

    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      alreadyActive: result.alreadyActive,
      replaced: result.replaced,
      hasDigioIntegration: true,
      data: {
        consentId: result.consentId,
        leadId,
        channel: result.channel,
        phone: result.phone,
        customerSigningUrl: result.customerSigningUrl,
        digioDocumentId: result.digioDocumentId,
        sentAt: result.sentAt,
        message: result.alreadyActive
          ? "An active consent already exists for this lead — reusing the existing link instead of creating a duplicate."
          : `Consent form sent via DigiO. Signing link delivered to ${result.phone}.`,
      },
    });
  } catch (error: any) {
    console.error("[Send Consent] Error:", error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}

