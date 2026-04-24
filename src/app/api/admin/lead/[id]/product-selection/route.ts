import { NextRequest, NextResponse } from "next/server";
import { and, eq, desc } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  inventory,
  leads,
  loanSanctions,
  productSelections,
} from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

// Admin read endpoint: returns the current product_selection for a lead plus
// enriched inventory details (for the read-only Step 4 panel in CaseReview).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }
    const { id: leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const [selection] = await db
      .select()
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1);

    if (!selection) {
      return NextResponse.json({ success: true, data: { selection: null } });
    }

    const batteryRow = selection.battery_serial
      ? (
          await db
            .select()
            .from(inventory)
            .where(eq(inventory.serial_number, selection.battery_serial))
            .limit(1)
        )[0]
      : null;
    const chargerRow = selection.charger_serial
      ? (
          await db
            .select()
            .from(inventory)
            .where(eq(inventory.serial_number, selection.charger_serial))
            .limit(1)
        )[0]
      : null;

    // Latest loan sanction (if already sanctioned/rejected)
    const [loanRow] = await db
      .select()
      .from(loanSanctions)
      .where(eq(loanSanctions.lead_id, leadId))
      .orderBy(desc(loanSanctions.created_at))
      .limit(1);

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: lead.kyc_status,
        paymentMethod: lead.payment_method,
        selection,
        battery: batteryRow,
        charger: chargerRow,
        loanSanction: loanRow ?? null,
      },
    });
  } catch (error) {
    console.error("[Admin Product Selection] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load product selection";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
