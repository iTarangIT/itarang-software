/**
 * POST /api/admin/lead/[id]/manual-handoff/outcome
 *
 * BRD Addendum V0.2 §11.7 — admin records the Manual Handoff outcome:
 *   accepted → the lead RE-ENTERS for disbursement + Step 5 OTP + dispatch:
 *              a loan_sanctions row is created and the lead advances to
 *              loan_sanctioned (the winning off-platform NBFC is recorded).
 *   declined → no off-platform NBFC accepted (records the decliners).
 *   exhausted→ admin declares the handoff exhausted (stops the 24h nudge).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions, manualHandoffs, productSelections } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { generateId } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  result: z.enum(["accepted", "declined", "exhausted"]),
  winning_nbfc_name: z.string().max(200).optional(),
  // The sanctioned amount, as told to us by the off-platform lender.
  //
  // Since the Step-4/Step-5 split the product selection carries no price at
  // this point in the flow (the dealer picks stock and settles the price on
  // Step 5, after a lender quotes), so `final_price` can no longer stand in
  // for the loan amount. It is still used as the fallback for older leads
  // that do carry one.
  loan_amount: z.number().min(0).optional(),
  declining_nbfcs: z.array(z.string().max(200)).optional(),
  outcome: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 403 });
    }
    const { id: leadId } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: { message: "Invalid JSON" } }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: { message: "Validation", issues: parsed.error.issues } }, { status: 400 });
    }
    const d = parsed.data;
    if (d.result === "accepted" && !d.winning_nbfc_name?.trim()) {
      return NextResponse.json({ success: false, error: { message: "winning_nbfc_name required when accepted" } }, { status: 400 });
    }

    const [handoff] = await db.select().from(manualHandoffs).where(eq(manualHandoffs.lead_id, leadId)).limit(1);
    if (!handoff) {
      return NextResponse.json({ success: false, error: { message: "No manual handoff found for this lead" } }, { status: 404 });
    }

    const now = new Date();
    const status =
      d.result === "accepted" ? "outcome_accepted" : d.result === "declined" ? "outcome_declined" : "exhausted";

    if (d.result === "accepted") {
      const [selection] = await db
        .select({ id: productSelections.id, final_price: productSelections.final_price })
        .from(productSelections)
        .where(and(eq(productSelections.lead_id, leadId), eq(productSelections.payment_mode, "finance")))
        .orderBy(desc(productSelections.created_at))
        .limit(1);
      const loanSanctionId = await generateId("LS");

      await db.transaction(async (tx) => {
        await tx.insert(loanSanctions).values({
          id: loanSanctionId,
          lead_id: leadId,
          product_selection_id: selection?.id ?? null,
          loan_amount: d.loan_amount != null ? String(d.loan_amount) : (selection?.final_price ?? null),
          status: "sanctioned",
          loan_approved_by: d.winning_nbfc_name ?? "Off-platform NBFC",
          // off-platform NBFC — not an in-system user
          sanctioned_at: now,
          created_at: now,
          updated_at: now,
        });
        await tx
          .update(manualHandoffs)
          .set({
            status,
            outcome: d.outcome ?? null,
            winning_nbfc_name: d.winning_nbfc_name ?? null,
            declining_nbfcs: (d.declining_nbfcs ?? null) as unknown as Record<string, unknown> | null,
            outcome_recorded_by: admin.id,
            outcome_recorded_at: now,
            updated_at: now,
          })
          .where(eq(manualHandoffs.id, handoff.id));
        await tx.update(leads).set({ kyc_status: "loan_sanctioned", updated_at: now }).where(eq(leads.id, leadId));
      });

      return NextResponse.json({ success: true, data: { status, leadStatus: "loan_sanctioned", loanSanctionId } });
    }

    // declined / exhausted — record only.
    await db
      .update(manualHandoffs)
      .set({
        status,
        outcome: d.outcome ?? null,
        declining_nbfcs: (d.declining_nbfcs ?? null) as unknown as Record<string, unknown> | null,
        outcome_recorded_by: admin.id,
        outcome_recorded_at: now,
        updated_at: now,
      })
      .where(eq(manualHandoffs.id, handoff.id));

    return NextResponse.json({ success: true, data: { status } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record outcome";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
