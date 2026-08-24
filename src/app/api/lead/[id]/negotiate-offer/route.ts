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
 *
 * The write lives in `src/lib/leads/negotiate-offer.ts` — the customer raises
 * the same ask from WhatsApp, and both must obey the same round cap, fixed-terms
 * lock and E-161 release check. This route keeps only auth and HTTP shaping.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { MAX_MESSAGE_LENGTH } from "@/lib/nbfc/offer-negotiation";
import { OfferActionError, negotiateOffer } from "@/lib/leads/negotiate-offer";

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
    const nbfcId = Number(parsed.data.nbfcId);
    if (!Number.isFinite(nbfcId)) return bad("nbfcId required");

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) return bad("Lead not found", 404);
    if (lead.dealer_id !== user.dealer_id) return bad("Access denied", 403);

    const result = await negotiateOffer({
      leadId,
      nbfcId,
      message: parsed.data.message,
      actor: { kind: "dealer", userId: user.id, auditUserId: user.id },
    });

    return NextResponse.json({
      success: true,
      data: {
        leadId: result.leadId,
        nbfcId: result.nbfcId,
        negotiationStatus: result.negotiationStatus,
      },
    });
  } catch (error) {
    // A refusal the dealer should read verbatim, with the status the service chose.
    if (error instanceof OfferActionError) return bad(error.message, error.status);

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
