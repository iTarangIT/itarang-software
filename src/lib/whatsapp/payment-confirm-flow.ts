/**
 * E-298 — "did the loan money reach you?" on WhatsApp.
 *
 * Push: after dispatch confirmation flips the sanction to `disbursed`, the
 * OWNING DEALER's chat gets the question with two id-bearing buttons,
 * `pay_ok:<leadId>` and `pay_no:<leadId>`. Like every journey button the id is
 * also typeable. The id carries the LEAD, not the sanction, on purpose: the
 * lead-action gate (authorizeLeadAction) authorises a phone against a lead, and
 * the handler then resolves that lead's sanction awaiting an answer.
 *
 * Dealer-only: the customer arm of authorizeLeadAction is refused here — only
 * the dealer (or their salesperson) knows what landed in the dealer's bank.
 *
 * `pay_no` records the answer immediately (no remark conversation — keep it
 * simple); the dealer can add a UTR / remark on the Step-5 page.
 */

import {
  PaymentConfirmationError,
  pendingSanctionForLead,
  recordDealerPaymentConfirmation,
} from "@/lib/leads/dealer-payment-confirmation";

import type { ActiveDealer } from "./customer-lead";
import { resolveWhatsAppDealer } from "./dealer-identity";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead, resolveLeadTarget } from "./lead-push";
import { resolveSalesperson } from "./salesperson-identity";
import { reply, type SessionRow } from "./session-store";
import type { InboundEvent } from "./types";
import { oneLine } from "./window";

const inr = (v: string | number | null | undefined): string | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : null;
};

export async function pushPaymentConfirmationPrompt(p: {
  leadId: string;
  sanctionId: string;
  lenderName?: string | null;
  loanAmount?: string | number | null;
  reminder?: boolean;
}): Promise<void> {
  const target = await resolveLeadTarget(p.leadId);
  // Addressed to the dealer; never re-routed to the customer's own chat.
  if (!target || target.audience !== "dealer") return;

  const amount = inr(p.loanAmount);
  const lender = p.lenderName || "the lender";
  const result = await pushToLead(p.leadId, (t) => ({
    prompt: {
      kind: "text",
      body:
        `${p.reminder ? "⏰ *Reminder — " : "💰 *"}Did the loan payment reach you?*\n\n` +
        `Customer: ${t.customerName} · ${t.referenceId}\n` +
        `${lender} has disbursed${amount ? ` ${amount}` : ""} for this loan.\n\n` +
        "Please confirm whether the money has arrived in your account.",
      buttons: [
        { id: leadActionId("pay_ok", p.leadId), title: "✅ Received" },
        { id: leadActionId("pay_no", p.leadId), title: "❌ Not received" },
      ],
    },
    nudge: {
      template: "lead_action",
      params: [
        oneLine(t.greetName),
        oneLine(t.referenceId),
        `please confirm the loan payment for ${t.customerName} reached you`,
      ],
    },
  }));
  console.log(`[WhatsApp/payment-confirm] prompt lead=${p.leadId}: ${result}`);
}

/** The customer arm of the lead gate is not good enough for money questions. */
async function isDealerSide(waPhone: string, dealer: ActiveDealer): Promise<boolean> {
  const d = await resolveWhatsAppDealer(waPhone);
  if (d && d.dealerCode === dealer.dealerCode) return true;
  const sp = await resolveSalesperson(waPhone);
  return Boolean(sp && sp.dealerCode === dealer.dealerCode);
}

async function answer(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
  leadId: string,
  received: boolean,
): Promise<void> {
  if (!(await isDealerSide(event.waPhone, dealer))) {
    await reply(session, "Only the dealer can confirm a loan payment. Please contact your dealer.");
    return;
  }
  const sanction = await pendingSanctionForLead(leadId);
  if (!sanction) {
    await reply(session, "There is no loan payment waiting for your confirmation on this file.");
    return;
  }
  try {
    await recordDealerPaymentConfirmation({
      sanctionId: sanction.id,
      dealerId: dealer.dealerCode,
      received,
      remarks: received ? null : "Reported not received via WhatsApp",
      confirmedBy: `whatsapp:${event.waPhone}`,
    });
  } catch (err) {
    if (err instanceof PaymentConfirmationError) {
      await reply(
        session,
        err.status === 409
          ? "✅ This payment is already confirmed as received. Nothing more to do."
          : "I couldn't find that loan any more. Please check the lead in the iTarang portal.",
      );
      return;
    }
    throw err;
  }
  await reply(
    session,
    received
      ? "✅ Thanks — payment marked as *received*. The lender and iTarang have been informed."
      : "⚠️ Noted — payment marked as *not received*. iTarang and the lender have been alerted and will look into it.\n\n" +
          "You can add the bank reference or a remark on the lead's Step 5 page in the iTarang portal.",
  );
}

registerLeadAction("pay_ok", (session, event, dealer, leadId) =>
  answer(session, event, dealer, leadId, true),
);
registerLeadAction("pay_no", (session, event, dealer, leadId) =>
  answer(session, event, dealer, leadId, false),
);
