import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { InventoryLifecycleError } from "@/lib/inventory/lifecycle";
import { submitProductSelectionSchema } from "@/lib/leads/productSelectionSchema";
import {
  STEP4_UNLOCKED_STATUSES,
  submitStep4ProductSelection,
} from "@/lib/leads/submit-step4";

// BRD V2 §2.4 — finance path submit for Step 4.
// Stores the product selection, advances the lead to 'pending_final_approval'
// and fans the lead out to the NBFC Acquire queues.
//
// This route no longer reserves inventory, and no longer requires a battery
// serial or a price. Since the Step-4/Step-5 split it means "send this
// customer to the lenders": the NBFC underwrites the customer's profile and
// quotes an indicative range, and the dealer picks the actual stock and settles
// the price on Step 5. Reservation happens there, in the same transaction as
// dispatch (`step-5/confirm-dispatch`).
//
// E-264 Phase 2 — the write itself now lives in `@/lib/leads/submit-step4` so
// the WhatsApp lender-selection flow performs the identical transaction and
// fan-out. What stays here is everything that depends on there being an HTTP
// request and a dealer session: auth, ownership, eligibility, HTTP shaping.

const BodySchema = submitProductSelectionSchema;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const body = BodySchema.parse(await req.json());

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const paymentMode = String(lead.payment_method || "").toLowerCase();
    if (paymentMode === "cash") {
      return NextResponse.json(
        { success: false, error: { message: "Use confirm-cash-sale for cash leads" } },
        { status: 400 },
      );
    }
    if (!STEP4_UNLOCKED_STATUSES.has(String(lead.kyc_status))) {
      return NextResponse.json(
        { success: false, error: { message: `Lead not eligible for Step 4 (kyc_status=${lead.kyc_status})` } },
        { status: 400 },
      );
    }

    const result = await submitStep4ProductSelection({
      leadId,
      lead,
      body,
      submittedBy: user.id,
      dealerCode: user.dealer_id,
    });

    // E-275 — the Bajaj Finance card bypasses the NBFC fan-out: the lead is
    // already `loan_sanctioned` (external sanction row) and goes to Step 5.
    return NextResponse.json({
      success: true,
      data: {
        leadStatus: result.externalLender ? "loan_sanctioned" : "pending_final_approval",
        productSelectionId: result.productSelectionId,
        externalLender: result.externalLender ?? null,
        // Nothing is locked here any more — inventory is reserved at Step 5
        // dispatch. Kept as an explicit null pair so callers that read the
        // shape see "no reservation" rather than a missing key.
        inventoryLocked: { battery: null, charger: null },
      },
    });
  } catch (error) {
    console.error("[Submit Product Selection] Error:", error);
    if (error instanceof InventoryLifecycleError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.statusCode },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to submit";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
