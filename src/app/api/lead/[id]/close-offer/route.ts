/**
 * POST /api/lead/[id]/close-offer
 *
 * E-245 — the dealer (customer-present) CLOSES the deal with one lender.
 *
 * This is the opposite of `select-winner`, not a variant of it: closing ends the
 * conversation with this NBFC and frees the lead to be routed to a different one
 * (see /api/lead/[id]/reselect-financing). Selecting a winner still means
 * accepting the terms.
 *
 * A close message is MANDATORY. The NBFC's only record of why it lost the lead
 * is what the dealer types here, and it is the payload of the notification the
 * lender receives — a close with no reason is the failure mode this endpoint
 * exists to prevent.
 *
 * NO MIGRATION IS REQUIRED for the values written here:
 *   - nbfc_lead_assignments.status 'withdrawn'  — already in the E-131 CHECK
 *   - nbfc_financing_offers.status 'withdrawn'  — already in the E-140 CHECK
 *   - negotiation_status 'closed' / kind 'close' — E-238 ships no CHECK on
 *     these on purpose (see its header, "WHY NO CHECK CONSTRAINTS").
 * This route is the FIRST writer of 'withdrawn' anywhere in the codebase.
 *
 * lead.kyc_status is deliberately untouched: the §12 dead-end / cash-conversion
 * path and the winner-only E-NACH track both key off it, and closing one of two
 * offers is not a statement about either.
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
  NEGOTIABLE_FIELDS,
  appendRound,
  isAssignmentDecided,
  seedOpeningRoundIfMissing,
} from "@/lib/nbfc/offer-negotiation";
import { notifyOfferClosed } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  nbfcId: z.union([z.number(), z.string()]),
  message: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, "Write a message to the NBFC before closing the deal.")
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
    const { message } = parsed.data;
    const nbfcId = Number(parsed.data.nbfcId);
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
        and(eq(nbfcLeadAssignments.lead_id, leadId), eq(nbfcLeadAssignments.nbfc_id, nbfcId)),
      )
      .limit(1);
    if (!assignment) return bad("That NBFC is not among this lead's routed NBFCs");
    if (isAssignmentDecided(assignment.status)) {
      return bad(
        assignment.status === "withdrawn"
          ? "This deal is already closed."
          : "A winner has already been decided for this lead; there is nothing left to close.",
      );
    }

    const [offer] = await db
      .select()
      .from(nbfcFinancingOffers)
      .where(eq(nbfcFinancingOffers.assignment_id, assignment.id))
      .limit(1);
    if (!offer) return bad("That NBFC has not submitted a firm offer yet.");

    // Mirrors the E-161 release filter in GET /api/lead/[id]/offers — closing on
    // terms the dealer was never shown would write a round they cannot read.
    if (
      offer.ceo_approval_status !== "not_required" &&
      offer.ceo_approval_status !== "approved"
    ) {
      return bad("These revised terms are still under iTarang review. Try again once they are released.");
    }

    const now = new Date();
    const terms = Object.fromEntries(NEGOTIABLE_FIELDS.map((f) => [f, offer[f]]));

    await db.transaction(async (tx) => {
      // A fixed offer can still be closed — fixing freezes the NUMBERS, it does
      // not oblige the customer to buy. So no negotiation_status guard here,
      // unlike negotiate-offer.
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
        kind: "close",
        // The terms as they stood when the customer walked — the thing anyone
        // reading this thread later wants to know.
        terms,
        message,
        created_by: user.id,
        created_at: now,
      });

      // Guarded on the round we read, same optimistic-concurrency shape as
      // negotiate-offer: a racing writer loses on the UNIQUE (offer_id, round)
      // index above and rolls this back with it.
      await tx
        .update(nbfcFinancingOffers)
        .set({
          negotiation_status: "closed",
          status: "withdrawn",
          negotiation_round: round,
          updated_at: now,
        })
        .where(
          and(
            eq(nbfcFinancingOffers.id, offer.id),
            eq(nbfcFinancingOffers.negotiation_round, offer.negotiation_round),
          ),
        );

      await tx
        .update(nbfcLeadAssignments)
        .set({
          status: "withdrawn",
          decided_at: now,
          decision_reason: "dealer_closed_deal",
          updated_at: now,
        })
        .where(eq(nbfcLeadAssignments.id, assignment.id));

      await tx.insert(nbfcAuditLog).values({
        tenant_id: assignment.tenant_id,
        user_id: user.id,
        action_type: "offer_closed",
        action_id: offer.id,
        before_state: {
          lead_id: leadId,
          nbfc_id: assignment.nbfc_id,
          round: base,
          assignment_status: assignment.status,
          negotiation_status: offer.negotiation_status,
          terms,
        },
        after_state: {
          lead_id: leadId,
          nbfc_id: assignment.nbfc_id,
          round,
          assignment_status: "withdrawn",
          negotiation_status: "closed",
          terms,
          message,
        },
        created_at: now,
      });
    });

    // Best-effort, outside the transaction — matches negotiate-offer and
    // select-winner. A failed notification must not un-close the deal.
    try {
      const [row] = await db
        .select({ legal_name: nbfc.legal_name, short_name: nbfc.short_name })
        .from(nbfc)
        .where(eq(nbfc.id, nbfcId))
        .limit(1);
      await notifyOfferClosed({
        leadId,
        nbfcTenantId: assignment.tenant_id,
        nbfcName: row?.short_name || row?.legal_name || "the lender",
        message,
      });
    } catch (err) {
      console.error("[close-offer] notification failed:", err);
    }

    return NextResponse.json({
      success: true,
      data: { leadId, nbfcId, assignmentStatus: "withdrawn", negotiationStatus: "closed" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to close the deal";
    console.error("[close-offer] error:", error);
    // requireRole throws a ForbiddenError carrying its own status; honour it
    // rather than flattening an auth failure into a 500.
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    return NextResponse.json({ success: false, error: { message } }, { status });
  }
}
