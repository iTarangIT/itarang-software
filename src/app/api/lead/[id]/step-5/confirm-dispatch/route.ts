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
import { InventoryLifecycleError, reserveInventorySerial } from "@/lib/inventory/lifecycle";
import { finalizeSale } from "@/lib/sales/sale-finalization";
import { projectDisbursedLoan } from "@/lib/nbfc/servicing/projectDisbursedLoan";
import { toPaymentMode } from "@/lib/sales/payment-mode";
import { notifyDispatchConfirmed } from "@/lib/notifications";
import { notifyFulfilmentToAdmin, notifyLoanDisbursed } from "@/lib/notifications/events";
import { sendKycSms } from "@/lib/sms";

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
    if (!selection || !selection.battery_serial) {
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

      // Reserve the stock. Since the Step-4/Step-5 split nothing is reserved
      // when the file goes to the lender — the serial is picked here, so this
      // is the first and only moment it is locked.
      //
      // This runs before finalizeSale on purpose. finalizeSale's 'dispatched'
      // branch writes status='dispatched' with a bare update that never checks
      // the current status and hard-codes fromStatus:'reserved' in its audit
      // log. Going through reserveInventorySerial first keeps the CAS guard and
      // the dealer-ownership check, and leaves an honest
      // available → reserved → dispatched trail in inventory_events.
      //
      // A 409 here means another lead took the serial between the dealer's
      // Step-5 save and this confirm — the oversell window that reserving late
      // opens. InventoryLifecycleError is surfaced to the dealer verbatim.
      await reserveInventorySerial({
        tx,
        serial: selection.battery_serial!,
        dealerId: user.dealer_id,
        leadId,
        performedBy: user.id,
        notes: "Step 5 dispatch confirm (battery)",
        when: now,
      });
      if (selection.charger_serial) {
        await reserveInventorySerial({
          tx,
          serial: selection.charger_serial,
          dealerId: user.dealer_id,
          leadId,
          performedBy: user.id,
          notes: "Step 5 dispatch confirm (charger)",
          when: now,
        });
      }

      // Product selection → dealer_confirmed
      await tx
        .update(productSelections)
        .set({ admin_decision: "dealer_confirmed", updated_at: now })
        .where(eq(productSelections.id, selection.id));

      // Loan sanction → disbursed (dispatch confirmation = funds released).
      // Keeps the legacy dealer_approved_* audit fields populated; collapses
      // status straight to 'disbursed' so the NBFC Portfolio Overview cards
      // (which filter on status='disbursed') reflect the live book.
      if (loan) {
        await tx
          .update(loanSanctions)
          .set({
            status: "disbursed",
            disbursed_at: now,
            dealer_approved: true,
            dealer_approved_at: now,
            dealer_approved_by: user.id,
            updated_at: now,
          })
          .where(eq(loanSanctions.id, loan.id));

        // Project the disbursed loan into the NBFC servicing ledger so the
        // partner portal (portfolio, batteries, leads, recovery) lights up
        // from real loan data. No-ops for cash sales / unmapped lenders.
        await projectDisbursedLoan(tx, loan.id);
      }

      // Inventory sold + warranty + after-sales.
      // BRD §3.5: finance flow goes to 'dispatched' first. Warranty +
      // after-sales are still created (BRD §3.6 says creation is triggered
      // on dispatch, not on sold). Inventory.sold_at stays null until the
      // dealer hits Mark Delivered or the daily cron fires.
      // E-101: paymentMode is collapsed from leads.payment_method via the
      // canonical utility — never inline. Step 5 only ever fires after a
      // loan_sanctioned lead, so the collapsed value is expected to be
      // 'finance'; we still derive it through the utility so warranty and
      // after-sales rows can never disagree with the lead.
      const collapsedPaymentMode = toPaymentMode(lead.payment_method);
      const sale = await finalizeSale({
        tx,
        leadId,
        batterySerial: selection.battery_serial!,
        chargerSerial: selection.charger_serial ?? null,
        dealerId: user.dealer_id!,
        customerName: lead.full_name || lead.owner_name || null,
        customerPhone: lead.phone || lead.mobile || null,
        paymentMode: collapsedPaymentMode,
        performedBy: user.id,
        soldAt: now,
        phase: "dispatched",
      });

      // Lead enters the dispatched state. sold_at stays null.
      await tx
        .update(leads)
        .set({ kyc_status: "dispatched", updated_at: now })
        .where(eq(leads.id, leadId));

      return sale;
    });

    // Post-commit: notifications + customer SMS
    notifyDispatchConfirmed({
      leadId,
      warrantyId: result.warrantyId,
      batterySerial: selection.battery_serial!,
    }).catch(() => {});

    // The admin mirror.
    await notifyFulfilmentToAdmin({
      leadId,
      event: "dispatched",
      batterySerial: selection.battery_serial ?? null,
    });

    // This route also flips the loan_sanctions row straight to 'disbursed'
    // (dispatch confirmation = funds released). There is no separate disbursal
    // endpoint anywhere in the app, so this is the only place the milestone can
    // be announced — and nobody was being told.
    if (loan) {
      await notifyLoanDisbursed({
        leadId,
        lenderName: loan.loan_approved_by ?? null,
        loanAmount: loan.loan_amount ?? null,
      });
    }

    // BRD §3.5: customer is told their battery is dispatched. The "fully
    // sold" SMS goes out later from mark-delivered / cron.
    if (lead.phone || lead.mobile) {
      sendKycSms({
        mobile_number: (lead.phone || lead.mobile) as string,
        message: `Your iTarang battery ${selection.battery_serial} has been dispatched. Warranty ${result.warrantyId} is now active. Loan ref: ${loan?.loan_file_number ?? "—"}. Track delivery in your iTarang portal.`,
        reference_id: `dispatch-${leadId}-${Date.now()}`,
      }).catch(() => {});
    }

    // E-264 — the same news on WhatsApp when the customer has a chat. Additive
    // to the SMS above, not a replacement: a customer with no WhatsApp session
    // still gets told, and one with both gets it on the channel they read.
    void import("@/lib/whatsapp/dispatch-flow")
      .then(({ pushDispatched }) =>
        pushDispatched(leadId, selection.battery_serial ?? null),
      )
      .catch((err) =>
        console.error("[step-5/confirm-dispatch] WhatsApp push failed:", err),
      );

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "dispatched",
        warrantyId: result.warrantyId,
        warrantyStart: result.warrantyStart.toISOString(),
        warrantyEnd: result.warrantyEnd.toISOString(),
        afterSalesId: result.afterSalesId,
        loanStatus: "dealer_approved",
        message:
          "Dispatch confirmed. Inventory dispatched. Warranty activated. Lead will auto-finalize on delivery (or click Mark Delivered when handed over).",
      },
    });
  } catch (error) {
    console.error("[Step 5 Confirm Dispatch] Error:", error);
    // The serial was taken by another lead between the dealer's Step-5 save
    // and this confirm. Surface the lifecycle message and its own status
    // (409) so the dealer is told to pick different stock rather than seeing
    // a generic dispatch failure.
    if (error instanceof InventoryLifecycleError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.statusCode },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to confirm dispatch";
    // E-101: bad payment_method on the lead is a client-mappable input error,
    // not a server crash. Surface it as 400 so the dealer can be told to fix
    // the lead before retrying dispatch.
    const status =
      error instanceof Error && error.name === "PaymentModeMappingError" ? 400 : 500;
    return NextResponse.json(
      { success: false, error: { message } },
      { status },
    );
  }
}
