export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import {
  sendConsentForLead,
  type ConsentFor,
} from "@/lib/kyc/consent-service";

type RouteContext = {
  params: Promise<{ leadId: string }>;
};

// Thin wrapper: authenticate, resolve dealer name, then delegate to the shared
// consent service (src/lib/kyc/consent-service.ts) so the web portal and the
// WhatsApp chatbot drive identical e-sign logic.
export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(["dealer", "admin", "ceo", "sales_head"]);
    const { leadId } = await params;
    const body = await req.json().catch(() => ({}));
    const channel = String(body?.channel || "sms").toLowerCase();

    if (!["sms", "whatsapp"].includes(channel)) {
      return NextResponse.json(
        { success: false, error: { message: "Channel must be sms or whatsapp" } },
        { status: 400 }
      );
    }

    let dealerName = "";
    if (user.id) {
      const userRows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (userRows.length) dealerName = userRows[0].name || "";
    }

    const result = await sendConsentForLead({
      leadId,
      channel: channel as "sms" | "whatsapp",
      consentFor: (body?.consent_for as ConsentFor) ?? "customer",
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

