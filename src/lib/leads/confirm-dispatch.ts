/**
 * Dispatch confirmation — the transaction, lifted out of the dealer route.
 *
 * BRD V2 §3.3. One database transaction finalises the sale:
 *   - the OTP row is consumed
 *   - the battery (and charger) go available → reserved → dispatched
 *   - product_selection → dealer_confirmed
 *   - loan_sanction → disbursed, and is projected into the NBFC servicing ledger
 *   - warranty + after-sales records are created
 *   - lead → dispatched
 *
 * WHY IT LIVES HERE. The customer can now confirm delivery from inside their
 * WhatsApp chat, and a chat turn has no Supabase session for
 * `requireRole("dealer")`. This is the one piece of the journey where a second
 * implementation would be genuinely dangerous — it moves stock and money — so
 * there is exactly one, and both callers reach it. Same rule `step4-flow.ts`
 * states for the Acquire fan-out.
 *
 * WHY THE OTP IS RE-VERIFIED HERE RATHER THAN TRUSTED. `verify-otp` deliberately
 * does NOT consume the code — it only reports that it matched. The code is
 * consumed inside this transaction so a verify that is never followed by a
 * confirm leaves nothing spent, and two confirms cannot both succeed. That means
 * the hash, the expiry and the lockout are all checked again, right here, with
 * the row locked by the same transaction that spends it.
 *
 * WHY RESERVE BEFORE finalizeSale. `finalizeSale`'s 'dispatched' branch writes
 * `status='dispatched'` with a bare update that never checks the current status
 * and hard-codes `fromStatus:'reserved'` in its audit log. Going through
 * `reserveInventorySerial` first keeps the compare-and-swap guard and the
 * dealer-ownership check, and leaves an honest available → reserved → dispatched
 * trail in `inventory_events`.
 *
 * A 409 (`InventoryLifecycleError`) means another lead took the serial between
 * the Step-5 save and this confirm — the oversell window that reserving late
 * opens. It must be surfaced to whoever is confirming, verbatim, so they pick
 * different stock. Swallowing it would strand a customer at "confirming…".
 */

import crypto from "crypto";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  loanSanctions,
  otpConfirmations,
  productSelections,
} from "@/lib/db/schema";
import { reserveInventorySerial } from "@/lib/inventory/lifecycle";
import { finalizeSale } from "@/lib/sales/sale-finalization";
import { projectDisbursedLoan } from "@/lib/nbfc/servicing/projectDisbursedLoan";
import { toPaymentMode } from "@/lib/sales/payment-mode";
import { notifyDispatchConfirmed } from "@/lib/notifications";
import { notifyFulfilmentToAdmin, notifyLoanDisbursed } from "@/lib/notifications/events";
import { sendKycSms } from "@/lib/sms";

const MAX_ATTEMPTS = 3;
/** 5-minute lockout after MAX_ATTEMPTS wrong attempts. */
const LOCK_MS = 5 * 60 * 1000;

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

/**
 * A refusal the person confirming should read verbatim, with the status the
 * caller should return. Distinct from `InventoryLifecycleError`, which carries
 * its own 409 and is allowed to propagate.
 */
export class DispatchError extends Error {
  readonly status: number;
  /** Wrong code only — how many tries are left before the lockout. */
  readonly attemptsLeft?: number;
  constructor(message: string, status = 400, attemptsLeft?: number) {
    super(message);
    this.name = "DispatchError";
    this.status = status;
    this.attemptsLeft = attemptsLeft;
  }
}

export interface ConfirmDispatchResult {
  leadStatus: "dispatched";
  warrantyId: string;
  warrantyStart: Date;
  warrantyEnd: Date;
  warrantyMonths: number;
  afterSalesId: string;
  /** The DB value actually written — see the note in the route's response. */
  loanStatus: "disbursed";
  batterySerial: string;
  loanFileNumber: string | null;
}

/**
 * Consume the OTP and finalise the sale.
 *
 * The caller owns authorisation. Throws `DispatchError` for anything the
 * confirming party should be told about, `InventoryLifecycleError` (409) when
 * the stock was taken, and propagates everything else.
 */
