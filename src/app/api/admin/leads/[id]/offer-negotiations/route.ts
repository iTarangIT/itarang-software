/**
 * GET /api/admin/leads/[id]/offer-negotiations
 *
 * E-238 — read-only admin view of every dealer <-> NBFC negotiation thread on a
 * lead, for the admin KYC review screen. iTarang can see what was actually
 * agreed before the sanction; it does not post into the thread.
 *
 * Unlike the dealer route this does NOT apply the E-161 release filter to the
 * current terms — an admin is allowed to see an offer parked for iTarang CEO
 * approval, and seeing it is rather the point. The ROUNDS are the same rows the
 * dealer sees either way, since a round is only written once released.
 *
 * Role: admin / ceo / business_head, matching the other admin KYC routes.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfc, nbfcFinancingOffers, nbfcLeadAssignments } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { listRoundsForOffers } from "@/lib/nbfc/offer-negotiation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(["admin", "ceo", "business_head"]);
    const { id: leadId } = await params;

    const assignments = await db
      .select({
        id: nbfcLeadAssignments.id,
        nbfc_id: nbfcLeadAssignments.nbfc_id,
        status: nbfcLeadAssignments.status,
      })
      .from(nbfcLeadAssignments)
      .where(eq(nbfcLeadAssignments.lead_id, leadId));

    if (assignments.length === 0) {
      return NextResponse.json({ success: true, data: { leadId, items: [] } });
    }

    const nbfcIds = assignments.map((a) => a.nbfc_id);
    const nbfcRows = await db
      .select({ id: nbfc.id, nbfc_id_code: nbfc.nbfc_id, short_name: nbfc.short_name, legal_name: nbfc.legal_name })
      .from(nbfc)
      .where(inArray(nbfc.id, nbfcIds));
    const nameById = new Map(nbfcRows.map((r) => [r.id, r] as const));

    // Scoped by lead_id too — nbfc_id alone would pull that lender's offers on
    // every other lead, whose rounds are none of this screen's business.
    const offerRows = await db
      .select()
      .from(nbfcFinancingOffers)
      .where(
        and(
          eq(nbfcFinancingOffers.lead_id, leadId),
          inArray(nbfcFinancingOffers.nbfc_id, nbfcIds),
        ),
      );
    const offerByAssignment = new Map(offerRows.map((o) => [o.assignment_id, o] as const));

    const roundRows = await listRoundsForOffers(
      db,
      offerRows.map((o) => o.id),
    );
    const roundsByOffer = new Map<string, typeof roundRows>();
    for (const r of roundRows) {
      const list = roundsByOffer.get(r.offer_id);
      if (list) list.push(r);
      else roundsByOffer.set(r.offer_id, [r]);
    }

    const items = assignments
      .map((a) => {
        const offer = offerByAssignment.get(a.id) ?? null;
        return {
          nbfc_id: a.nbfc_id,
          nbfc_id_code: nameById.get(a.nbfc_id)?.nbfc_id_code ?? null,
          nbfc_short_name: nameById.get(a.nbfc_id)?.short_name ?? null,
          nbfc_legal_name: nameById.get(a.nbfc_id)?.legal_name ?? null,
          status: a.status,
          negotiation_status: offer?.negotiation_status ?? null,
          fixed_at: offer?.fixed_at ?? null,
          ceo_approval_status: offer?.ceo_approval_status ?? null,
          negotiation: offer ? (roundsByOffer.get(offer.id) ?? []) : [],
        };
      })
      // An NBFC that never got past round 1 has nothing to review here; the
      // current terms are already on the KYC screen's own offer card.
      .filter((i) => i.negotiation.length > 1);

    return NextResponse.json({ success: true, data: { leadId, items } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load negotiations";
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? ((error as { status: number }).status)
        : 500;
    return NextResponse.json({ success: false, error: { message } }, { status });
  }
}
