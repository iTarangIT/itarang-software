/**
 * E-264 Phase 4 — Step 5, dispatch, over WhatsApp.
 *
 * WHERE THE LINE IS DRAWN, AND WHY.
 *
 * Step 5 is two different things wearing one name:
 *
 *   1. The customer AUTHORISING delivery — they receive a code and read it back.
 *      That is a conversation, and it belongs in chat.
 *
 *   2. The dealer COMMITTING the sale — reserving a specific battery serial,
 *      marking the loan disbursed, projecting the EMI schedule, creating the
 *      warranty. That is one database transaction that moves stock and money,
 *      and it 409s on an oversell race.
 *
 * This module does (1) and deliberately does not do (2). The customer's code
 * stamps the OTP row as verified; the dealer then presses Confirm Dispatch on
 * the Step-5 screen with no code to retype, because the customer has already
 * authorised it. Putting the commit in chat would mean a mistyped serial failing
 * mid-transaction after stock had already moved, with nobody at a screen to see
 * it — and the person who owns the stock is the dealer, not the customer.
 *
 * The product cart is a link-out for the same reason: twenty numeric fields of
 * GST snapshot are not a chat interaction.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads, loanSanctions, productSelections } from "@/lib/db/schema";
import { sendDispatchOtp, verifyDispatchOtp } from "@/lib/leads/dispatch-otp";

import type { ActiveDealer } from "./customer-lead";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead } from "./lead-push";
import { registerLeadState } from "./lead-states";
import type { ParkedPrompt } from "./outbound";
import { patchLeadSub, reply, setSession, type SessionRow } from "./session-store";
import type { InboundEvent, ReplyButton } from "./types";
import { oneLine } from "./window";

export const DC_DP_OTP = "DC_DP_OTP";
export const DC_DP_WAIT = "DC_DP_WAIT";

// ---------------------------------------------------------------------------
// Entry: the loan has been sanctioned
// ---------------------------------------------------------------------------

/**
 * Tell the customer their loan is sanctioned and delivery can be arranged.
 *
 * Called from the NBFC sanction route. Best-effort — the sanction is already
 * committed and must not be undone by a messaging failure.
 */
