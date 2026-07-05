export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { renderConsentPreviewPdf, type ConsentFor } from "@/lib/kyc/consent-service";

type RouteContext = {
  params: Promise<{ leadId: string }>;
};

// Lazily render the (unsigned) consent PDF so the dealer/customer can review it
// before recording consent — used by the small "View consent form" card. No DB
// write; returns a public URL to the rendered PDF. E-180.
export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(["dealer", "admin", "ceo", "sales_head"]);
    const { leadId } = await params;
    const consentFor = (req.nextUrl.searchParams.get("consent_for") as ConsentFor) ?? "customer";

    let dealerName = "";
    if (user.id) {
      const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (rows.length) dealerName = rows[0].name || "";
    }

    const preview = await renderConsentPreviewPdf({ leadId, consentFor, dealerName });
    if (!preview.ok) {
      return NextResponse.json(
        { success: false, error: { message: preview.error } },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true, data: { url: preview.url } });
  } catch (error: any) {
    console.error("[Consent Preview] Error:", error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
