import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { inventory, leads, loanSanctions, productSelections } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { generateId } from "@/lib/api-utils";
import { notifyLoanRejected } from "@/lib/notifications";

// BRD V2 §2.8 — admin Step 4 "Loan Rejected" action.
// Records the rejection, releases reserved inventory, advances lead to
// 'loan_rejected'. Dealer Step 5 opens in read-only rejection view.

const BodySchema = z.object({
  rejectionReason: z.string().min(10, "Rejection reason must be at least 10 characters"),
  lenderName: z.string().optional(),
});

export async function POST(
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

        // Release reserved inventory — both battery + charger back to 'available'
        if (selection.battery_serial) {
          await tx
            .update(inventory)
            .set({ status: "available", linked_lead_id: null, updated_at: now })
            .where(
              and(
                eq(inventory.serial_number, selection.battery_serial),
                eq(inventory.status, "reserved"),
              ),
            );
        }
        if (selection.charger_serial) {
          await tx
            .update(inventory)
            .set({ status: "available", linked_lead_id: null, updated_at: now })
            .where(
              and(
                eq(inventory.serial_number, selection.charger_serial),
                eq(inventory.status, "reserved"),
              ),
            );
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
    const message = error instanceof Error ? error.message : "Failed to reject loan";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
