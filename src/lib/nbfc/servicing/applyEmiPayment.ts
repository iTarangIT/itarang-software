/**
 * applyEmiPayment — the single settlement code path for an EMI installment.
 *
 * Used by every collection channel so they all behave identically:
 *   - the auto-debit cron in SIMULATE mode (marks paid without real money),
 *   - the Razorpay EMI webhook (real auto-debit settled),
 *   - the manual "Record payment" route (cash collections).
 *
 * Responsibilities (all inside the caller's transaction):
 *   1. Re-read the EMI with a terminal-state guard (idempotent — a replayed
 *      webhook or double-click never double-applies).
 *   2. Mark the EMI paid / paid_late and stamp paid_at, days_overdue,
 *      payment_ref, collection_mode.
 *   3. Reduce nbfc_loans.outstanding_amount by the EMI amount (clamp >= 0).
 *   4. When no unpaid installments remain, CLOSE the loan: loan_sanctions
 *      closed_at/status='closed', nbfc_loans is_active=false + current_dpd=0,
 *      and refresh the tenant's cached active-loan count (mirrors
 *      projectDisbursedLoan step 3).
 *   5. Write an immutable nbfc_audit_log row.
 *
 * Mirrors the TxLike pattern from projectDisbursedLoan so callers can run it
 * atomically alongside their own writes.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  emiSchedules,
  loanSanctions,
  nbfcAuditLog,
  nbfcLoans,
  nbfcTenants,
} from "@/lib/db/schema";
import { recomputeLoanDpd } from "./recomputeLoanDpd";

/** A live db handle OR an open transaction — same shape for our writes. */
type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Sentinel actor for system-initiated settlements (cron / webhook). */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/** Unpaid installment states — what keeps a loan open. */
const OPEN_EMI_STATES = ["scheduled", "overdue", "missed"] as const;

export interface ApplyEmiPaymentInput {
  /** emi_schedules.id of the installment being settled. */
  emiId: string;
  /** Provider payment reference (Razorpay payment id, SIM-…, or cash note). */
  paymentRef: string | null;
  /** When the payment was received. */
  paidAt: Date;
  /** Snapshot of how this settlement was produced: 'simulate' | 'live' | 'manual'. */
  mode: string;
  /** Collection channel: 'enach' | 'upi_link' | 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'qr'. */
  channel: string;
  /**
   * Rupees collected in THIS payment. Omit to settle the full remaining balance
   * (the default — preserves auto-debit/webhook callers). When less than the
   * remaining due, the installment is recorded as a partial collection and
   * stays open for the balance.
   */
  paymentAmount?: number;
  /** Optional uploaded receipt/invoice URL, recorded in the audit trail. */
  documentUrl?: string | null;
  /** Acting user; defaults to the system sentinel for cron/webhook. */
  actorUserId?: string;
}

export interface ApplyEmiPaymentResult {
  applied: boolean;
  reason?: string;
  emiId: string;
  status?: string;
  loanSanctionId?: string;
  loanClosed?: boolean;
  /** True when this payment cleared the installment in full. */
  fullyPaid?: boolean;
  /** Cumulative rupees collected against the installment after this payment. */
  amountPaid?: number;
  /** Rupees still due on the installment after this payment. */
  remaining?: number;
}

/** Rupees → integer paise (avoids float drift when accumulating partials). */
function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Whole days between two dates (b - a), floored, never negative below 0 clamp. */
function dayDiff(a: Date, b: Date): number {
  const aMid = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bMid = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.floor((bMid - aMid) / 86_400_000);
}