export async function confirmDispatch(opts: {
  leadId: string;
  otp: string;
  /** `users.id` recorded as the performer on every row this writes. */
  performedBy: string;
  /**
   * The dealer that owns the stock. Passed explicitly rather than read off the
   * session, because for a WhatsApp confirm the acting party is the CUSTOMER —
   * the stock still belongs to the lead's dealer, and `reserveInventorySerial`
   * checks that ownership.
   */
  dealerId: string;
}): Promise<ConfirmDispatchResult> {
  const { leadId, otp, performedBy, dealerId } = opts;

  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) throw new DispatchError("Lead not found", 404);
  if (lead.kyc_status !== "loan_sanctioned") {
    throw new DispatchError(
      `Lead not awaiting dispatch (kyc_status=${lead.kyc_status})`,
    );
  }

  const [otpRecord] = await db
    .select()
    .from(otpConfirmations)
    .where(
      and(
        eq(otpConfirmations.lead_id, leadId),
        eq(otpConfirmations.otp_type, "dispatch_confirmation"),
        eq(otpConfirmations.is_used, false),
      ),
    )
    .orderBy(desc(otpConfirmations.created_at))
    .limit(1);

  if (!otpRecord) {
    throw new DispatchError("No active code. Please request a new one.");
  }

  const now = new Date();
  if (otpRecord.locked_until && now < otpRecord.locked_until) {
    const mins = Math.ceil((otpRecord.locked_until.getTime() - now.getTime()) / 60000);
    throw new DispatchError(
      `Too many attempts. Locked for ${mins} more minute(s).`,
      429,
    );
  }
  if (now >= otpRecord.expires_at) {
    throw new DispatchError("Code expired. Please resend.");
  }

  if (otpRecord.otp_hash !== hashOtp(otp)) {
    const attempts = otpRecord.attempt_count + 1;
    const update: Partial<typeof otpConfirmations.$inferInsert> = {
      attempt_count: attempts,
    };
    if (attempts >= MAX_ATTEMPTS) {
      update.locked_until = new Date(now.getTime() + LOCK_MS);
    }
    await db
      .update(otpConfirmations)
      .set(update)
      .where(eq(otpConfirmations.id, otpRecord.id));
    throw new DispatchError(
      attempts >= MAX_ATTEMPTS
        ? "Incorrect code. Too many attempts — locked for 5 minutes."
        : `Incorrect code. ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`,
      400,
      Math.max(0, MAX_ATTEMPTS - attempts),
    );
  }

  const [selection] = await db
    .select()
    .from(productSelections)
    .where(eq(productSelections.lead_id, leadId))
    .orderBy(desc(productSelections.created_at))
    .limit(1);
  if (!selection || !selection.battery_serial) {
    throw new DispatchError("No product selection on this lead");
  }

  const [loan] = await db
    .select()
    .from(loanSanctions)
    .where(
      and(eq(loanSanctions.lead_id, leadId), eq(loanSanctions.status, "sanctioned")),
    )
    .orderBy(desc(loanSanctions.created_at))
    .limit(1);

  const result = await db.transaction(async (tx) => {
    // Spend the code inside the same transaction that moves the stock, so a
    // rollback cannot leave it spent.
    await tx
      .update(otpConfirmations)
      .set({ is_used: true, used_at: now, used_by: performedBy })
      .where(eq(otpConfirmations.id, otpRecord.id));

    // First and only moment the stock is locked — see the file header.
    await reserveInventorySerial({
      tx,
      serial: selection.battery_serial!,
      dealerId,
      leadId,
      performedBy,
      notes: "Step 5 dispatch confirm (battery)",
      when: now,
    });
    if (selection.charger_serial) {
      await reserveInventorySerial({
        tx,
        serial: selection.charger_serial,
        dealerId,
        leadId,
        performedBy,
        notes: "Step 5 dispatch confirm (charger)",
        when: now,
      });
    }

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
          dealer_approved_by: performedBy,
          updated_at: now,
        })
        .where(eq(loanSanctions.id, loan.id));

      // Project the disbursed loan into the NBFC servicing ledger so the
      // partner portal (portfolio, batteries, leads, recovery) lights up from
      // real loan data. No-ops for cash sales / unmapped lenders.
      await projectDisbursedLoan(tx, loan.id);
    }

    // Inventory dispatched + warranty + after-sales.
    // BRD §3.5: the finance flow goes to 'dispatched' first. Warranty +
    // after-sales are still created (BRD §3.6 triggers creation on dispatch,
    // not on sold). inventory.sold_at stays null until Mark Delivered or the
    // daily cron fires.
    // E-101: paymentMode is collapsed from leads.payment_method via the
    // canonical utility — never inline. Step 5 only ever fires after a
    // loan_sanctioned lead, so the collapsed value is expected to be 'finance';
    // we still derive it through the utility so warranty and after-sales rows
    // can never disagree with the lead.
    const collapsedPaymentMode = toPaymentMode(lead.payment_method);
    const sale = await finalizeSale({
      tx,
      leadId,
      batterySerial: selection.battery_serial!,
      chargerSerial: selection.charger_serial ?? null,
      dealerId,
      customerName: lead.full_name || lead.owner_name || null,
      customerPhone: lead.phone || lead.mobile || null,
      paymentMode: collapsedPaymentMode,
      performedBy,
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

  // --- Post-commit. Every send below is best-effort: the sale is committed and
  // must not be undone by a messaging failure. -----------------------------

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
  }).catch(() => {});

  // This is also where the loan_sanctions row flips to 'disbursed' (dispatch
  // confirmation = funds released). There is no separate disbursal endpoint
  // anywhere in the app, so this is the only place the milestone can be
  // announced.
  if (loan) {
    await notifyLoanDisbursed({
      leadId,
      lenderName: loan.loan_approved_by ?? null,
      loanAmount: loan.loan_amount ?? null,
    }).catch(() => {});
  }

  // BRD §3.5: the customer is told their battery is dispatched. The "fully
  // sold" SMS goes out later from mark-delivered / cron.
  if (lead.phone || lead.mobile) {
    sendKycSms({
      mobile_number: (lead.phone || lead.mobile) as string,
      message: `Your iTarang battery ${selection.battery_serial} has been dispatched. Warranty ${result.warrantyId} is now active. Loan ref: ${loan?.loan_file_number ?? "—"}. Track delivery in your iTarang portal.`,
      reference_id: `dispatch-${leadId}-${Date.now()}`,
    }).catch(() => {});
  }

  // The same news on WhatsApp when the customer has a chat. Additive to the SMS
  // above, not a replacement: a customer with no WhatsApp session still gets
  // told, and one with both gets it on the channel they read.
  void import("@/lib/whatsapp/dispatch-flow")
    .then(({ pushDispatched }) =>
      pushDispatched(leadId, selection.battery_serial ?? null),
    )
    .catch((err) => console.error("[confirm-dispatch] WhatsApp push failed:", err));

  return {
    leadStatus: "dispatched",
    warrantyId: result.warrantyId,
    warrantyStart: result.warrantyStart,
    warrantyEnd: result.warrantyEnd,
    warrantyMonths: result.warrantyMonths,
    afterSalesId: result.afterSalesId,
    loanStatus: "disbursed",
    batterySerial: selection.battery_serial!,
    loanFileNumber: loan?.loan_file_number ?? null,
  };
}
