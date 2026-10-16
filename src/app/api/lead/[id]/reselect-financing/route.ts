/**
 * POST /api/lead/[id]/reselect-financing
 *
 * E-245 / E-275 — route this lead to ANOTHER lender after the current one
 * rejected the file (NBFC `declined`) or the dealer closed the deal.
 *
 * Auth + HTTP shaping only; the rules and the write live in
 * `src/lib/leads/reselect-financing.ts`, shared with the WhatsApp
 * "Choose another NBFC" button.
 *
 * Role: dealer, owning this lead. Body: { nbfcId, loanProductId }.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { reselectFinancing, ReselectError } from "@/lib/leads/reselect-financing";
import { ACT_FOR_DEALER_ROLES } from "@/lib/leads/actForDealer";
import { gateLeadActor, recordActorStep, seenFromRequest } from "@/lib/leads/actForDealerGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  nbfcId: z.union([z.number(), z.string()]),
  loanProductId: z.union([z.number(), z.string()]),
});

const bad = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: { message } }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(["dealer", ...ACT_FOR_DEALER_ROLES]);
    const { id: leadId } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return bad("Invalid JSON");
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "Invalid request");

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) return bad("Lead not found", 404);
    // ID 183: the dealer, the house, or Admin / Sales Head acting for the
    // dealer (permission, "being worked by", dealer wins).
    const gate = await gateLeadActor(user, lead, { write: true, seenDealerActionAt: seenFromRequest(req) });
    if (!gate.ok) return bad(gate.message, gate.status);

    const result = await reselectFinancing({
      leadId,
      nbfcId: Number(parsed.data.nbfcId),
      loanProductId: Number(parsed.data.loanProductId),
      // The access check above proved lead.dealer_id is this dealer's code (ID 119:
      // also when the login has no users.dealer_id of its own).
      dealerCode: lead.dealer_id as string,
    });

    await recordActorStep(gate.actor, "sent the file to another lender");
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ReselectError) return bad(error.message, error.status);
    const message = error instanceof Error ? error.message : "Failed to route to that lender";
    console.error("[reselect-financing] error:", error);
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    return NextResponse.json({ success: false, error: { message } }, { status });
  }
}
