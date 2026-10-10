export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { renderConsentPreviewPdf, type ConsentFor } from "@/lib/kyc/consent-service";
import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";
import { isNextRedirectError } from "@/lib/api-utils";

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
    // ID 119: signed in AND this lead is the caller's (a dealer's own lead, or back office).
    const leadGate = await requireLeadAccess(leadId);
    if (!leadGate.ok) return leadGate.response;
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
    // requireRole() refuses a logged-out caller with a redirect; answer 401
    // like the other KYC routes instead of a 500 "NEXT_REDIRECT".
    if (isNextRedirectError(error)) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
    }
    console.error("[Consent Preview] Error:", error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
