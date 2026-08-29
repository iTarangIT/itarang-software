/**
 * POST /api/lead/[id]/close-offer
 *
 * RETIRED (E-275). "Close deal" was part of the dealer-side negotiation loop,
 * which no longer exists: the lender approves or rejects directly, and a
 * forwarded rejection is what frees the lead for "Choose another NBFC"
 * (/api/lead/[id]/reselect-financing). Kept as a 410 so stale clients fail
 * loudly rather than with a misleading 404.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETIRED_MESSAGE =
  "Offer negotiation has been retired. The lender approves or rejects directly.";

export async function POST() {
  return NextResponse.json(
    { success: false, error: { message: RETIRED_MESSAGE } },
    { status: 410 },
  );
}
