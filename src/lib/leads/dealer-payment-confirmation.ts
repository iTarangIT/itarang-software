/**
 * E-298 — the dealer confirms the lender's disbursal actually reached them.
 *
 * `confirm-dispatch.ts` flips a sanction to `disbursed` and stamps
 * `dealer_payment_status = 'pending'`. From there the dealer answers once, on
 * the Step-5 page (POST /api/dealer/loans/[sanctionId]/payment-confirmation) or
 * with a WhatsApp tap (`pay_ok:` / `pay_no:`), and both land HERE so the two
 * surfaces cannot disagree about the rules:
 *
 *   pending      → received | not_received
 *   not_received → received | not_received (updated remark / UTR)
 *   received     → (final — refused; a dealer who mis-tapped calls iTarang)
 *
 * The 48h reminder is a claim-first UPDATE against Postgres now() (never the
 * Node clock), so two app instances ticking together push it once.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions, nbfcLeadAssignments } from "@/lib/db/schema";
import { dealerDisplayName } from "@/lib/notifications/emit";
import {
  notifyLoanPaymentConfirmation,
  notifyLoanPaymentPending,
} from "@/lib/notifications/events";

import {
  canRecordDealerPayment,
  type DealerPaymentStatus,
} from "@/lib/leads/dealer-payment-confirmation-rules";

export { canRecordDealerPayment, type DealerPaymentStatus };

export class PaymentConfirmationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PaymentConfirmationError";
    this.status = status;
  }
}

/** The winning tenant for a sanction: its own nbfc_id, else the selected assignment. */
async function tenantForSanction(
  sanction: { nbfc_id: string | null; lead_id: string },
): Promise<string | null> {
  if (sanction.nbfc_id) return sanction.nbfc_id;
  try {
    const [selected] = await db
      .select({ tenant_id: nbfcLeadAssignments.tenant_id })
      .from(nbfcLeadAssignments)
      .where(
        and(
          eq(nbfcLeadAssignments.lead_id, sanction.lead_id),
          eq(nbfcLeadAssignments.status, "selected"),
        ),
      )
      .limit(1);
    return selected?.tenant_id ?? null;
  } catch {
    return null;
  }
}

export interface RecordDealerPaymentInput {
  sanctionId: string;
  /** The caller has already proven this dealer owns the lead. */
  dealerId: string;
  received: boolean;
  utr?: string | null;
  amount?: number | null;
  remarks?: string | null;
  /** users.id (portal) or `whatsapp:<phone>` (chat). */
  confirmedBy: string;
}

export async function recordDealerPaymentConfirmation(
  input: RecordDealerPaymentInput,
): Promise<{ sanctionId: string; leadId: string; status: DealerPaymentStatus }> {
  const [sanction] = await db
    .select({
      id: loanSanctions.id,
      lead_id: loanSanctions.lead_id,
      status: loanSanctions.status,
      nbfc_id: loanSanctions.nbfc_id,
      loan_approved_by: loanSanctions.loan_approved_by,
      dealer_payment_status: loanSanctions.dealer_payment_status,
      lead_dealer_id: leads.dealer_id,
    })
    .from(loanSanctions)
    .innerJoin(leads, eq(leads.id, loanSanctions.lead_id))
    .where(eq(loanSanctions.id, input.sanctionId))
    .limit(1);

  // Same 404 for "missing" and "not yours" — the id must not be probeable.
  if (!sanction || sanction.lead_dealer_id !== input.dealerId) {
    throw new PaymentConfirmationError("Loan not found", 404);
  }
  if (sanction.dealer_payment_status === "received") {
    throw new PaymentConfirmationError("Payment was already confirmed as received", 409);
  }
  if (!canRecordDealerPayment(sanction.dealer_payment_status)) {
    throw new PaymentConfirmationError("This loan is not awaiting a payment confirmation", 409);
  }

  const next: DealerPaymentStatus = input.received ? "received" : "not_received";
  const utr = input.utr?.trim() || null;
  const remarks = input.remarks?.trim() || null;
  const amount = input.amount != null && Number.isFinite(input.amount) ? input.amount.toFixed(2) : null;

  // Compare-and-swap: a concurrent "received" from the other surface wins and
  // this write matches nothing.
  const updated = await db
    .update(loanSanctions)
    .set({
      dealer_payment_status: next,
      dealer_payment_confirmed_at: sql`now()`,
      dealer_payment_confirmed_by: input.confirmedBy,
      dealer_payment_utr: utr,
      dealer_payment_amount: amount,
      dealer_payment_remarks: remarks,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(loanSanctions.id, sanction.id),
        sql`${loanSanctions.dealer_payment_status} IN ('pending', 'not_received')`,
      ),
    )
    .returning({ id: loanSanctions.id });
  if (updated.length === 0) {
    throw new PaymentConfirmationError("Payment was already confirmed as received", 409);
  }

  await notifyLoanPaymentConfirmation({
    leadId: sanction.lead_id,
    sanctionId: sanction.id,
    received: input.received,
    tenantId: await tenantForSanction(sanction),
    lenderName: sanction.loan_approved_by,
    dealerName: await dealerDisplayName(input.dealerId),
    utr,
    amount,
    remarks,
  });

  return { sanctionId: sanction.id, leadId: sanction.lead_id, status: next };
}

