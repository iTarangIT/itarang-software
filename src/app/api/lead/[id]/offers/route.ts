/**
 * GET /api/lead/[id]/offers
 *
 * BRD Addendum V0.2 §6.1 — the dealer-facing view of the firm financing offers
 * submitted by the NBFCs the customer picked in Section G. Drives the
 * compare-and-pick-winner screen (POST /api/lead/[id]/select-winner).
 *
 * Returns one row per routed NBFC with its assignment status and submitted
 * offer (null until that NBFC submits). Role: dealer (owns this lead).
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfc, nbfcFinancingOffers, nbfcLeadAssignments } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id, kyc_status: leads.kyc_status })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json({ success: false, error: { message: "Access denied" } }, { status: 403 });
    }

    const assignments = await db
      .select({
        id: nbfcLeadAssignments.id,
        nbfc_id: nbfcLeadAssignments.nbfc_id,
        status: nbfcLeadAssignments.status,
      })
      .from(nbfcLeadAssignments)
      .where(eq(nbfcLeadAssignments.lead_id, leadId));

    const nbfcIds = assignments.map((a) => a.nbfc_id);
    const nbfcRows = nbfcIds.length
      ? await db
          .select({ id: nbfc.id, short_name: nbfc.short_name, legal_name: nbfc.legal_name })
          .from(nbfc)
          .where(inArray(nbfc.id, nbfcIds))
      : [];
    const nameById = new Map(nbfcRows.map((r) => [r.id, r] as const));

    const offerRows = nbfcIds.length
      ? await db
          .select()
          .from(nbfcFinancingOffers)
          .where(inArray(nbfcFinancingOffers.nbfc_id, nbfcIds))
      : [];
    const offerByAssignment = new Map(offerRows.map((o) => [o.assignment_id, o] as const));

    const items = assignments.map((a) => ({
      nbfc_id: a.nbfc_id,
      nbfc_short_name: nameById.get(a.nbfc_id)?.short_name ?? null,
      nbfc_legal_name: nameById.get(a.nbfc_id)?.legal_name ?? null,
      status: a.status,
      offer: offerByAssignment.get(a.id) ?? null,
    }));

    const winner = assignments.find((a) => a.status === "selected") ?? null;

    return NextResponse.json({
      success: true,
      data: {
        leadId,
        kycStatus: lead.kyc_status,
        winnerNbfcId: winner?.nbfc_id ?? null,
        items,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load offers";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
