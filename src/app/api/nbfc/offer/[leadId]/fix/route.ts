/**
 * POST /api/nbfc/offer/[leadId]/fix
 *
 * E-275 — RETIRED. The dealer ⇄ NBFC negotiation loop (E-238/E-245) is gone:
 * the NBFC now Approves, Edits or Rejects the prefilled offer, and there is
 * nothing left to "fix". Returns 410 Gone. The E-238 implementation lives in
 * git history (see E-238_offer_negotiation).
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, _ctx: { params: Promise<{ leadId: string }> }) {
  return NextResponse.json(
    {
      ok: false,
      error:
        "GONE: fixing an offer is no longer available — offers are approved, edited or rejected (E-275)",
    },
    { status: 410 },
  );
}