export async function applyEmiPayment(
  tx: TxLike,
  input: ApplyEmiPaymentInput,
): Promise<ApplyEmiPaymentResult> {
  const actor = input.actorUserId ?? SYSTEM_USER_ID;

  // 1. Re-read with terminal guard.
  const [emi] = await tx
    .select({
      id: emiSchedules.id,
      loan_sanction_id: emiSchedules.loan_sanction_id,
      due_date: emiSchedules.due_date,
      status: emiSchedules.status,
      amount: emiSchedules.amount,
      amount_paid: emiSchedules.amount_paid,
      days_overdue: emiSchedules.days_overdue,
    })
    .from(emiSchedules)
    .where(eq(emiSchedules.id, input.emiId))
    .limit(1);

  if (!emi) {
    return { applied: false, reason: "not_found", emiId: input.emiId };
  }
  if (emi.status === "paid" || emi.status === "paid_late") {
    return {
      applied: false,
      reason: "already_paid",
      emiId: input.emiId,
      status: emi.status,
      loanSanctionId: emi.loan_sanction_id,
    };
  }

  const loanId = emi.loan_sanction_id;

  // 2. Work in paise. Decide the amount this payment actually collects and
  //    whether it clears the installment.
  const duePaise = emi.amount != null ? toPaise(Number(emi.amount)) : 0;
  const paidSoFarPaise = emi.amount_paid != null ? toPaise(Number(emi.amount_paid)) : 0;
  const remainingPaise = Math.max(0, duePaise - paidSoFarPaise);
  if (remainingPaise <= 0) {
    return {
      applied: false,
      reason: "already_paid",
      emiId: input.emiId,
      status: emi.status,
      loanSanctionId: loanId,
    };
  }

  // Omitted paymentAmount ⇒ settle the full remaining balance (auto-debit /
  // webhook / simulate behaviour). Otherwise clamp to what's still owed.
  const requestedPaise =
    input.paymentAmount != null ? toPaise(input.paymentAmount) : remainingPaise;
  const payPaise = Math.min(Math.max(0, requestedPaise), remainingPaise);
  if (payPaise <= 0) {
    return {
      applied: false,
      reason: "invalid_amount",
      emiId: input.emiId,
      status: emi.status,
      loanSanctionId: loanId,
    };
  }

  const newPaidPaise = paidSoFarPaise + payPaise;
  const fullyPaid = newPaidPaise >= duePaise && duePaise > 0;
  const newAmountPaid = newPaidPaise / 100;
  const newRemaining = Math.max(0, (duePaise - newPaidPaise) / 100);

  // Decide paid vs paid_late from the due date (only when fully settled).
  const dueDate = new Date(`${emi.due_date}T00:00:00.000Z`);
  const overdueDays = Math.max(0, dayDiff(dueDate, input.paidAt));
  const settledStatus = overdueDays > 0 ? "paid_late" : "paid";

  if (fullyPaid) {
    await tx
      .update(emiSchedules)
      .set({
        status: settledStatus,
        paid_at: input.paidAt,
        days_overdue: overdueDays,
        payment_ref: input.paymentRef,
        collection_mode: input.channel,
        amount_paid: newAmountPaid.toFixed(2),
      })
      .where(eq(emiSchedules.id, emi.id));
  } else {
    // Partial: accumulate, keep the installment open (status untouched).
    await tx
      .update(emiSchedules)
      .set({ amount_paid: newAmountPaid.toFixed(2), collection_mode: input.channel })
      .where(eq(emiSchedules.id, emi.id));
  }

  // 3. Reduce outstanding by the AMOUNT ACTUALLY COLLECTED. Resolve tenant for audit.
  const [loanRow] = await tx
    .select({
      tenant_id: nbfcLoans.tenant_id,
      outstanding_amount: nbfcLoans.outstanding_amount,
    })
    .from(nbfcLoans)
    .where(eq(nbfcLoans.loan_application_id, loanId))
    .limit(1);

  const payAmount = payPaise / 100;
  const prevOutstanding =
    loanRow?.outstanding_amount != null ? Number(loanRow.outstanding_amount) : null;
  const newOutstanding =
    prevOutstanding != null ? Math.max(0, prevOutstanding - payAmount) : null;

  if (loanRow && newOutstanding != null) {
    await tx
      .update(nbfcLoans)
      .set({ outstanding_amount: newOutstanding.toFixed(2), updated_at: new Date() })
      .where(eq(nbfcLoans.loan_application_id, loanId));
  }

  // 4. Close the loan when no unpaid installments remain (only possible after a
  //    fully-settling payment; partials leave the installment open).
  const newStatus = fullyPaid ? settledStatus : emi.status;
  const [{ remaining }] = await tx
    .select({ remaining: sql<number>`count(*)::int` })
    .from(emiSchedules)
    .where(
      and(
        eq(emiSchedules.loan_sanction_id, loanId),
        inArray(emiSchedules.status, OPEN_EMI_STATES as unknown as string[]),
      ),
    );

  let loanClosed = false;
  if (remaining === 0) {
    const now = new Date();
    await tx
      .update(loanSanctions)
      .set({ status: "closed", closed_at: now, updated_at: now })
      .where(eq(loanSanctions.id, loanId));

    if (loanRow) {
      await tx
        .update(nbfcLoans)
        .set({ is_active: false, current_dpd: 0, updated_at: now })
        .where(eq(nbfcLoans.loan_application_id, loanId));

      // Refresh the tenant's cached active-loan count (mirror projectDisbursedLoan).
      const [{ count: activeCount }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(nbfcLoans)
        .where(
          and(eq(nbfcLoans.tenant_id, loanRow.tenant_id), eq(nbfcLoans.is_active, true)),
        );
      await tx
        .update(nbfcTenants)
        .set({ active_loans: activeCount, updated_at: now })
        .where(eq(nbfcTenants.id, loanRow.tenant_id));
    }
    loanClosed = true;
  } else {
    // Loan stays open: re-derive current_dpd from the (now-changed)
    // emi_schedules window. A collection that cleared an overdue/missed
    // installment must drop the loan's DPD immediately — otherwise the DPD
    // column + DPD-based status/filters on the EMI Tracker, Lead Intelligence
    // and Battery Monitoring would lag until the nightly aging sweep. (The
    // close branch above already zeroes current_dpd directly.)
    await recomputeLoanDpd(tx, loanId);
  }

  // 5. Immutable audit row (best-effort tenant — skip if loan is unmapped).
  if (loanRow) {
    await tx.insert(nbfcAuditLog).values({
      tenant_id: loanRow.tenant_id,
      user_id: actor,
      action_type: "emi_payment",
      action_id: emi.id,
      before_state: {
        emi_schedule_id: emi.id,
        loan_sanction_id: loanId,
        status: emi.status,
        amount_paid: paidSoFarPaise / 100,
        outstanding_amount: prevOutstanding,
      },
      after_state: {
        emi_schedule_id: emi.id,
        loan_sanction_id: loanId,
        status: newStatus,
        days_overdue: fullyPaid ? overdueDays : emi.days_overdue ?? null,
        amount: duePaise / 100,
        payment_amount: payAmount,
        amount_paid: newAmountPaid,
        remaining: newRemaining,
        fully_paid: fullyPaid,
        outstanding_amount: newOutstanding,
        payment_ref: input.paymentRef,
        document_url: input.documentUrl ?? null,
        mode: input.mode,
        channel: input.channel,
        loan_closed: loanClosed,
      },
    });
  }

  return {
    applied: true,
    emiId: emi.id,
    status: newStatus,
    fullyPaid,
    amountPaid: newAmountPaid,
    remaining: newRemaining,
    loanSanctionId: loanId,
    loanClosed,
  };
}
