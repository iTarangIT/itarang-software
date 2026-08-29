/**
 * POST /api/lead/[id]/negotiate-offer
 *
 * RETIRED (E-275). Offer negotiation was removed from the dealer side: the
 * lender now approves or rejects a file directly, and a rejection (once admin
 * or the SLA forwards it) sends the dealer to "Choose another NBFC". The route
 * stays so old clients get a clear 410 rather than a 404 that looks like a
 * deploy problem. The service (`src/lib/leads/negotiate-offer.ts`) is left in
 * place for its remaining callers.
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
