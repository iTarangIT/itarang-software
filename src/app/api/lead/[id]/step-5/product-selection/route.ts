import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { step5ProductSelectionSchema } from "@/lib/leads/productSelectionSchema";
import { saveStep5ProductSelection } from "@/lib/leads/step5-product";

/**
 * Step 5 product save.
 *
 * Since the Step-4/Step-5 split this is where the dealer commits to actual
 * stock. Step 4 now means "send this customer to the lenders" and carries no
 * serial and no price; the NBFC quotes against the customer's profile, and the
 * dealer picks the battery and settles the final price here, once terms are
 * known.
 *
 * The write lives in `src/lib/leads/step5-product.ts` — the customer chooses the
 * same stock from their WhatsApp chat, and both callers must invalidate an
 * outstanding OTP and must NOT reserve inventory. This route keeps auth,
 * eligibility and HTTP shaping.
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const body = step5ProductSelectionSchema.parse(await req.json());

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
    if (lead.kyc_status !== "loan_sanctioned") {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Product selection can only be changed while the loan is sanctioned and undispatched (current: ${lead.kyc_status})`,
          },
        },
        { status: 400 },
      );
    }

    const data = await saveStep5ProductSelection({
      leadId,
      body,
      submittedBy: user.id,
      lead: {
        product_category_id: lead.product_category_id,
        product_type_id: lead.product_type_id,
      },
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[Step 5 Product Selection] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to save product selection";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
