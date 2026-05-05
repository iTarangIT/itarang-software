import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

// BRD V2 §4.0 Scenario B — Close Lead action.
// Permanently closes a lead that was rejected by the lender.
// Only valid when kyc_status='loan_rejected' (inventory has already been
// released by the admin reject-loan action).

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
            message: `Close Lead is only available for rejected loans (current: ${lead.kyc_status}).`,
          },
        },
        { status: 400 },
      );
    }

    await db
      .update(leads)
      .set({ kyc_status: "closed_loan_rejected", updated_at: new Date() })
      .where(eq(leads.id, leadId));

    return NextResponse.json({
      success: true,
      data: { leadStatus: "closed_loan_rejected" },
    });
  } catch (error) {
    console.error("[Close Lead] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to close lead";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
