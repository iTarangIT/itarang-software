/**
 * GET /api/lead/[id]/offers
 *
 * BRD Addendum V0.2 §6.1 — the dealer-facing view of the firm financing offers
 * submitted by the NBFCs the customer picked in Section G. Drives the
 * compare-and-pick-winner screen (POST /api/lead/[id]/select-winner).
 *
 * Returns one row per routed NBFC with its assignment status and submitted
 * offer (null until that NBFC submits). Role: dealer (owns this lead).
 *
 * The read itself lives in `src/lib/leads/offers.ts` so the WhatsApp offer flow
 * shows the customer exactly what this shows the dealer — including the E-161
 * filter that withholds a CEO-held offer.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { listLeadOffers } from "@/lib/leads/offers";
import { ACT_FOR_DEALER_ROLES } from "@/lib/leads/actForDealer";
import { gateLeadActor } from "@/lib/leads/actForDealerGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(["dealer", ...ACT_FOR_DEALER_ROLES]);
    const { id: leadId } = await params;

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    }
    // ID 183: the dealer, the house, or Admin / Sales Head acting for the dealer.
    const gate = await gateLeadActor(user, lead);
    if (!gate.ok) {
      return NextResponse.json({ success: false, error: { message: gate.message } }, { status: gate.status });
    }

    const data = await listLeadOffers(leadId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load offers";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
