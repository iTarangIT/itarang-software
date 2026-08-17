/**
 * POST /api/lead/[id]/negotiate-offer
 *
 * E-238 — the dealer (customer-present) asks an NBFC to revise its firm
 * financing offer, instead of the previous take-it-or-leave-it choice between
 * `Select as winner` and nothing.
 *
 * E-245 — the ask is now a MESSAGE, not a set of numbers. The dealer is not the
 * party that prices a loan; six editable term fields invited asks the lender
 * could not act on and produced rounds whose "diff" was noise. The dealer says
 * what they need in words, the NBFC re-prices and resubmits, and the numbers
 * only ever move on the lender's side. The round still stores a FULL snapshot of
 * the standing terms so the history stays self-describing.
 *
 * This is an extension beyond Addendum V0.3.1 §13.3.1, which specifies a single
 * firm offer with no back-and-forth. It is layered AROUND nbfc_financing_offers
 * rather than changing what a firm offer means: the offer row still holds one
 * set of current terms, and every round of the conversation is appended to
 * nbfc_offer_negotiations. Winner selection (§14.2) is untouched — a dealer may
 * accept the standing offer at any point, including mid-negotiation.
 *
 * Role: dealer, owning this lead. Body: { nbfcId, message }.
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
  isAssignmentDecided,
  seedOpeningRoundIfMissing,
} from "@/lib/nbfc/offer-negotiation";
import { notifyOfferNegotiated } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  nbfcId: z.union([z.number(), z.string()]),
  // Required since E-245 — the message IS the counter now, so an empty one has
  // nothing to send. Trimmed before the length check so whitespace can't pass.
  message: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, "Write a message to the NBFC before sending.")
        .max(MAX_MESSAGE_LENGTH),
    ),
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
    if (isAssignmentDecided(assignment.status)) {
      return bad(
        assignment.status === "withdrawn"
          ? "You closed this deal; it can no longer be negotiated."
          : "A winner has already been decided for this lead; the offer is closed.",
      );
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

    const message = d.message;
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
        // The dealer moves no numbers (E-245), so the round carries the standing
        // terms verbatim — a round is always a full snapshot and can be read on
        // its own years later. The thread renders it as "no change to the terms"
        // plus the message, which is exactly what happened.
        terms: before,
        message,
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
          terms: before,
          message,
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
        message,
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
