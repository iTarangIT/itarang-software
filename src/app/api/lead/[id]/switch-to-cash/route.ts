import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads, nbfcLeadAssignments } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { purgeFinanceData } from "@/lib/nbfc/purge-finance-data";
import { ACT_FOR_DEALER_ROLES } from "@/lib/leads/actForDealer";
import { gateLeadActor, recordActorStep, seenFromRequest } from "@/lib/leads/actForDealerGuard";

// BRD V2 §4.0 Scenario B + Addendum V0.2 §12.2 — Convert to Cash Sale (Option A).
// Converts a finance lead that is either loan-rejected OR terminal
// "Financing Unavailable" into a cash sale IN PLACE (same lead flips
// payment_method finance→cash). The dealer is routed back to Step 4 in cash
// mode. Finance-only sensitive data is purged (§12.3); an audit record
// capturing the prior state + declining NBFCs is retained.

const CONVERTIBLE_STATES = new Set(["loan_rejected", "financing_unavailable"]);

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer", ...ACT_FOR_DEALER_ROLES]);
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
    // ID 183: the dealer, the house on a file it pushed out, or Admin / Sales
    // Head acting for the dealer (permission, "being worked by", dealer wins).
    const gate = await gateLeadActor(user, lead, { write: true, seenDealerActionAt: seenFromRequest(_req) });
    if (!gate.ok) {
      return NextResponse.json(
        { success: false, error: { message: gate.message } },
        { status: gate.status },
      );
    }
    if (!lead.kyc_status || !CONVERTIBLE_STATES.has(lead.kyc_status)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Convert to Cash is only available for a rejected or financing-unavailable lead (current: ${lead.kyc_status}).`,
          },
        },
        { status: 400 },
      );
    }

    const priorStatus = lead.kyc_status;
    const now = new Date();

    // Capture which NBFCs declined / were not selected before we convert, for
    // the retained audit record (§12.3 keeps "which NBFCs declined").
    const assignments = await db
      .select({ nbfc_id: nbfcLeadAssignments.nbfc_id, status: nbfcLeadAssignments.status })
      .from(nbfcLeadAssignments)
      .where(eq(nbfcLeadAssignments.lead_id, leadId));

    await db
      .update(leads)
      .set({
        payment_method: "cash",
        kyc_status: "product_selection_in_progress",
        updated_at: now,
      })
      .where(eq(leads.id, leadId));

    await db.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "lead",
      entity_id: leadId,
      action: "lead.converted_to_cash",
      performed_by: user.id,
      new_data: {
        prior_status: priorStatus,
        nbfc_outcomes: assignments,
        converted_at: now.toISOString(),
      },
    });

    // §12.3 — purge finance-only sensitive data on abandonment of finance.
    let purged: Awaited<ReturnType<typeof purgeFinanceData>> | null = null;
    try {
      purged = await purgeFinanceData({ leadId, performedBy: user.id, reason: "cash_conversion" });
    } catch (err) {
      console.error("[switch-to-cash] purge failed (conversion still applied):", err);
    }

    await recordActorStep(gate.actor, "switched the file to a cash sale");
    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "product_selection_in_progress",
        paymentMethod: "cash",
        purged,
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
