/**
 * POST /api/nbfc/offer/[leadId]/fix
 *
 * E-238 — the NBFC declares its terms FINAL. The dealer's Negotiate action
 * disappears, and the NBFC itself can no longer revise them: fixing is a
 * one-way door, deliberately, because a "fixed" offer the NBFC could quietly
 * edit afterwards would be worth nothing to the dealer relying on it.
 *
 * What fixing does NOT do is close the offer. `Select as winner` stays
 * available — the point is to end the haggling, not the deal.
 *
 * Role: credit_underwriting or nbfc_admin — the same roles that may SUBMIT an
 * offer, so the officer running the negotiation can close it. (Contrast
 * WITHDRAW, which §13.4 makes an NBFC-admin-only senior action: withdrawing
 * kills the offer, fixing only freezes it.)
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcAuditLog, nbfcFinancingOffers } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import {
  NEGOTIABLE_FIELDS,
  appendRound,
  isAssignmentDecided,
  seedOpeningRoundIfMissing,
} from "@/lib/nbfc/offer-negotiation";
import { notifyOfferFixed } from "@/lib/notifications/events";
import { tenantDisplayName } from "@/lib/notifications/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' cannot fix an offer; credit_underwriting or nbfc_admin required`,
        },
        { status: 403 },
      );
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" },
        { status: 400 },
      );
    }
    if (isAssignmentDecided(assignment.status)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            assignment.status === "withdrawn"
              ? "BAD_REQUEST: the customer closed this deal — nothing left to fix"
              : `BAD_REQUEST: a winner has already been decided (status '${assignment.status}') — nothing left to fix`,
        },
        { status: 400 },
      );
    }

    const [offer] = await db
      .select()
      .from(nbfcFinancingOffers)
      .where(eq(nbfcFinancingOffers.assignment_id, assignment.id))
      .limit(1);
    if (!offer) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: submit a firm offer before fixing it" },
        { status: 400 },
      );
    }
    if (offer.negotiation_status === "fixed") {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: these terms are already fixed" },
        { status: 400 },
      );
    }
    // Fixing terms the dealer cannot yet see would leave them staring at a
    // FIXED badge over an offer that was never released.
    if (offer.ceo_approval_status === "pending") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: this offer is held for iTarang CEO approval and is not visible to the customer yet — it cannot be fixed until it is released",
        },
        { status: 400 },
      );
    }

    const now = new Date();
    const terms = Object.fromEntries(NEGOTIABLE_FIELDS.map((f) => [f, offer[f]]));

    await db.transaction(async (tx) => {
      const base = await seedOpeningRoundIfMissing(tx, offer);
      const round = base + 1;

      await appendRound(tx, {
        offer_id: offer.id,
        assignment_id: assignment.id,
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        tenant_id: actor.tenant_id,
        round,
        party: "nbfc",
        kind: "fix",
        terms,
        conditions: offer.conditions,
        created_by: actor.user_id,
        created_at: now,
      });

      await tx
        .update(nbfcFinancingOffers)
        .set({
          negotiation_status: "fixed",
          negotiation_round: round,
          fixed_at: now,
          fixed_by: actor.user_id,
          updated_at: now,
        })
        .where(
          and(
            eq(nbfcFinancingOffers.id, offer.id),
            eq(nbfcFinancingOffers.negotiation_round, offer.negotiation_round),
          ),
        );

      await tx.insert(nbfcAuditLog).values({
        tenant_id: actor.tenant_id,
        user_id: actor.user_id,
        action_type: "offer_fix",
        action_id: offer.id,
        before_state: {
          lead_id: leadId,
          nbfc_id: assignment.nbfc_id,
          negotiation_status: offer.negotiation_status,
          round: base,
        },
        after_state: {
          lead_id: leadId,
          nbfc_id: assignment.nbfc_id,
          negotiation_status: "fixed",
          round,
          terms,
        },
        created_at: now,
      });
    });

    try {
      await notifyOfferFixed({
        leadId,
        nbfcName: await tenantDisplayName(actor.tenant_id),
        loanAmount: offer.loan_amount,
        emi: offer.emi_amount,
        tenureMonths: offer.tenure_months,
      });
    } catch (err) {
      console.error("[offer/fix] notification failed:", err);
    }

    return NextResponse.json({ ok: true, negotiation_status: "fixed", fixed_at: now.toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
