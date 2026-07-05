export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { verifyConsentOtp, type ConsentFor } from "@/lib/kyc/consent-service";

type RouteContext = {
  params: Promise<{ leadId: string }>;
};

const bodySchema = z.object({
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
  consent_for: z.enum(["customer", "borrower"]).optional(),
});

// Thin wrapper: authenticate, then delegate to verifyConsentOtp (shared with the
// WhatsApp chatbot). On success the consent auto-completes to 'verified' — no
// admin consent-review step (see consent-service.ts). E-180.
export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(["dealer", "admin", "ceo", "sales_head"]);
    const { leadId } = await params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: parsed.error.issues[0]?.message ?? "Invalid request" } },
        { status: 400 }
      );
    }

    const result = await verifyConsentOtp({
      leadId,
      otp: parsed.data.otp,
      consentFor: (parsed.data.consent_for as ConsentFor) ?? "customer",
      verifiedBy: user.id ?? null,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          success: false,
          error: { message: result.error },
          ...(result.attemptsRemaining !== undefined
            ? { data: { attemptsRemaining: result.attemptsRemaining } }
            : {}),
        },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        consentId: result.consentId,
        leadId,
        consentStatus: result.consentStatus,
        verifiedAt: result.verifiedAt,
      },
    });
  } catch (error: any) {
    console.error("[Verify Consent OTP] Error:", error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
