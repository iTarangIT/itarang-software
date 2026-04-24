import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  leads,
  loanSanctions,
  otpConfirmations,
  productSelections,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { finalizeSale } from "@/lib/sales/sale-finalization";
import { notifyDispatchConfirmed } from "@/lib/notifications";
import { sendDecentroSms } from "@/lib/decentro";

// BRD V2 §3.3 — Step 5 OTP validation + dispatch confirmation.
// On success, a single DB transaction finalizes the sale:
//   - inventory → sold (battery + charger)
//   - product_selection → dealer_confirmed
//   - loan_sanction → dealer_approved
//   - lead → sold
//   - warranty + after-sales records created
//   - otp row → is_used = true

const BodySchema = z.object({
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});

const MAX_ATTEMPTS = 3;
const LOCK_MS = 5 * 60 * 1000; // 5-minute lockout after MAX_ATTEMPTS wrong attempts

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const { otp } = BodySchema.parse(await req.json());

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
        { success: false, error: { message: `Lead not awaiting dispatch (kyc_status=${lead.kyc_status})` } },
        { status: 400 },
      );
    }

    const [otpRecord] = await db
      .select()
      .from(otpConfirmations)
      .where(
        and(
          eq(otpConfirmations.lead_id, leadId),
          eq(otpConfirmations.is_used, false),
        ),
      )
      .orderBy(desc(otpConfirmations.created_at))
      .limit(1);

    if (!otpRecord) {
      return NextResponse.json(
        { success: false, error: { message: "No active OTP. Please request a new one." } },
        { status: 400 },
      );
    }

    const now = new Date();
    if (otpRecord.locked_until && now < otpRecord.locked_until) {
      const mins = Math.ceil((otpRecord.locked_until.getTime() - now.getTime()) / 60000);
      return NextResponse.json(
        { success: false, error: { message: `Too many attempts. Locked for ${mins} more minute(s).` } },
        { status: 429 },
      );
    }
    if (now >= otpRecord.expires_at) {
      return NextResponse.json(
        { success: false, error: { message: "OTP expired. Please resend." } },
        { status: 400 },
      );
    }

    if (otpRecord.otp_hash !== hashOtp(otp)) {
      const attempts = otpRecord.attempt_count + 1;
      const update: Partial<typeof otpConfirmations.$inferInsert> = { attempt_count: attempts };
      if (attempts >= MAX_ATTEMPTS) {
        update.locked_until = new Date(now.getTime() + LOCK_MS);
      }
      await db
        .update(otpConfirmations)
        .set(update)
        .where(eq(otpConfirmations.id, otpRecord.id));
      return NextResponse.json(
        {
          success: false,
          error: {
            message: attempts >= MAX_ATTEMPTS
              ? "Incorrect OTP. Too many attempts — locked for 5 minutes."
              : `Incorrect OTP. ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`,
          },
        },
        { status: 400 },
      );
    }

    // OTP valid — run the finalization transaction
    const [selection] = await db
      .select()
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1);
    if (!selection || !selection.battery_serial || !selection.charger_serial) {
      return NextResponse.json(
        { success: false, error: { message: "No product selection on this lead" } },
        { status: 400 },
      );
    }

    const [loan] = await db
      .select()
      .from(loanSanctions)
      .where(
        and(
          eq(loanSanctions.lead_id, leadId),
          eq(loanSanctions.status, "sanctioned"),
        ),
      )
      .orderBy(desc(loanSanctions.created_at))
      .limit(1);

    const result = await db.transaction(async (tx) => {
      // Mark OTP used
      await tx
        .update(otpConfirmations)
        .set({ is_used: true, used_at: now, used_by: user.id })
        .where(eq(otpConfirmations.id, otpRecord.id));

      // Product selection → dealer_confirmed
      await tx
        .update(productSelections)
        .set({ admin_decision: "dealer_confirmed", updated_at: now })
        .where(eq(productSelections.id, selection.id));

      // Loan sanction → dealer_approved
      if (loan) {
        await tx
          .update(loanSanctions)
          .set({
            status: "dealer_approved",
            dealer_approved: true,
            dealer_approved_at: now,
            dealer_approved_by: user.id,
            updated_at: now,
          })
          .where(eq(loanSanctions.id, loan.id));
      }

      // Inventory sold + warranty + after-sales
      const sale = await finalizeSale({
        tx,
        leadId,
        batterySerial: selection.battery_serial!,
        chargerSerial: selection.charger_serial!,
        dealerId: user.dealer_id!,
        customerName: lead.full_name || lead.owner_name || null,
        customerPhone: lead.phone || lead.mobile || null,
        paymentMode: "finance",
        performedBy: user.id,
        soldAt: now,
      });

      // Close lead
      await tx
        .update(leads)
        .set({ kyc_status: "sold", sold_at: now, updated_at: now })
        .where(eq(leads.id, leadId));

      return sale;
    });

    // Post-commit: notifications + customer SMS
    notifyDispatchConfirmed({
      leadId,
      warrantyId: result.warrantyId,
      batterySerial: selection.battery_serial!,
    }).catch(() => {});

    if (lead.phone || lead.mobile) {
      sendDecentroSms({
        mobile_number: (lead.phone || lead.mobile) as string,
        message: `Congratulations! Your iTarang battery ${selection.battery_serial} has been dispatched. Warranty ID: ${result.warrantyId}. Loan: ${loan?.loan_file_number ?? "—"}.`,
        reference_id: `dispatch-${leadId}-${Date.now()}`,
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "sold",
        warrantyId: result.warrantyId,
        warrantyStart: result.warrantyStart.toISOString(),
        warrantyEnd: result.warrantyEnd.toISOString(),
        afterSalesId: result.afterSalesId,
        loanStatus: "dealer_approved",
        message: "Dispatch confirmed. Inventory sold. Warranty activated. Loan recorded.",
      },
    });
  } catch (error) {
    console.error("[Step 5 Confirm Dispatch] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to confirm dispatch";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
