import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads, loanSanctions, productSelections } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { generateId } from "@/lib/api-utils";
import { notifyLoanRejected } from "@/lib/notifications";
import { InventoryLifecycleError, releaseInventorySerial } from "@/lib/inventory/lifecycle";

// BRD V2 §2.8 — admin Step 4 "Loan Rejected" action.
// Records the rejection, releases reserved inventory, advances lead to
// 'loan_rejected'. Dealer Step 5 opens in read-only rejection view.
//
// DEPRECATED by BRD Addendum V0.1 §5.1 (Phase 2). Admin no longer acts on
// product selection. Returns 410 Gone. Original implementation retained
// below for Phase-5 revert; never invoked.

export async function POST(
  _req: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
) {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "ENDPOINT_GONE",
        message:
          "Admin loan-rejection is no longer available. Lead disposition for declined loans is now handled in the NBFC Acquire workspace, with Manual Handoff as fallback (BRD Addendum V0.1 §5.1, §6, §9.7).",
      },
    },
    { status: 410 },
  );
}

const BodySchema = z.object({
  rejectionReason: z.string().min(10, "Rejection reason must be at least 10 characters"),
  lenderName: z.string().optional(),
});

// Original handler — kept intact for Phase-5 revert. Not exported.
async function _POST_ORIGINAL_IMPL(
  req: NextRequest,
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
    const body = BodySchema.parse(await req.json());

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (lead.kyc_status !== "pending_final_approval") {
      return NextResponse.json(
        { success: false, error: { message: `Lead is not awaiting final approval (kyc_status=${lead.kyc_status})` } },
        { status: 400 },
      );
    }

    const [selection] = await db
      .select()
      .from(productSelections)
      .where(
        and(
          eq(productSelections.lead_id, leadId),
          eq(productSelections.admin_decision, "pending"),
        ),
      )
      .orderBy(productSelections.created_at)
      .limit(1);

    const loanSanctionId = await generateId("LS");
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(loanSanctions).values({
        id: loanSanctionId,
        lead_id: leadId,
        product_selection_id: selection?.id ?? null,
        status: "rejected",
        rejection_reason: body.rejectionReason,
        loan_approved_by: body.lenderName ?? null,
        sanctioned_by: admin.id,
        sanctioned_at: now,
        created_at: now,
        updated_at: now,
      });

      if (selection) {
        await tx
          .update(productSelections)
          .set({ admin_decision: "rejected", updated_at: now })
          .where(eq(productSelections.id, selection.id));

        // Release reserved inventory - both battery + charger back to available.
        if (selection.battery_serial) {
          await releaseInventorySerial({
            tx,
            serial: selection.battery_serial,
            leadId,
            performedBy: admin.id,
            notes: "Step 4 loan rejected (battery release)",
            when: now,
          });
        }
        if (selection.charger_serial) {
          await releaseInventorySerial({
            tx,
            serial: selection.charger_serial,
            leadId,
            performedBy: admin.id,
            notes: "Step 4 loan rejected (charger release)",
            when: now,
          });
        }
      }

      await tx
        .update(leads)
        .set({ kyc_status: "loan_rejected", updated_at: now })
        .where(eq(leads.id, leadId));
    });

    notifyLoanRejected({
      leadId,
      rejectionReason: body.rejectionReason,
      lenderName: body.lenderName ?? null,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "loan_rejected",
        loanSanctionId,
        inventoryReleased: true,
        message: "Loan rejection recorded. Inventory released. Dealer notified.",
      },
    });
  } catch (error) {
    console.error("[Reject Loan] Error:", error);
    if (error instanceof InventoryLifecycleError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.statusCode },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to reject loan";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
