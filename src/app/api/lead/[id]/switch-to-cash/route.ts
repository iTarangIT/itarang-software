import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

// BRD V2 §4.0 Scenario B — Change Payment Mode to Cash.
// Converts a loan-rejected finance lead to a cash sale. Inventory is
// already released (admin reject-loan handled that). The dealer is then
// routed back to Step 4 in cash mode for product re-selection.

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db
      .select({
        id: leads.id,
        dealer_id: leads.dealer_id,
        kyc_status: leads.kyc_status,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

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
    if (lead.kyc_status !== "loan_rejected") {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Payment-mode switch is only available for rejected loans (current: ${lead.kyc_status}).`,
          },
        },
        { status: 400 },
      );
    }

    await db
      .update(leads)
      .set({
        payment_method: "cash",
        kyc_status: "product_selection_in_progress",
        updated_at: new Date(),
      })
      .where(eq(leads.id, leadId));

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "product_selection_in_progress",
        paymentMethod: "cash",
        redirectTo: `/dealer-portal/leads/${leadId}/product-selection`,
      },
    });
  } catch (error) {
    console.error("[Switch to Cash] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to switch payment mode";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
