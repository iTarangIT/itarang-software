/**
 * POST /api/lead/[id]/select-winner
 *
 * BRD Addendum V0.2 §6.1 / §6.2 — the customer (dealer-mediated) compares the
 * firm offers submitted by the picked NBFCs and selects the WINNER. The chosen
 * assignment becomes 'selected'; every other assignment for the lead becomes
 * 'not_selected' and its NBFC is notified (§6.2 "loser auto Not Selected; owner
 * notified"). The lead advances to 'awaiting_enach' so the winner-only E-NACH
 * track (enach.getWinningAssignment, status='selected') unlocks.
 *
 * The 1-NBFC case is the same path: accepting the single offer = selecting it.
 *
 * Role: dealer (customer-present). Body: { nbfcId: number }.
 *
 * The write lives in `src/lib/leads/select-winner.ts` — a customer accepts the
 * same offer from their WhatsApp chat, and both must close out the losing
 * lenders the same way.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { OfferActionError } from "@/lib/leads/negotiate-offer";
import { selectOfferWinner } from "@/lib/leads/select-winner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    let body: { nbfcId?: number | string } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: { message: "Invalid JSON" } }, { status: 400 });
    }
    const chosenNbfcId = Number(body.nbfcId);
    if (!Number.isFinite(chosenNbfcId)) {
      return NextResponse.json({ success: false, error: { message: "nbfcId required" } }, { status: 400 });
    }

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json({ success: false, error: { message: "Access denied" } }, { status: 403 });
    }

    const result = await selectOfferWinner({ leadId, nbfcId: chosenNbfcId });

    return NextResponse.json({
      success: true,
      data: {
        leadId: result.leadId,
        winnerNbfcId: result.winnerNbfcId,
        kycStatus: result.kycStatus,
      },
    });
  } catch (error) {
    if (error instanceof OfferActionError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to select winner";
    console.error("[select-winner] error:", error);
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