export async function pushDispatchReady(leadId: string): Promise<void> {
  const [lead] = await db
    .select({
      reference_id: leads.reference_id,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  const [loan] = await db
    .select({ emi: loanSanctions.emi, loan_amount: loanSanctions.loan_amount })
    .from(loanSanctions)
    .where(eq(loanSanctions.lead_id, leadId))
    .orderBy(desc(loanSanctions.created_at))
    .limit(1);

  const name = lead?.full_name || lead?.owner_name || "there";
  const ref = lead?.reference_id || leadId;
  const emiLine = loan?.emi ? `EMI ₹${loan.emi}` : "";

  const prompt: ParkedPrompt = {
    kind: "text",
    body:
      `🎉 *Your loan is sanctioned!*\n\n` +
      `${name}, application ${ref} has been approved` +
      (loan?.loan_amount ? ` for ₹${loan.loan_amount}` : "") +
      (emiLine ? ` — ${emiLine}` : "") +
      `.\n\nWhen you're ready to take delivery, tap below and we'll send a ` +
      `confirmation code to this number.`,
    buttons: [{ id: leadActionId("dp_start", leadId), title: "📦 Arrange delivery" }],
  };

  await pushToLead(leadId, {
    prompt,
    nudge: {
      template: "lead_action",
      params: [oneLine(name), oneLine(ref), "your loan is sanctioned"],
    },
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const RESEND_BUTTON: ReplyButton[] = [
  { id: "dp_resend", title: "🔁 Resend code" },
];

/** `dp_start:<leadId>` — check the gates, then send the code. */
async function onDispatchStart(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const [lead] = await db
    .select({ kyc_status: leads.kyc_status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (lead?.kyc_status === "dispatched" || lead?.kyc_status === "sold") {
    await reply(session, "✅ This order has already been dispatched.");
    return;
  }
  if (lead?.kyc_status !== "loan_sanctioned") {
    await reply(
      session,
      "Your loan isn't ready for delivery yet. We'll message you here the moment it is.",
    );
    return;
  }

  // The dealer must have committed a battery serial first — the confirm
  // transaction refuses without one, so sending a code before that exists would
  // burn one of the customer's three sends on a step that cannot complete.
  const [selection] = await db
    .select({ battery_serial: productSelections.battery_serial })
    .from(productSelections)
    .where(eq(productSelections.lead_id, leadId))
    .orderBy(desc(productSelections.created_at))
    .limit(1);

  if (!selection?.battery_serial) {
    await setSession(session.id, { current_state: DC_DP_WAIT });
    await reply(
      session,
      "📦 Almost there — your dealer is preparing the battery for your order.\n\n" +
        "We'll message you here with a confirmation code as soon as it's ready.",
    );
    return;
  }

  await sendCode(session, leadId);
}

async function sendCode(session: SessionRow, leadId: string): Promise<void> {
  const res = await sendDispatchOtp({ leadId, prefer: "whatsapp" });
  if (!res.ok) {
    await reply(session, `⚠️ ${res.error}`);
    return;
  }

  await patchLeadSub(session.id, "dp", { otpChannel: res.channel });
  await setSession(session.id, { current_state: DC_DP_OTP });

  const how =
    res.channel === "whatsapp"
      ? "here on WhatsApp"
      : res.channel === "call"
        ? "by voice call"
        : res.channel === "sms"
          ? "by SMS"
          : "(dev mode)";

  await reply(
    session,
    `🔐 A 6-digit delivery confirmation code has been sent ${how} to ${res.maskedPhone}.\n\n` +
      `Please type the 6 digits here. It expires in 10 minutes.` +
      (res.devOtp ? `\n\n_Dev mode — the code is ${res.devOtp}._` : ""),
    RESEND_BUTTON,
  );
}

/** DC_DP_OTP — the customer reads the code back. */
async function onDispatchOtp(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  const leadId = ctx.lead?.leadId;
  if (!leadId) {
    await reply(session, "I've lost track of this order. Please send *hi* to start again.");
    return;
  }

  const raw = (event.text ?? "").trim();
  if (raw.toLowerCase() === "dp_resend" || raw.toLowerCase() === "resend") {
    return await sendCode(session, leadId);
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 6) {
    await reply(session, "Please type the *6-digit* code you received.", RESEND_BUTTON);
    return;
  }

  const res = await verifyDispatchOtp({ leadId, otp: digits });
  if (!res.ok) {
    await reply(
      session,
      `⚠️ ${res.error}` +
        (res.attemptsLeft !== undefined && res.attemptsLeft > 0
          ? ` ${res.attemptsLeft} attempt${res.attemptsLeft === 1 ? "" : "s"} left.`
          : ""),
      RESEND_BUTTON,
    );
    return;
  }

  // Verified, NOT consumed — confirm-dispatch consumes it inside the dispatch
  // transaction. See the file header for why the commit stays with the dealer.
  await setSession(session.id, { current_state: DC_DP_WAIT });
  await reply(
    session,
    "✅ *Delivery confirmed — thank you!*\n\n" +
      "Your dealer can now hand over the battery. You'll get a message here once " +
      "it's dispatched, with your warranty details.",
  );
}

/** DC_DP_WAIT — parked, either pre-cart or post-authorisation. */
async function onDispatchWait(session: SessionRow): Promise<void> {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  const leadId = ctx.lead?.leadId;
  if (!leadId) {
    await reply(session, "Please send *hi* to see your options.");
    return;
  }

  const [lead] = await db
    .select({ kyc_status: leads.kyc_status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (lead?.kyc_status === "dispatched" || lead?.kyc_status === "sold") {
    await reply(session, "✅ Your battery has been dispatched. Enjoy!");
    return;
  }
  await reply(
    session,
    "Nothing more is needed from you right now — we'll message you here as soon as there's an update.",
  );
}

/**
 * Announce the completed dispatch. Called from confirm-dispatch's post-commit
 * block, alongside the SMS it already sends.
 */
export async function pushDispatched(
  leadId: string,
  batterySerial?: string | null,
): Promise<void> {
  const [lead] = await db
    .select({
      reference_id: leads.reference_id,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  const name = lead?.full_name || lead?.owner_name || "there";
  const ref = lead?.reference_id || leadId;

  await pushToLead(leadId, {
    prompt: {
      kind: "text",
      body:
        `📦 *Dispatched!*\n\n${name}, your iTarang battery` +
        (batterySerial ? ` (serial *${batterySerial}*)` : "") +
        ` is on its way and your warranty is now active.\n\n` +
        `Thank you for choosing iTarang.`,
    },
    nudge: {
      template: "dispatch_done",
      params: [oneLine(name), oneLine(ref), oneLine(batterySerial ?? "—")],
    },
  });
}

registerLeadAction("dp_start", onDispatchStart);
registerLeadState(DC_DP_OTP, onDispatchOtp);
registerLeadState(DC_DP_WAIT, onDispatchWait);