/**
 * The newest sanction on a lead that is in the confirmation loop (any state, so
 * a tap on an already-answered prompt gets a clear "already received" reply).
 */
export async function pendingSanctionForLead(
  leadId: string,
): Promise<{ id: string; status: string | null } | null> {
  const [row] = await db
    .select({ id: loanSanctions.id, status: loanSanctions.dealer_payment_status })
    .from(loanSanctions)
    .where(
      and(
        eq(loanSanctions.lead_id, leadId),
        sql`${loanSanctions.dealer_payment_status} IN ('pending', 'not_received', 'received')`,
      ),
    )
    .orderBy(desc(loanSanctions.disbursed_at))
    .limit(1);
  return row ?? null;
}

/**
 * Ask the dealer — bell + WhatsApp prompt. Called by confirm-dispatch right
 * after the sanction flips to disbursed, and by the 48h reminder.
 */
export async function promptDealerForPayment(p: {
  leadId: string;
  sanctionId: string;
  lenderName?: string | null;
  loanAmount?: string | number | null;
  reminder?: boolean;
}): Promise<void> {
  await notifyLoanPaymentPending(p);
  try {
    const { pushPaymentConfirmationPrompt } = await import(
      "@/lib/whatsapp/payment-confirm-flow"
    );
    await pushPaymentConfirmationPrompt(p);
  } catch (err) {
    console.error("[dealer-payment] WhatsApp prompt failed:", err);
  }
}

/**
 * One-shot reminder: pending for 48h+ (by Postgres now()) and never reminded.
 * Claim-first so the push fires once even with several tickers running.
 */
export async function runDealerPaymentReminderTick(): Promise<number> {
  const claimed = await db
    .update(loanSanctions)
    .set({ dealer_payment_reminded_at: sql`now()` })
    .where(
      and(
        eq(loanSanctions.dealer_payment_status, "pending"),
        sql`${loanSanctions.dealer_payment_reminded_at} IS NULL`,
        sql`${loanSanctions.disbursed_at} < now() - interval '48 hours'`,
      ),
    )
    .returning({
      id: loanSanctions.id,
      lead_id: loanSanctions.lead_id,
      loan_approved_by: loanSanctions.loan_approved_by,
      loan_amount: loanSanctions.loan_amount,
    });

  for (const row of claimed) {
    await promptDealerForPayment({
      leadId: row.lead_id,
      sanctionId: row.id,
      lenderName: row.loan_approved_by,
      loanAmount: row.loan_amount,
      reminder: true,
    }).catch((err) => console.error("[dealer-payment] reminder failed:", err));
  }
  return claimed.length;
}
