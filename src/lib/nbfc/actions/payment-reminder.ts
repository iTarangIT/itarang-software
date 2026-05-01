/**
 * E-031 — Send Payment Reminder (BRD §6.1.6)
 *
 * Pure DB service. The HTTP route hands off to sendPaymentReminder() once
 * tenant + actor have been resolved by `resolveActor()`.
 *
 * Behavior (per unit YAML logic):
 *   1. Validate request body (route-level via zod).
 *   2. Resolve tenant; assert loan_sanctions.nbfc_id = tenant.id (else 403).
 *   3. Insert nbfc_borrower_actions row
 *      (action_type='payment_reminder', requested_by=user_id,
 *       status='auto_approved').
 *   4. Enqueue reminder send via existing notification channel (sms / whatsapp /
 *      email). The actual dispatch is recorded in the action payload — production
 *      wiring to the dispatch worker is out of scope for this unit and stubbed
 *      here as a payload-only record (channel, queued_at).
 *   5. Insert an immutable nbfc_audit_log row with action_id, actor, before/after.
 *   6. Return action_id, loan_sanction_id, channel, status, created_at.
 */
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  loanSanctions,
  nbfcBorrowerActions,
  nbfcAuditLog,
} from "@/lib/db/schema";

export type PaymentReminderChannel = "sms" | "whatsapp" | "email";

export interface SendPaymentReminderInput {
  tenant_id: string;
  loan_sanction_id: string;
  channel: PaymentReminderChannel;
  actor_user_id: string;
}

export interface SendPaymentReminderResult {
  action_id: string;
  loan_sanction_id: string;
  channel: PaymentReminderChannel;
  status: string;
  created_at: string;
}

export async function sendPaymentReminder(
  input: SendPaymentReminderInput,
): Promise<SendPaymentReminderResult> {
  // 2. Resolve loan + tenant scoping check.
  const loanRows = await db
    .select({
      id: loanSanctions.id,
      nbfc_id: loanSanctions.nbfc_id,
      status: loanSanctions.status,
    })
    .from(loanSanctions)
    .where(eq(loanSanctions.id, input.loan_sanction_id))
    .limit(1);

  if (loanRows.length === 0) {
    throw new Error("NOT_FOUND: loan_sanction not found");
  }
  const loan = loanRows[0];

  if (loan.nbfc_id && loan.nbfc_id !== input.tenant_id) {
    // Cross-tenant access — AC3 mandates 403.
    throw new Error("FORBIDDEN: loan_sanction belongs to a different tenant");
  }
  if (!loan.nbfc_id) {
    // A loan with no nbfc_id can't be safely scoped to this tenant.
    throw new Error("FORBIDDEN: loan_sanction has no tenant binding");
  }

  const now = new Date();

  // 3. Insert the action row at status='auto_approved' (per BRD §6.1.6: Send
  //    Payment Reminder is "single approval, NBFC User, auto").
  const [actionRow] = await db
    .insert(nbfcBorrowerActions)
    .values({
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      action_type: "payment_reminder",
      status: "auto_approved",
      requested_by: input.actor_user_id,
      payload: {
        channel: input.channel,
        // 4. Enqueue marker. The reminder worker (out of scope for this unit)
        //    consumes auto_approved rows of action_type='payment_reminder' and
        //    dispatches via the existing notification channel.
        queued_at: now.toISOString(),
      },
      created_at: now,
    })
    .returning({
      id: nbfcBorrowerActions.id,
      created_at: nbfcBorrowerActions.created_at,
    });

  // 5. Immutable nbfc_audit_log row referencing the action_id.
  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: "payment_reminder",
    action_id: actionRow.id,
    before_state: {
      loan_sanction_id: input.loan_sanction_id,
      reminder_sent: false,
    },
    after_state: {
      loan_sanction_id: input.loan_sanction_id,
      reminder_sent: true,
      channel: input.channel,
      action_id: actionRow.id,
    },
    created_at: now,
  });

  return {
    action_id: actionRow.id,
    loan_sanction_id: input.loan_sanction_id,
    channel: input.channel,
    status: "auto_approved",
    created_at: (actionRow.created_at ?? now).toISOString(),
  };
}
