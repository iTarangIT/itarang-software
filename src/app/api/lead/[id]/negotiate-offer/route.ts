/**
 * POST /api/lead/[id]/negotiate-offer
 *
 * E-238 — the dealer (customer-present) counters an NBFC's firm financing offer
 * with specific proposed terms plus a note, instead of the previous
 * take-it-or-leave-it choice between `Select as winner` and nothing.
 *
 * This is an extension beyond Addendum V0.3.1 §13.3.1, which specifies a single
 * firm offer with no back-and-forth. It is layered AROUND nbfc_financing_offers
 * rather than changing what a firm offer means: the offer row still holds one
 * set of current terms, and every round of the conversation is appended to
 * nbfc_offer_negotiations. Winner selection (§14.2) is untouched — a dealer may
 * accept the standing offer at any point, including mid-negotiation.
 *
 * Role: dealer, owning this lead. Body: { nbfcId, <any of the six terms>, message }.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  leads,
  nbfc,
  nbfcAuditLog,
  nbfcFinancingOffers,
  nbfcLeadAssignments,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  MAX_MESSAGE_LENGTH,
  MAX_NEGOTIATION_ROUNDS,
  NEGOTIABLE_FIELDS,
  appendRound,
  sameTerm,
  seedOpeningRoundIfMissing,
} from "@/lib/nbfc/offer-negotiation";
import { notifyOfferNegotiated } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const numeric = z.union([z.number(), z.string()]).optional().nullable();

const Body = z.object({
  nbfcId: z.union([z.number(), z.string()]),
  loan_amount: numeric,
  roi_pct: numeric,
  emi_amount: numeric,
  tenure_months: numeric,
  down_payment: numeric,
  processing_fee: numeric,
  message: z.string().max(MAX_MESSAGE_LENGTH).optional().nullable(),
});

const bad = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: { message } }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return bad("Invalid JSON");
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return bad(parsed.error.issues[0]?.message ?? "Invalid request");
    }
    const d = parsed.data;
    const nbfcId = Number(d.nbfcId);
    if (!Number.isFinite(nbfcId)) return bad("nbfcId required");

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) return bad("Lead not found", 404);
    if (lead.dealer_id !== user.dealer_id) return bad("Access denied", 403);

    const [assignment] = await db
      .select({
        id: nbfcLeadAssignments.id,
        nbfc_id: nbfcLeadAssignments.nbfc_id,
        tenant_id: nbfcLeadAssignments.tenant_id,
        status: nbfcLeadAssignments.status,
      })
      .from(nbfcLeadAssignments)
      .where(
        and(
          eq(nbfcLeadAssignments.lead_id, leadId),
          eq(nbfcLeadAssignments.nbfc_id, nbfcId),
        ),
      )
      .limit(1);
    if (!assignment) return bad("That NBFC is not among this lead's routed NBFCs");
    if (assignment.status === "selected" || assignment.status === "not_selected") {
      return bad("A winner has already been decided for this lead; the offer is closed.");
    }

    const [offer] = await db
      .select()
      .from(nbfcFinancingOffers)
      .where(eq(nbfcFinancingOffers.assignment_id, assignment.id))
      .limit(1);
    if (!offer) return bad("That NBFC has not submitted a firm offer yet.");

    // Mirrors the E-161 release filter in GET /api/lead/[id]/offers — a dealer
    // cannot counter terms it is not allowed to see.
    if (
      offer.ceo_approval_status !== "not_required" &&
      offer.ceo_approval_status !== "approved"
    ) {
      return bad("These revised terms are still under iTarang review. Try again once they are released.");
    }
    if (offer.negotiation_status === "fixed") {
      return bad("The NBFC has fixed these terms; they can no longer be negotiated.");
    }
    if (offer.negotiation_round >= MAX_NEGOTIATION_ROUNDS) {
      return bad(
        `This negotiation has reached ${MAX_NEGOTIATION_ROUNDS} rounds. Ask the NBFC to fix the terms, or select a lender.`,
      );
    }

    // A counter has to actually say something: either move a number or carry a
    // message. Without this an empty submit would burn a round and notify the
    // NBFC about nothing.
    const asks: Record<string, string | number | null> = {};
    let movedAny = false;
    for (const f of NEGOTIABLE_FIELDS) {
      const v = d[f];
      if (v == null || String(v).trim() === "") continue;
      if (Number.isNaN(Number(v))) return bad(`${f} must be a number`);
      asks[f] = f === "tenure_months" ? Number(v) : String(v);
      if (!sameTerm(offer[f], asks[f] as string | number)) movedAny = true;
    }
    const message = d.message?.trim() ?? "";
    if (!movedAny && message === "") {
      return bad("Change at least one term or add a message before sending a counter-offer.");
    }

    const now = new Date();
    const before = Object.fromEntries(NEGOTIABLE_FIELDS.map((f) => [f, offer[f]]));

    await db.transaction(async (tx) => {
      // Offers predating E-238 have no round 1 on record; seed it from the
      // current terms so the history starts where the conversation did.
      const base = await seedOpeningRoundIfMissing(tx, offer);
      const round = base + 1;

      await appendRound(tx, {
        offer_id: offer.id,
        assignment_id: assignment.id,
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        tenant_id: assignment.tenant_id,
        round,
        party: "dealer",
        kind: "counter",
        // Unmoved fields carry the standing value, so a round is always a full
        // snapshot and can be read on its own years later.
        terms: { ...before, ...asks },
        message: message || null,
        created_by: user.id,
        created_at: now,
      });

      // Guarded on the round we read: if another writer moved first, this
      // matches zero rows and the appendRound above has already collided with
      // the UNIQUE index, rolling the whole transaction back.
      await tx
        .update(nbfcFinancingOffers)
        .set({
          negotiation_status: "dealer_countered",
          negotiation_round: round,
          updated_at: now,
        })
        .where(
          and(
            eq(nbfcFinancingOffers.id, offer.id),
            eq(nbfcFinancingOffers.negotiation_round, offer.negotiation_round),
          ),
        );

      // Audit inside the transaction, per every other nbfc_audit_log writer
      // (src/lib/nbfc/recovery/stages.ts is the canonical example).
      await tx.insert(nbfcAuditLog).values({
        tenant_id: assignment.tenant_id,
        user_id: user.id,
        action_type: "offer_negotiate",
        action_id: offer.id,
        before_state: { lead_id: leadId, nbfc_id: assignment.nbfc_id, round: base, terms: before },
        after_state: {
          lead_id: leadId,
          nbfc_id: assignment.nbfc_id,
          round,
          terms: { ...before, ...asks },
          message: message || null,
        },
        created_at: now,
      });
    });

    // Best-effort, outside the transaction — matches how select-winner handles
    // its notification side effects.
    try {
      const [row] = await db
        .select({ legal_name: nbfc.legal_name, short_name: nbfc.short_name })
        .from(nbfc)
        .where(eq(nbfc.id, nbfcId))
        .limit(1);
      await notifyOfferNegotiated({
        leadId,
        nbfcTenantId: assignment.tenant_id,
        nbfcName: row?.short_name || row?.legal_name || "the lender",
        asks: Object.fromEntries(
          Object.entries(asks).filter(([f]) => !sameTerm(before[f] ?? null, asks[f])),
        ),
        message: message || null,
      });
    } catch (err) {
      console.error("[negotiate-offer] notification failed:", err);
    }

    return NextResponse.json({
      success: true,
      data: { leadId, nbfcId, negotiationStatus: "dealer_countered" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send counter-offer";
    console.error("[negotiate-offer] error:", error);
    // requireRole throws a ForbiddenError carrying its own status; honour it
    // rather than flattening an auth failure into a 500.
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? ((error as { status: number }).status)
        : 500;
    return NextResponse.json({ success: false, error: { message } }, { status });
  }
}
