import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads, loanSanctions, productSelections } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { generateId } from "@/lib/api-utils";
import { notifyLoanSanctioned } from "@/lib/notifications";

// BRD V2 §2.7 — admin Step 4 "Loan Sanctioned" action.
// Inserts a loan_sanctions row and advances lead to 'loan_sanctioned' so the
// dealer Step 5 screen unlocks. Inventory stays reserved until dispatch.

const BodySchema = z.object({
  loanAmount: z.number().min(0),
  downPayment: z.number().min(0),
  fileCharge: z.number().min(0),
  subvention: z.number().min(0).default(0),
  disbursementAmount: z.number().min(0),
  emi: z.number().min(0),
  tenureMonths: z.number().int().min(1),
  roi: z.number().min(0),
  loanApprovedBy: z.string().min(1),
  loanFileNumber: z.string().min(1),
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

    // Pick the latest pending product_selection for this lead
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
        loan_amount: body.loanAmount.toString(),
        down_payment: body.downPayment.toString(),
        file_charge: body.fileCharge.toString(),
        subvention: body.subvention.toString(),
        disbursement_amount: body.disbursementAmount.toString(),
        emi: body.emi.toString(),
        tenure_months: body.tenureMonths,
        roi: body.roi.toString(),
        loan_approved_by: body.loanApprovedBy,
        loan_file_number: body.loanFileNumber,
        status: "sanctioned",
        sanctioned_by: admin.id,
        sanctioned_at: now,
        created_at: now,
        updated_at: now,
      });

      if (selection) {
        await tx
          .update(productSelections)
          .set({ admin_decision: "sanctioned", updated_at: now })
          .where(eq(productSelections.id, selection.id));
      }

      await tx
        .update(leads)
        .set({ kyc_status: "loan_sanctioned", updated_at: now })
        .where(eq(leads.id, leadId));
    });

    notifyLoanSanctioned({
      leadId,
      loanSanctionId,
      lenderName: body.loanApprovedBy,
      loanAmount: body.loanAmount,
      emi: body.emi,
      tenureMonths: body.tenureMonths,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "loan_sanctioned",
        loanSanctionId,
        message: "Loan details saved. Lead routed to dealer for customer approval.",
      },
    });
  } catch (error) {
    console.error("[Sanction Loan] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to sanction loan";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
