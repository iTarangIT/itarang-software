/**
 * E-264 Phase 4 — choosing a battery over WhatsApp, for BOTH payment paths.
 *
 * The picker (`askBattery` → `DC_DP_PRODUCT` → `DC_DP_CHARGER`) is shared. What
 * happens at the end forks on the LEAD'S payment method, in `completeOrder`:
 *
 *   - **cash** — the sale closes in chat. Inventory goes available → SOLD, the
 *     warranty and after-sales rows are created, the lead ends 'sold'. That is
 *     the web cash path exactly: it completes at Step 4, skips 'dispatched'
 *     entirely, and has never had an OTP.
 *   - **finance** — the choice is saved and the chat hands over. No stock moves.
 *
 * WHERE THE FINANCE LINE IS DRAWN, AND WHY.
 *
 * For a finance lead the chat collects the PRODUCT CHOICE and stops. It does not
 * send a delivery confirmation code and it does not commit the sale.
 *
 * That boundary has moved twice, so it is worth recording why it sits here.
 * Originally the chat sent a code and the dealer confirmed on the Step-5 screen.
 * Then the whole step ran in chat, code and commit included. Reading the real
 * conversation settled it: asking a customer to type a six-digit code to
 * complete their own delivery is asking them to do the dealer's job. The dealer
 * is the one standing there with the battery, and the OTP exists so that THEY
 * can prove the customer accepted it.
 *
 * So the customer picks, the choice is written to `product_selections`, and the
 * chat says the team will be in touch. The dealer's Step-5 screen then opens
 * pre-filled with that choice and runs the OTP and Confirm Dispatch as it always
 * has.
 *
 * This is unconditional — self-serve customer leads and dealer-onboarded leads
 * end identically. Do NOT gate it on `ctx.flow === "customer"`: that flag is
 * per-turn-ACTOR, not per-lead (leadActionReply.ts sets it whenever the sending
 * phone matches the lead's contact number), so a customer answering on a
 * dealer-run lead would flip it and the same lead would end two different ways
 * depending on which phone replied.
 *
 * THE CUSTOMER STILL GETS CLOSURE. `pushDispatched()` below is called from
 * `confirmDispatch()`'s post-commit block, which the dealer's Step-5 confirm
 * runs — so the "Dispatched!" message with the warranty still arrives in this
 * chat, triggered by the dealer's action instead of the customer's.
 *
 * WHAT IS DELIBERATELY NOT IN CHAT. Paraphernalia lines. A multi-line quantity
 * cart with per-line GST is not a chat interaction, and guessing on the
 * customer's behalf would put numbers on an invoice nobody chose. The battery
 * and charger carry their own GST snapshot from the inventory row, so the total
 * shown is exact, and the dealer can still add paraphernalia on the Step-5
 * screen.
 *
 * ── THE DEALER'S LEG (E-268) ────────────────────────────────────────────────
 *
 * Everything above describes the CUSTOMER picking for themselves, and it is
 * unchanged. When the person tapping through the picker is the DEALER — which,
 * because `pushDispatchReady` resolves dealer-first, is the common case — four
 * more steps run between the charger pick and the handoff:
 *
 *   DC_DP_MARGIN      how do you want to add your margin? % / ₹ / none
 *   DC_DP_MARGIN_VAL  the figure, typed
 *   DC_DP_SEND        a preview of the customer's card, with Send
 *   DC_DP_OTP         Send OTP (call) → the dealer types the code the customer
 *                     read out → confirmDispatch
 *
 * WHY THE MARGIN IS ASKED HERE AND NOT LEFT AT ZERO. It used to be zero because
 * only the customer could reach this picker, and a customer cannot set their
 * dealer's margin. A dealer can, and for a dealer-run order the Step-5 screen is
 * the only place they could — which means the chat was quoting a price the
 * dealer had not agreed to and then handing over anyway.
 *
 * WHY THE CUSTOMER NEVER SEES THE MARGIN. The card the dealer sends carries the
 * model, the serial and ONE total. Per-line prices are dropped from it on
 * purpose: with the line prices and the total both present, the margin is a
 * subtraction away. The dealer's own preview shows the breakdown and says so.
 *
 * WHY THE OTP MOVED BACK INTO THE CHAT — for this leg only. The reasoning above
 * (a customer should not type a code to complete their own delivery) is about
 * the CUSTOMER doing it. Here the dealer is the one confirming, which is exactly
 * what the OTP is for: the code goes by voice call to the customer's registered
 * number, the customer reads it out, the dealer types it. That is the Step-5
 * screen's flow, in the chat the dealer is already in. The customer-driven path
 * still mints no code and still hands over — see `completeOrder`.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads, loanSanctions, productSelections } from "@/lib/db/schema";
import { saveStep5ProductSelection } from "@/lib/leads/step5-product";
import { CashSaleError, confirmCashSale } from "@/lib/leads/confirm-cash-sale";
import { DispatchError, confirmDispatch } from "@/lib/leads/confirm-dispatch";
import { sendDispatchOtp } from "@/lib/leads/dispatch-otp";
import { toPaymentMode } from "@/lib/sales/payment-mode";
import {
  listDealerBatteries,
  listDealerChargers,
  type DealerStockItem,
} from "@/lib/inventory/dealer-stock";

import type { ActiveDealer } from "./customer-lead";
import {
  finalPriceOf,
  MARGIN_GST_PCT,
  marginAmount,
  marginGst,
  marginLabel,
  parseMarginInput,
  type MarginMode,
} from "./dealer-margin";
import { leadActionId } from "./leadActionButton";
import { authorizeLeadAction, registerLeadAction } from "./leadActionReply";
import {
  pushToLead,
  pushToLeadBoth,
  pushToLeadCustomer,
  type PushResult,
} from "./lead-push";
import { registerLeadState } from "./lead-states";
import {
  patchLeadSub,
  reply,
  replyList,
  setSession,
  setSessionIf,
  type SessionRow,
} from "./session-store";
import {
  MAX_ROWS,
  inr,
  lineTotal,
  stockRows,
} from "./stock-rows";
import type { InboundEvent } from "./types";
import { oneLine } from "./window";

export const DC_DP_PRODUCT = "DC_DP_PRODUCT";
export const DC_DP_CHARGER = "DC_DP_CHARGER";
/** Dealer leg — see the header. */
export const DC_DP_MARGIN = "DC_DP_MARGIN";
export const DC_DP_MARGIN_VAL = "DC_DP_MARGIN_VAL";
export const DC_DP_SEND = "DC_DP_SEND";
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
  const [loan] = await db
    .select({ emi: loanSanctions.emi, loan_amount: loanSanctions.loan_amount })
    .from(loanSanctions)
    .where(eq(loanSanctions.lead_id, leadId))
    .orderBy(desc(loanSanctions.created_at))
    .limit(1);

  const emiLine = loan?.emi ? `EMI ₹${loan.emi}` : "";

  await pushToLead(leadId, (t) => {
    const dealerSide = t.audience === "dealer";
    return {
      prompt: {
        kind: "text",
        body:
          (dealerSide
            ? `🎉 *${t.customerName}'s loan is sanctioned!*\n\n${t.greetName}, application ${t.referenceId} has been approved`
            : `🎉 *Your loan is sanctioned!*\n\n${t.greetName}, application ${t.referenceId} has been approved`) +
          (loan?.loan_amount ? ` for ₹${loan.loan_amount}` : "") +
          (emiLine ? ` — ${emiLine}` : "") +
          (dealerSide
            ? `.\n\nTap below to choose the battery and arrange delivery.`
            : `.\n\nTap below to choose your battery and arrange delivery.`),
        buttons: [
          { id: leadActionId("dp_start", leadId), title: "📦 Choose battery" },
        ],
      },
      nudge: {
        template: "lead_action",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          dealerSide
            ? `${t.customerName}'s loan is sanctioned`
            : "your loan is sanctioned",
        ],
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The one line this phase ends on, wherever it ends. */
const HANDOFF = "iTarang Team will connect you for further process and detail.";

/**
 * `dp_start:<leadId>` — check the gates, then open the picker.
 *
 * Exported because the offer phase's `sn_ack` button lands here: acknowledging
 * the sanction and starting delivery are the same step from the customer's side.
 */
export async function startDispatch(
  session: SessionRow,
  _event: InboundEvent,
  dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const [lead] = await db
    .select({ kyc_status: leads.kyc_status, payment_method: leads.payment_method })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (lead?.kyc_status === "dispatched" || lead?.kyc_status === "sold") {
    await reply(session, "✅ This order has already been dispatched.");
    return;
  }
  if (!readyToPick(lead)) {
    await reply(
      session,
      "Your loan isn't ready for delivery yet. We'll message you here the moment it is.",
    );
    return;
  }

  await askBattery(session, leadId, dealer, 0);
}

/**
 * DC_DP_PRODUCT — one row per available battery in the dealer's stock.
 *
 * Exported because the CASH flow enters the picker here directly: it has no
 * sanction to check, so it cannot come through `startDispatch`'s gate.
 */
export async function askBattery(
  session: SessionRow,
  leadId: string,
  dealer: ActiveDealer,
  page: number,
): Promise<void> {
  const category = await leadCategory(leadId);
  const batteries = await listDealerBatteries({
    dealerId: dealer.dealerCode,
    category,
  });

  if (batteries.length === 0) {
    // Nothing to choose from is the dealer's problem to solve, not the
    // customer's — park rather than leave them tapping an empty list.
    await setSession(session.id, { current_state: DC_DP_WAIT });
    await reply(
      session,
      "📦 Almost there — your dealer is arranging stock for your order.\n\n" +
        "We'll message you here as soon as a battery is ready for you.",
    );
    return;
  }

  await setSession(session.id, { current_state: DC_DP_PRODUCT });
  await patchLeadSub(session.id, "dp", { page });

  await replyList(
    session,
    `🔋 *Choose your battery*\n\n` +
      `These are ready to go from your dealer. ⭐ is the one we recommend.\n\n` +
      `_Prices include GST._`,
    "Pick a battery",
    stockRows(batteries, "dpb", page),
  );
}

/**
 * Wake a chat that `askBattery` parked on DC_DP_WAIT because the dealer had no
 * stock at the time.
 *
 * `onDispatchWait` heals the same state, but only when the customer happens to
 * send another message — and a customer who has just been told "we'll message
 * you here" has been given every reason not to. This is the other half: the
 * dealer's stock arrives, and the chat re-opens on its own.
 *
 * SAFE TO CALL ON ANY LEAD. It re-reads the lead and refuses anything that is
 * not a sanctioned finance order still waiting to choose — the button it sends
 * (`dp_start`) is gated on `kyc_status === 'loan_sanctioned'`, so pushing it at
 * a cash or already-dispatched lead would land the customer on a confusing
 * refusal. The caller does not have to pre-filter.
 *
 * RETURN VALUE IS ROUTING, NOT DELIVERY. `"skipped"` means this lead did not
 * qualify; anything else is whatever `pushToLead` decided to do with it.
 * `"session"` means the message was handed to the adapter for an existing
 * chat — it is NOT proof Meta accepted it, because `sendOrPark` logs and
 * swallows adapter failures (an expired `META_WA_ACCESS_TOKEN` returns
 * `"session"` while nothing reaches the customer). A caller that needs to know
 * the message actually landed must check `whatsapp_messages` for a row with a
 * non-null `provider_message_id`.
 */
export async function pushStockReady(
  leadId: string,
): Promise<PushResult | "skipped"> {
  const [lead] = await db
    .select({ kyc_status: leads.kyc_status, payment_method: leads.payment_method })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!readyToPick(lead)) return "skipped";

  return await pushToLead(leadId, (t) => {
    const dealerSide = t.audience === "dealer";
    return {
      prompt: {
        kind: "text",
        body: dealerSide
          ? `🔋 *Stock is ready*\n\n${t.greetName}, batteries are now available for ` +
            `${t.customerName}'s order ${t.referenceId}.\n\nTap below to choose one and arrange delivery.`
          : `🔋 *Stock is ready*\n\n${t.greetName}, your dealer now has batteries available ` +
            `for order ${t.referenceId}.\n\nTap below to choose yours and arrange delivery.`,
        buttons: [
          { id: leadActionId("dp_start", leadId), title: "📦 Choose battery" },
        ],
      },
      nudge: {
        template: "lead_action",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          dealerSide
            ? `stock is ready for ${t.customerName}`
            : "your battery is ready to choose",
        ],
      },
    };
  });
}

/** DC_DP_PRODUCT — a tapped battery row. */
async function onBatteryPick(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await lost(session);

  const raw = (event.text ?? "").trim();
  const dp = dpCtx(session);

  if (raw === "dpb_more") {
    return await askBattery(session, leadId, dealer, (dp.page ?? 0) + 1);
  }

  const m = raw.match(/^dpb:(.+)$/);
  if (!m) {
    // Not a row we recognise — re-render rather than guess.
    return await askBattery(session, leadId, dealer, dp.page ?? 0);
  }
  const serial = m[1].trim();

  // Re-read stock rather than trusting the tapped row: the list may have been
  // rendered minutes ago and this battery may already be gone.
  const category = await leadCategory(leadId);
  const batteries = await listDealerBatteries({
    dealerId: dealer.dealerCode,
    category,
  });
  const chosen = batteries.find((b) => b.serial_number === serial);
  if (!chosen) {
    await reply(
      session,
      "That battery has just been taken. Here's what's still available:",
    );
    return await askBattery(session, leadId, dealer, 0);
  }

  await patchLeadSub(session.id, "dp", { batterySerial: serial, page: 0 });
  await askCharger(session, leadId, dealer, chosen, 0);
}

/** DC_DP_CHARGER — optional; a charger is not required to dispatch. */
async function askCharger(
  session: SessionRow,
  leadId: string,
  dealer: ActiveDealer,
  battery: DealerStockItem,
  page: number,
): Promise<void> {
  const category = await leadCategory(leadId);
  const chargers = await listDealerChargers({
    dealerId: dealer.dealerCode,
    category,
  });

  if (chargers.length === 0) {
    // No charger stock is not a blocker — the battery alone can ship.
    return await beginPricing(session, leadId, dealer, battery, null);
  }

  await setSession(session.id, { current_state: DC_DP_CHARGER });
  await patchLeadSub(session.id, "dp", { page });

  const rows = stockRows(chargers, "dpc", page);
  rows.push({
    id: "dpc_skip",
    title: "⏭ No charger",
    description: "I already have a compatible charger".slice(0, 72),
  });

  await replyList(
    session,
    `⚡ *Add a charger?*\n\n` +
      `Your battery: *${battery.model_name ?? battery.serial_number}* — ${inr(lineTotal(battery))}\n\n` +
      `Pick a charger to add it to your order, or skip if you already have one.`,
    "Pick a charger",
    rows.slice(0, MAX_ROWS),
  );
}

/** DC_DP_CHARGER — a tapped charger row, or the skip. */
async function onChargerPick(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await lost(session);

  const dp = dpCtx(session);
  const batterySerial = dp.batterySerial;
  if (!batterySerial) {
    // Lost the battery choice somehow — start the picker again rather than
    // saving half a cart.
    return await askBattery(session, leadId, dealer, 0);
  }

  const category = await leadCategory(leadId);
  const batteries = await listDealerBatteries({
    dealerId: dealer.dealerCode,
    category,
  });
  const battery = batteries.find((b) => b.serial_number === batterySerial);
  if (!battery) {
    await reply(session, "That battery has just been taken. Here's what's still available:");
    return await askBattery(session, leadId, dealer, 0);
  }

  const raw = (event.text ?? "").trim();
  if (raw === "dpc_skip") {
    return await beginPricing(session, leadId, dealer, battery, null);
  }
  if (raw === "dpc_more") {
    return await askCharger(session, leadId, dealer, battery, (dp.page ?? 0) + 1);
  }

  const m = raw.match(/^dpc:(.+)$/);
  if (!m) return await askCharger(session, leadId, dealer, battery, dp.page ?? 0);

  const chargers = await listDealerChargers({
    dealerId: dealer.dealerCode,
    category,
  });
  const charger = chargers.find((c) => c.serial_number === m[1].trim()) ?? null;
  if (!charger) {
    await reply(session, "That charger has just been taken. Here's what's left:");
    return await askCharger(session, leadId, dealer, battery, 0);
  }

  await beginPricing(session, leadId, dealer, battery, charger);
}

// ---------------------------------------------------------------------------
// Dealer leg: margin → preview → send → OTP
// ---------------------------------------------------------------------------

/**
 * Is the person tapping through this picker the DEALER who owns the lead?
 *
 * NOT `ctx.flow === "customer"`. That flag is set the first time a customer
 * answers on a lead and is never cleared, so a dealer whose own number happens
 * to sit on one of their leads as the contact number would be locked out of the
 * margin steps on every lead afterwards. `authorizeLeadAction` asks the question
 * that actually matters — does this Meta address resolve to the dealer that owns
 * this lead — and it is the same check that admitted the button press in the
 * first place.
 *
 * Fails CLOSED. If the lookup throws we treat the actor as the customer, which
 * skips the margin steps and lands on the pre-existing hand-over path. The worst
 * case is a dealer who has to set the margin on the Step-5 screen; the worst
 * case the other way round is a customer being asked to price their own order.
 */
async function actingAsDealer(
  session: SessionRow,
  leadId: string,
): Promise<boolean> {
  try {
    const auth = await authorizeLeadAction(session.wa_phone, leadId);
    return auth.ok && auth.actor === "dealer";
  } catch (err) {
    console.error("[dispatch-flow] actor check failed:", err);
    return false;
  }
}

/**
 * The cart is chosen. Fork on WHO chose it.
 *
 * The serials are written to the session first, and every step after this
 * re-reads stock from them (`resolvePicked`). They have to be: each of the steps
 * below is a separate inbound message minutes apart, and a `DealerStockItem`
 * carried in a closure across that gap is a price snapshot that may no longer be
 * for sale.
 */
async function beginPricing(
  session: SessionRow,
  leadId: string,
  dealer: ActiveDealer,
  battery: DealerStockItem,
  charger: DealerStockItem | null,
): Promise<void> {
  await patchLeadSub(session.id, "dp", {
    batterySerial: battery.serial_number,
    chargerSerial: charger?.serial_number ?? null,
    page: 0,
    // Nulls, not undefined: patchLeadSub merges JSON.stringify(patch), which
    // DROPS undefined keys — so a re-run of the picker would silently inherit
    // the margin from the abandoned one.
    marginMode: null,
    marginValue: null,
    marginAmount: null,
    marginGst: null,
    orderSentAt: null,
  });

  if (!(await actingAsDealer(session, leadId))) {
    // The customer is choosing for themselves. There is no margin to ask about
    // and nobody in this chat entitled to set one.
    return await completeOrder(session, leadId, dealer, battery, charger, 0, false);
  }

  await askMarginMode(session, battery, charger);
}

/** DC_DP_MARGIN — percentage, rupees, or none. */
async function askMarginMode(
  session: SessionRow,
  battery: DealerStockItem,
  charger: DealerStockItem | null,
): Promise<void> {
  await setSession(session.id, { current_state: DC_DP_MARGIN });
  await reply(
    session,
    `💰 *Your margin*\n\n` +
      pricedLines(battery, charger) +
      `\n*Stock value ${inr(stockValue(battery, charger))}* _(incl. GST)_\n\n` +
      `How do you want to add your margin?\n` +
      `_The customer only ever sees the final total._`,
    [
      { id: "dpm_pct", title: "Percentage (%)" },
      { id: "dpm_amt", title: "Amount (₹)" },
      { id: "dpm_none", title: "No margin" },
    ],
  );
}

/** DC_DP_MARGIN — a tapped mode. */
async function onMarginMode(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await lost(session);

  const picked = await resolvePicked(session, leadId, dealer);
  if (!picked) return;

  const raw = (event.text ?? "").trim();

  if (raw === "dpm_none") {
    await patchLeadSub(session.id, "dp", {
      marginMode: null,
      marginValue: 0,
      marginAmount: 0,
      marginGst: 0,
    });
    return await showOrderPreview(session, leadId, picked.battery, picked.charger, 0);
  }

  const mode: MarginMode | null =
    raw === "dpm_pct" ? "percent" : raw === "dpm_amt" ? "rupees" : null;
  if (!mode) {
    // Anything else — re-render rather than guess which one they meant.
    return await askMarginMode(session, picked.battery, picked.charger);
  }

  await patchLeadSub(session.id, "dp", { marginMode: mode });
  await setSession(session.id, { current_state: DC_DP_MARGIN_VAL });
  await reply(
    session,
    mode === "percent"
      ? `📊 *What percentage?*\n\nReply with the number only — e.g. *5* for 5%, or *7.5* for 7.5%.`
      : `💵 *How much, in rupees?*\n\nReply with the number only — e.g. *3000*.`,
  );
}

/** DC_DP_MARGIN_VAL — the typed figure. */
async function onMarginValue(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await lost(session);

  const picked = await resolvePicked(session, leadId, dealer);
  if (!picked) return;

  const dp = dpCtx(session);
  const mode: MarginMode | null =
    dp.marginMode === "percent" || dp.marginMode === "rupees" ? dp.marginMode : null;
  if (!mode) {
    // The mode is gone (a reset, or a push that rewrote the sub-object). Ask for
    // it again rather than assuming rupees — assuming would turn "5" into ₹5.
    return await askMarginMode(session, picked.battery, picked.charger);
  }

  const parsed = parseMarginInput(mode, event.text);
  if (!parsed.ok) {
    // Stay on this state; the dealer types again.
    return await reply(session, `⚠️ ${parsed.error}`);
  }

  const base = stockValue(picked.battery, picked.charger);
  const amount = marginAmount(mode, parsed.value, base);
  await patchLeadSub(session.id, "dp", {
    marginValue: parsed.value,
    marginAmount: amount,
    marginGst: marginGst(amount),
  });

  await showOrderPreview(
    session,
    leadId,
    picked.battery,
    picked.charger,
    amount,
    marginLabel(mode, parsed.value),
  );
}

/**
 * DC_DP_SEND — what the customer is about to receive, before they receive it.
 *
 * The card between the rules is the same string `sendOrderCard` will push, so
 * "preview" means preview. The breakdown underneath it is the dealer's only view
 * of their own margin, and the message says it is not part of what gets sent.
 */
async function showOrderPreview(
  session: SessionRow,
  leadId: string,
  battery: DealerStockItem,
  charger: DealerStockItem | null,
  margin: number,
  marginText?: string,
): Promise<void> {
  const base = stockValue(battery, charger);
  const gst = marginGst(margin);
  const total = finalPriceOf(base, margin, gst);
  const facts = await leadFacts(leadId);
  const cash = isCashLead(facts?.payment_method);

  await setSession(session.id, { current_state: DC_DP_SEND });
  await reply(
    session,
    `👀 *Preview — not sent yet*\n\n` +
      `This is exactly what ${firstName(facts)} will see:\n\n` +
      `———\n${customerOrderCard(battery, charger, total)}\n———\n\n` +
      (margin > 0
        ? `_Stock ${inr(base)} + your margin ${marginText ?? inr(margin)} + ${MARGIN_GST_PCT}% GST on margin ${inr(gst)} = ${inr(total)}._\n` +
          `_That line is yours only — the margin and its GST are not itemised in the message above._`
        : `_No margin added._`),
    [
      { id: "dps_send", title: cash ? "✅ Send & confirm" : "✅ Send to customer" },
      { id: "dps_margin", title: "✏️ Edit margin" },
      { id: "dps_battery", title: "🔙 Change battery" },
    ],
  );
}

/** DC_DP_SEND — Send / Edit margin / Change battery. */
async function onSendPreview(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await lost(session);

  const picked = await resolvePicked(session, leadId, dealer);
  if (!picked) return;

  const raw = (event.text ?? "").trim();
  const dp = dpCtx(session);
  const margin = Number(dp.marginAmount) || 0;

  if (raw === "dps_margin") {
    return await askMarginMode(session, picked.battery, picked.charger);
  }
  if (raw === "dps_battery") {
    return await askBattery(session, leadId, dealer, 0);
  }
  if (raw !== "dps_send") {
    const mode: MarginMode | null =
      dp.marginMode === "percent" || dp.marginMode === "rupees" ? dp.marginMode : null;
    return await showOrderPreview(
      session,
      leadId,
      picked.battery,
      picked.charger,
      margin,
      mode && dp.marginValue !== undefined && dp.marginValue !== null
        ? marginLabel(mode, Number(dp.marginValue))
        : undefined,
    );
  }

  // A double-tap on Send must not save the cart twice or message the customer
  // twice. The state is claimed before any of it runs; completeOrder puts it
  // back on DC_DP_SEND if the save refuses.
  if (!(await setSessionIf(session.id, DC_DP_SEND, { current_state: DC_DP_WAIT }))) {
    return;
  }
  await completeOrder(
    session,
    leadId,
    dealer,
    picked.battery,
    picked.charger,
    margin,
    true,
  );
}

/**
 * The end of the picker, for BOTH payment paths.
 *
 * The fork is on the lead's own payment method, not on who is chatting:
 *   - **cash** → the sale closes here. `confirmCashSale()` writes the selection,
 *     moves the battery available → SOLD, creates the warranty and the
 *     after-sales record, and sets the lead to 'sold'. That mirrors the web
 *     exactly: cash completes at Step 4, skips 'dispatched', and has no OTP.
 *   - **finance** → the selection is saved. A customer-driven order hands over
 *     here exactly as it always has; a dealer-driven one goes on to the OTP.
 *
 * Either way the chat writes only what was actually chosen: paraphernalia stays
 * empty (see the file header) and the margin is whatever the dealer set — zero
 * when the customer is the one picking. The GST figures come straight off the
 * inventory rows, so the total shown is the real one.
 */
async function completeOrder(
  session: SessionRow,
  leadId: string,
  dealer: ActiveDealer,
  battery: DealerStockItem,
  charger: DealerStockItem | null,
  margin: number,
  dealerDriven: boolean,
): Promise<void> {
  const batteryNet = lineTotal(battery);
  const chargerNet = charger ? lineTotal(charger) : 0;
  const netSubtotal = batteryNet + chargerNet;
  const gst = marginGst(margin);
  const total = finalPriceOf(netSubtotal, margin, gst);

  const num = (v: string | null | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const lead = await leadFacts(leadId);

  // The line snapshot both paths write. Built once so a cash sale and a finance
  // selection can never disagree about the price the customer was shown.
  // `netSubtotal` is the ITEMS only and `finalPrice` carries the margin plus 18% GST on it — the
  // `netSubtotal` is the ITEMS only and `finalPrice` carries the margin — the
  // same split `computeTotals` uses in the web cart, so the Step-5 screen reads
  // back a row it would itself have written.
  const lineFields = {
    batterySerial: battery.serial_number,
    chargerSerial: charger?.serial_number ?? null,
    // Not offered in chat — see the file header.
    paraphernalia: {},
    paraphernaliaLines: [],
    paraphernaliaCost: 0,
    dealerMargin: margin,
    dealerMarginGstPercent: MARGIN_GST_PCT,
    dealerMarginGstAmount: gst,
    batteryPrice: batteryNet,
    chargerPrice: chargerNet || undefined,
    finalPrice: total,
    batteryGross: num(battery.gross_amount),
    batteryGstPercent: num(battery.gst_percent),
    batteryGstAmount: num(battery.gst_amount),
    batteryNet: num(battery.net_amount) ?? batteryNet,
    chargerGross: charger ? num(charger.gross_amount) : undefined,
    chargerGstPercent: charger ? num(charger.gst_percent) : undefined,
    chargerGstAmount: charger ? num(charger.gst_amount) : undefined,
    chargerNet: charger ? (num(charger.net_amount) ?? chargerNet) : undefined,
    grossSubtotal:
      (num(battery.gross_amount) ?? 0) + (charger ? (num(charger.gross_amount) ?? 0) : 0),
    gstSubtotal:
      (num(battery.gst_amount) ?? 0) + (charger ? (num(charger.gst_amount) ?? 0) : 0),
    netSubtotal,
    category: battery.asset_category ?? undefined,
    modelNumber: battery.model_type ?? undefined,
    batteryPhotoUrls: [],
    chargerPhotoUrls: [],
  };

  const orderLines =
    `🔋 ${battery.model_name ?? battery.serial_number} — ${inr(batteryNet)}\n` +
    (charger
      ? `⚡ ${charger.model_name ?? charger.serial_number} — ${inr(chargerNet)}\n`
      : "") +
    (margin > 0 ? `➕ Your margin — ${inr(margin)}\n` : "") +
    (gst > 0 ? `➕ GST on margin (${MARGIN_GST_PCT}%) — ${inr(gst)}\n` : "") +
    `\n*Total ${inr(total)}* _(incl. GST)_`;

  // --- Cash: the sale closes right here. ---------------------------------
  if (isCashLead(lead?.payment_method)) {
    try {
      const sale = await confirmCashSale({
        leadId,
        performedBy: dealer.uploaderId,
        dealerId: dealer.dealerCode,
        body: lineFields,
      });
      await setSession(session.id, { current_state: DC_DP_WAIT });
      // The dealer closed it; the customer still needs their own copy of what
      // they bought. Best-effort — the sale is committed either way.
      if (dealerDriven) {
        void sendOrderCard(leadId, battery, charger, total, true).catch(() => {});
      }
      await reply(
        session,
        `🧾 *Sale confirmed*\n\n${orderLines}\n\n` +
          `Serial *${sale.batterySerial}*\n` +
          warrantyLine(sale) +
          `\n\nThank you for choosing iTarang.`,
      );
    } catch (err) {
      // Stock taken between the pick and the confirm — the one failure this
      // flow must recover from rather than swallow.
      if (err instanceof CashSaleError && err.status === 409) {
        await reply(session, `⚠️ ${err.message}. Let's pick another one.`);
        await askBattery(session, leadId, dealer, 0);
        return;
      }
      console.error("[dispatch-flow] cash sale failed:", err);
      await reply(
        session,
        "⚠️ I couldn't complete that sale just now. Your dealer has been notified " +
          "and will finish it — nothing has been charged.",
      );
    }
    return;
  }

  // --- Finance: save the selection. ---------------------------------------
  try {
    const saved = await saveStep5ProductSelection({
      leadId,
      submittedBy: dealer.uploaderId,
      lead: {
        product_category_id: lead?.product_category_id ?? null,
        product_type_id: lead?.product_type_id ?? null,
      },
      body: lineFields,
    });
    await patchLeadSub(session.id, "dp", { selectionId: saved.productSelectionId });
  } catch (err) {
    console.error("[dispatch-flow] product save failed:", err);
    // Put the dealer back on Send so the tap is not lost. The customer-driven
    // path has no such state and re-renders on their next message instead.
    if (dealerDriven) await setSession(session.id, { current_state: DC_DP_SEND });
    await reply(
      session,
      "⚠️ I couldn't save that selection just now. Please try again in a moment.",
    );
    return;
  }

  // --- Customer picked for themselves: hand over, as always. --------------
  // Customer-facing: no rupee amounts (E-275) — the same card the dealer path
  // sends into the customer's chat.
  if (!dealerDriven) {
    await reply(
      session,
      `${customerOrderCard(battery, charger, total)}\n\n` + HANDOFF,
    );
    await setSession(session.id, { current_state: DC_DP_WAIT });
    return;
  }

  // --- Dealer sent it: the customer gets the card, the dealer gets the OTP. -
  const delivered = await sendOrderCard(leadId, battery, charger, total, false);
  await patchLeadSub(session.id, "dp", {
    orderSentAt: new Date().toISOString(),
    otpAttempts: 0,
  });
  await setSession(session.id, { current_state: DC_DP_OTP });

  await reply(
    session,
    (delivered === "none"
      ? `⚠️ *I couldn't reach the customer on WhatsApp* — there is no chat and no ` +
        `usable number on this lead. Read the order out to them instead:\n\n` +
        `${customerOrderCard(battery, charger, total)}\n\n`
      : `✅ *Order sent to the customer*\n\n${customerOrderCard(battery, charger, total)}\n\n`) +
      `Now confirm the delivery: tap below and we'll *call* their registered ` +
      `number with a 6-digit code. Type the code they read out to complete the dispatch.`,
    [{ id: "dpo_call", title: "📞 Send OTP (call)" }],
  );
}

/**
 * DC_DP_OTP — the delivery code, run by the dealer.
 *
 * The code always goes to `leads.phone || leads.mobile` (see `sendDispatchOtp`);
 * nothing here can redirect it. That is the whole point — the dealer proves the
 * customer accepted the battery by reading back something only the customer's
 * own phone received.
 */
async function onDispatchOtp(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await lost(session);

  const raw = (event.text ?? "").trim();

  if (raw === "dpo_call" || raw === "dpo_resend") {
    // No `prefer`, deliberately: the standing ladder is voice call → SMS, and a
    // call to the registered number is what this button says it does.
    const res = await sendDispatchOtp({ leadId });
    if (!res.ok) {
      await reply(session, `⚠️ ${res.error}`, [
        { id: "dpo_resend", title: "🔁 Try again" },
      ]);
      return;
    }
    await patchLeadSub(session.id, "dp", {
      otpChannel: res.channel === "dev" ? "call" : res.channel,
    });
    await reply(
      session,
      (res.channel === "call"
        ? `📞 Calling *${res.maskedPhone}* now with a 6-digit code.`
        : res.channel === "sms"
          ? `💬 Texted a 6-digit code to *${res.maskedPhone}*.`
          : res.channel === "whatsapp"
            ? `💬 Sent a 6-digit code to *${res.maskedPhone}* on WhatsApp.`
            : `🔐 No OTP provider is configured — the dev code is *${res.devOtp}*.`) +
        `\n\nIt is valid for 10 minutes. Type the 6 digits the customer reads out.`,
      [{ id: "dpo_resend", title: "🔁 Resend code" }],
    );
    return;
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 6) {
    await reply(
      session,
      "Type the *6-digit code* the customer received, or tap below to send it.",
      [{ id: "dpo_call", title: "📞 Send OTP (call)" }],
    );
    return;
  }

  // Claim the state before confirming. `confirmDispatch` moves stock and money,
  // and a WhatsApp button — or an impatient re-send of the same six digits —
  // arrives twice more often than you would like. The state goes back if the
  // confirm refuses, so a wrong code is still retryable.
  if (!(await setSessionIf(session.id, DC_DP_OTP, { current_state: DC_DP_WAIT }))) {
    return;
  }

  try {
    const result = await confirmDispatch({
      leadId,
      otp: digits,
      performedBy: dealer.uploaderId,
      dealerId: dealer.dealerCode,
    });
    // `confirmDispatch` fans the "Dispatched!" announcement out to both chats
    // itself (pushDispatched). This is the acting dealer's own receipt, sent
    // synchronously so that a failed push can never leave them staring at
    // nothing after they typed the code.
    await reply(
      session,
      `✅ *Dispatch confirmed*\n\n` +
        `Battery *${result.batterySerial}* is out for delivery.\n` +
        warrantyLine(result),
    );
  } catch (err) {
    await setSession(session.id, { current_state: DC_DP_OTP });
    const message = refusalMessage(err);
    if (!message) console.error("[dispatch-flow] confirm dispatch failed:", err);
    await reply(
      session,
      `⚠️ ${message ?? "I couldn't confirm that dispatch just now. Please try again in a moment."}`,
      [{ id: "dpo_resend", title: "🔁 Resend code" }],
    );
  }
}

/**
 * A refusal the dealer should read verbatim, or null for anything we do not
 * recognise (which is logged and answered generically instead).
 *
 * `InventoryLifecycleError` is matched structurally rather than imported: it
 * carries the same `status` shape and the same "read this out" contract, and the
 * one thing that must not happen is a 409 about the stock being taken arriving
 * as "something went wrong".
 */
function refusalMessage(err: unknown): string | null {
  if (err instanceof DispatchError) {
    return err.attemptsLeft !== undefined && err.attemptsLeft > 0
      ? `${err.message} ${err.attemptsLeft} attempt(s) left.`
      : err.message;
  }
  if (
    err instanceof Error &&
    (err as { status?: unknown }).status === 409
  ) {
    return err.message;
  }
  return null;
}

/**
 * The card the customer receives.
 *
 * NO price on it (E-275) — cash or finance. The customer confirms WHAT they are
 * receiving (model + serial); the money is the dealer's conversation with them,
 * and a forwardable chat message is not where it belongs. The dealer-facing
 * preview and receipt keep the full breakdown.
 */
function customerOrderCard(
  battery: DealerStockItem,
  charger: DealerStockItem | null,
  _total: number,
): string {
  return (
    `🧾 *Your order*\n\n` +
    `🔋 ${battery.model_name ?? battery.model_type ?? "Battery"}\n` +
    `   Serial ${battery.serial_number}` +
    (charger
      ? `\n⚡ ${charger.model_name ?? charger.model_type ?? "Charger"}\n` +
        `   Serial ${charger.serial_number}`
      : "")
  );
}

/**
 * Push that card into the CUSTOMER's own chat.
 *
 * `pushToLeadCustomer`, not `pushToLead`: the ordinary resolution prefers the
 * dealer, and the dealer is the one who just pressed Send. Sending it back to
 * them would leave the customer with no record of the price they are about to
 * approve over OTP.
 */
async function sendOrderCard(
  leadId: string,
  battery: DealerStockItem,
  charger: DealerStockItem | null,
  total: number,
  closed: boolean,
): Promise<PushResult> {
  const card = customerOrderCard(battery, charger, total);
  return await pushToLeadCustomer(leadId, (t) => ({
    prompt: {
      kind: "text",
      body:
        `${card}\n\n` +
        (closed
          ? `Thank you for choosing iTarang, ${t.greetName}. Your dealer has confirmed this sale.`
          : `${t.greetName}, please confirm this order with your dealer. We'll call ` +
            `you with a 6-digit code to complete the delivery.`),
    },
    nudge: {
      template: "lead_action",
      params: [
        oneLine(t.greetName),
        oneLine(t.referenceId),
        closed ? "your order is confirmed" : "your order is ready to confirm",
      ],
    },
  }));
}

// ---------------------------------------------------------------------------
// Shared pricing / lookup helpers for the dealer leg
// ---------------------------------------------------------------------------

/**
 * The warranty line on a receipt. `finalizeSale` resolves a positive duration
 * (inventory → product → OEM → 24 months), so the end date is always in the
 * future and the old "is now registered against it" fallback is gone.
 */
function warrantyLine(w: {
  warrantyId: string;
  warrantyEnd: Date;
  warrantyMonths: number;
}): string {
  return (
    `Warranty *${w.warrantyId}* · ${w.warrantyMonths} months · ` +
    `valid until ${w.warrantyEnd.toLocaleDateString("en-IN")}.`
  );
}

/** The inventory value of the cart — items only, no margin. */
function stockValue(
  battery: DealerStockItem,
  charger: DealerStockItem | null,
): number {
  return lineTotal(battery) + (charger ? lineTotal(charger) : 0);
}

/** The itemised lines, with prices. Dealer-facing only. */
function pricedLines(
  battery: DealerStockItem,
  charger: DealerStockItem | null,
): string {
  return (
    `🔋 ${battery.model_name ?? battery.serial_number} — ${inr(lineTotal(battery))}\n` +
    (charger
      ? `⚡ ${charger.model_name ?? charger.serial_number} — ${inr(lineTotal(charger))}\n`
      : "")
  );
}

/**
 * Re-resolve the chosen cart from the session's serials against LIVE stock.
 *
 * Returns null when it could not, having already put the conversation somewhere
 * sensible — the caller just returns.
 *
 * A vanished BATTERY restarts the picker: it is the order. A vanished CHARGER
 * only drops its line and says so, because sending a dealer back to the top of
 * the battery list over an accessory would be a worse trade than the one-line
 * change to a price they re-approve on the preview anyway.
 */
async function resolvePicked(
  session: SessionRow,
  leadId: string,
  dealer: ActiveDealer,
): Promise<{ battery: DealerStockItem; charger: DealerStockItem | null } | null> {
  const dp = dpCtx(session);
  if (!dp.batterySerial) {
    await askBattery(session, leadId, dealer, 0);
    return null;
  }

  const category = await leadCategory(leadId);
  const batteries = await listDealerBatteries({
    dealerId: dealer.dealerCode,
    category,
  });
  const battery = batteries.find((b) => b.serial_number === dp.batterySerial);
  if (!battery) {
    await reply(
      session,
      "That battery has just been taken. Here's what's still available:",
    );
    await askBattery(session, leadId, dealer, 0);
    return null;
  }

  let charger: DealerStockItem | null = null;
  if (dp.chargerSerial) {
    const chargers = await listDealerChargers({
      dealerId: dealer.dealerCode,
      category,
    });
    charger = chargers.find((c) => c.serial_number === dp.chargerSerial) ?? null;
    if (!charger) {
      await patchLeadSub(session.id, "dp", { chargerSerial: null });
      await reply(
        session,
        "⚠️ That charger has just been taken, so it's been removed from this order.",
      );
    }
  }

  return { battery, charger };
}

interface LeadFacts {
  product_category_id: string | null;
  product_type_id: string | null;
  payment_method: string | null;
  full_name: string | null;
  owner_name: string | null;
}

async function leadFacts(leadId: string): Promise<LeadFacts | null> {
  const [lead] = await db
    .select({
      product_category_id: leads.product_category_id,
      product_type_id: leads.product_type_id,
      payment_method: leads.payment_method,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return lead ?? null;
}

/** First name, for the preview's "this is what X will see". */
function firstName(facts: LeadFacts | null): string {
  const full = (facts?.full_name || facts?.owner_name || "").trim();
  return full ? (full.split(/\s+/)[0] ?? "the customer") : "the customer";
}

/**
 * `toPaymentMode` rather than a `=== "cash"` literal (E-101): 'other_finance'
 * must collapse to finance. A malformed value falls to finance too — that branch
 * only saves a selection, where the cash branch would close a sale, and a
 * malformed payment_method is not something anyone can fix from a chat.
 */
/**
 * May this lead open the battery picker?
 *
 * Finance: only once sanctioned — the picker leads to an OTP that disburses a
 * loan. Cash: there is no sanction to wait for; a cash lead never leaves
 * `pending` until it is `sold`, so gating it on `loan_sanctioned` meant a cash
 * order parked for stock could never be woken by `pushStockReady`, and the
 * `dp_start` button that push sends would have been refused on arrival.
 */
function readyToPick(
  lead: { kyc_status: string | null; payment_method: string | null } | undefined,
): boolean {
  if (!lead) return false;
  if (lead.kyc_status === "loan_sanctioned") return true;
  return isCashLead(lead.payment_method) && lead.kyc_status !== "sold";
}

function isCashLead(paymentMethod: string | null | undefined): boolean {
  try {
    return toPaymentMode(paymentMethod) === "cash";
  } catch {
    return false;
  }
}

/**
 * DC_DP_WAIT — parked: no stock to pick from yet, the cart is chosen and waiting
 * on the dealer, or the order is already out.
 *
 * THE STOCK RE-CHECK IS NOT AN OPTIMISATION. `askBattery` parks here when the
 * dealer has nothing available, and *nothing else in the codebase ever moves a
 * chat back out*: the four paths that allocate stock to a dealer (admin
 * add-item, admin bulk-upload, dealer acknowledge-transfer, legacy
 * inventory/bulk-upload) know nothing about parked conversations. Without this,
 * a customer who reached the picker one minute too early is stuck on
 * "your dealer is arranging stock" forever, and every later message they send
 * gets HANDOFF — even with ten batteries sitting in that dealer's inventory.
 * So the state heals itself on the next inbound message.
 *
 * WHY IT KEYS ON `dp.batterySerial`. This state is reached from three places
 * and only ONE of them may reopen the picker:
 *
 *   1. no stock            → no dp context at all (askBattery returns early)
 *   2. cash sale confirmed → dp.batterySerial set, lead is 'sold'
 *   3. finance handed off  → dp.batterySerial set, selection saved
 *
 * Reopening the picker in case 2 or 3 would invite a customer to re-pick a
 * battery they have already bought. The absence of `batterySerial` is what
 * distinguishes "never got to choose" from "already chose", so the kyc_status
 * check below is kept as well rather than relied on alone — a finance lead in
 * case 3 is still 'loan_sanctioned' and would otherwise pass.
 */
async function onDispatchWait(
  session: SessionRow,
  _event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const leadId = leadIdOf(session);
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

  if (!dpCtx(session).batterySerial) {
    const category = await leadCategory(leadId);
    const batteries = await listDealerBatteries({
      dealerId: dealer.dealerCode,
      category,
    });
    if (batteries.length > 0) {
      await reply(session, "✅ Good news — your dealer has stock available now.");
      await askBattery(session, leadId, dealer, 0);
      return;
    }
  }

  await reply(session, HANDOFF);
}

/**
 * Announce the completed dispatch. Called from `confirmDispatch`'s post-commit
 * block, alongside the SMS it already sends — so it fires whether the dispatch
 * was confirmed in chat or on the Step-5 screen.
 */
export async function pushDispatched(
  leadId: string,
  batterySerial?: string | null,
): Promise<void> {
  // BOTH sides. The dealer-first resolution is right for a prompt that asks
  // somebody to act, and wrong for this: a completed dispatch is news to the
  // customer whose battery it is, and on a dealer-run lead that is the only
  // message they get about it. pushToLeadBoth deduplicates when the two
  // resolve onto one chat.
  await pushToLeadBoth(leadId, (t) => {
    const dealerSide = t.audience === "dealer";
    return {
      prompt: {
        kind: "text",
        body:
          (dealerSide
            ? `📦 *Dispatched!*\n\n${t.greetName}, ${t.customerName}'s iTarang battery`
            : `📦 *Dispatched!*\n\n${t.greetName}, your iTarang battery`) +
          (batterySerial ? ` (serial *${batterySerial}*)` : "") +
          (dealerSide
            ? ` is on its way and the warranty is now active.\n\n`
            : ` is on its way and your warranty is now active.\n\n`) +
          `Thank you for choosing iTarang.`,
      },
      nudge: {
        template: "dispatch_done",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          oneLine(batterySerial ?? "—"),
        ],
      },
    };
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function leadIdOf(session: SessionRow): string | undefined {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  return ctx.lead?.leadId;
}

interface DpCtx {
  batterySerial?: string | null;
  chargerSerial?: string | null;
  page?: number;
  /** Written as null by beginPricing to clear a previous run — patchLeadSub
   *  cannot delete a key, so every reader here tolerates null. */
  marginMode?: "percent" | "rupees" | null;
  marginValue?: number | null;
  marginAmount?: number | null;
  /** 18% GST on marginAmount (E-273). */
  marginGst?: number | null;
  orderSentAt?: string | null;
}

function dpCtx(session: SessionRow): DpCtx {
  const ctx = (session.context ?? {}) as { lead?: { dp?: DpCtx } };
  return ctx.lead?.dp ?? {};
}

async function lost(session: SessionRow): Promise<void> {
  await reply(
    session,
    "I've lost track of this order. Please send *hi* to start again.",
  );
}

/**
 * The category to filter stock by. Prefers what Step 4/5 already committed on
 * `product_selections`, falling back to the lead's own category — the picker
 * must offer the same stock the Step-5 screen would.
 */
async function leadCategory(leadId: string): Promise<string | null> {
  const [selection] = await db
    .select({ category: productSelections.category })
    .from(productSelections)
    .where(eq(productSelections.lead_id, leadId))
    .orderBy(desc(productSelections.created_at))
    .limit(1);
  if (selection?.category) return selection.category;

  const [lead] = await db
    .select({ product_category_id: leads.product_category_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return lead?.product_category_id ?? null;
}

registerLeadAction("dp_start", startDispatch);
// Tap-driven pickers; unrecognised text already re-renders the list.
registerLeadState(DC_DP_PRODUCT, onBatteryPick, { rerenderOnGreeting: true });
registerLeadState(DC_DP_CHARGER, onChargerPick, { rerenderOnGreeting: true });
registerLeadState(DC_DP_MARGIN, onMarginMode, { rerenderOnGreeting: true });
// DC_DP_MARGIN_VAL and DC_DP_OTP take FREE TEXT, which normally disqualifies a
// state from rerenderOnGreeting (see LeadStateOptions) — a greeting submitted as
// data is the hazard. Not here: the payload is a number and a six-digit code
// respectively, and "hi" is neither. Both handlers reject it and re-prompt. The
// alternative is worse — a "hi" mid-dispatch clears ctx.lead, and the dealer has
// no button left to reopen a lead that is already sanctioned and saved.
registerLeadState(DC_DP_MARGIN_VAL, onMarginValue, { rerenderOnGreeting: true });
registerLeadState(DC_DP_SEND, onSendPreview, { rerenderOnGreeting: true });
registerLeadState(DC_DP_OTP, onDispatchOtp, { rerenderOnGreeting: true });
registerLeadState(DC_DP_WAIT, onDispatchWait, { rerenderOnGreeting: true });
