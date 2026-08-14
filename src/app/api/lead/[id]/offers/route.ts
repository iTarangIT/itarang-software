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
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfc, nbfcFinancingOffers, nbfcLeadAssignments } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { listRoundsForOffers } from "@/lib/nbfc/offer-negotiation";

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
          .select({ id: nbfc.id, nbfc_id_code: nbfc.nbfc_id, short_name: nbfc.short_name, legal_name: nbfc.legal_name })
          .from(nbfc)
          .where(inArray(nbfc.id, nbfcIds))
      : [];
    const nameById = new Map(nbfcRows.map((r) => [r.id, r] as const));

    // Scoped by lead_id as well as nbfc_id. Matching on nbfc_id alone pulled in
    // that NBFC's offers on OTHER leads too — harmless for the offer lookup,
    // which re-keys by this lead's assignment ids, but E-238 reads negotiation
    // rounds off these rows and would otherwise fetch other leads' threads.
    const offerRows = nbfcIds.length
      ? await db
          .select()
          .from(nbfcFinancingOffers)
          .where(
            and(
              eq(nbfcFinancingOffers.lead_id, leadId),
              inArray(nbfcFinancingOffers.nbfc_id, nbfcIds),
            ),
          )
      : [];
    // E-161 — only surface RELEASED offers to the dealer. An out-of-band offer
    // held for iTarang CEO approval (pending) or rejected is withheld until
    // approved. Legacy rows default to 'not_required' → shown, as before.
    const released = offerRows.filter(
      (o) => o.ceo_approval_status === "not_required" || o.ceo_approval_status === "approved",
    );
    const offerByAssignment = new Map(released.map((o) => [o.assignment_id, o] as const));
    // Every offer row, released or not, keyed by assignment. Used only to tell a
    // withheld revision apart from "nothing submitted yet" — see revisionPending.
    const anyOfferByAssignment = new Map(offerRows.map((o) => [o.assignment_id, o] as const));

    // E-238 — the negotiation history. Read off ALL offer rows, not just the
    // released ones: mid-negotiation an NBFC revision can go out of band and get
    // held by E-161, and the dealer should not watch the thread they were part
    // of disappear while that sits with the iTarang CEO. This leaks nothing,
    // because a round is only ever written once its terms were released.
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

    const items = assignments.map((a) => {
      const offer = offerByAssignment.get(a.id) ?? null;
      const anyOffer = anyOfferByAssignment.get(a.id) ?? null;
      return {
        nbfc_id: a.nbfc_id,
        nbfc_id_code: nameById.get(a.nbfc_id)?.nbfc_id_code ?? null,
        nbfc_short_name: nameById.get(a.nbfc_id)?.short_name ?? null,
        nbfc_legal_name: nameById.get(a.nbfc_id)?.legal_name ?? null,
        status: a.status,
        offer,
        negotiation_status: offer?.negotiation_status ?? null,
        negotiation_round: offer?.negotiation_round ?? 0,
        fixed_at: offer?.fixed_at ?? null,
        negotiation: anyOffer ? (roundsByOffer.get(anyOffer.id) ?? []) : [],
        // The NBFC HAS submitted something the E-161 filter withheld — distinct
        // from offer === null, which means nothing was submitted at all. The two
        // reasons need different copy: 'pending' is waiting on iTarang, whereas
        // 'rejected' is waiting on the lender to re-price within band. Saying
        // "under iTarang review" for a rejection would point the dealer at the
        // wrong party.
        withheld_reason:
          anyOffer != null && offer == null ? (anyOffer.ceo_approval_status ?? null) : null,
      };
    });

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
