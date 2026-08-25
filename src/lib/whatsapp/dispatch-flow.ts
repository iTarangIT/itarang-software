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
 * WHAT IS DELIBERATELY NOT IN CHAT. Paraphernalia lines and dealer margin. A
 * multi-line quantity cart with per-line GST is not a chat interaction, and
 * guessing on the customer's behalf would put numbers on an invoice nobody
 * chose. The battery and charger carry their own GST snapshot from the inventory
 * row, so the total shown is exact; the margin defaults to zero and the dealer
 * can still adjust everything on the Step-5 screen.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads, loanSanctions, productSelections } from "@/lib/db/schema";
import { saveStep5ProductSelection } from "@/lib/leads/step5-product";
import { CashSaleError, confirmCashSale } from "@/lib/leads/confirm-cash-sale";
import { toPaymentMode } from "@/lib/sales/payment-mode";
import {
  listDealerBatteries,
  listDealerChargers,
  type DealerStockItem,
} from "@/lib/inventory/dealer-stock";

import type { ActiveDealer } from "./customer-lead";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead } from "./lead-push";
import { registerLeadState } from "./lead-states";
import type { ParkedPrompt } from "./outbound";
import {
  patchLeadSub,
  reply,
  replyList,
  setSession,
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
      `.\n\nTap below to choose your battery and arrange delivery.`,
    buttons: [{ id: leadActionId("dp_start", leadId), title: "📦 Choose battery" }],
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
    return await completeOrder(session, leadId, dealer, battery, null);
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
    return await completeOrder(session, leadId, dealer, battery, null);
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

  await completeOrder(session, leadId, dealer, battery, charger);
}

/**
 * The end of the picker, for BOTH payment paths.
 *
 * The fork is on the lead's own payment method, not on who is chatting:
 *   - **cash** → the sale closes here. `confirmCashSale()` writes the selection,
 *     moves the battery available → SOLD, creates the warranty and the
 *     after-sales record, and sets the lead to 'sold'. That mirrors the web
 *     exactly: cash completes at Step 4, skips 'dispatched', and has no OTP.
 *   - **finance** → the selection is saved and the chat hands over. Stock is not
 *     touched; the dealer runs OTP + Confirm Dispatch on Step 5.
 *
 * Either way the chat writes only what was actually chosen: paraphernalia stays
 * empty and the dealer margin zero (see the file header). The GST figures come
 * straight off the inventory rows, so the total shown is the real one.
 */
async function completeOrder(
  session: SessionRow,
  leadId: string,
  dealer: ActiveDealer,
  battery: DealerStockItem,
  charger: DealerStockItem | null,
): Promise<void> {
  const batteryNet = lineTotal(battery);
  const chargerNet = charger ? lineTotal(charger) : 0;
  const total = batteryNet + chargerNet;

  const num = (v: string | null | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const [lead] = await db
    .select({
      product_category_id: leads.product_category_id,
      product_type_id: leads.product_type_id,
      payment_method: leads.payment_method,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  // The line snapshot both paths write. Built once so a cash sale and a finance
  // selection can never disagree about the price the customer was shown.
  const lineFields = {
    batterySerial: battery.serial_number,
    chargerSerial: charger?.serial_number ?? null,
    // Not offered in chat — see the file header.
    paraphernalia: {},
    paraphernaliaLines: [],
    paraphernaliaCost: 0,
    dealerMargin: 0,
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
    netSubtotal: total,
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
    `\n*Total ${inr(total)}* _(incl. GST)_`;

  // --- Cash: the sale closes right here. ---------------------------------
  //
  // `toPaymentMode` rather than a `=== "cash"` literal (E-101): 'other_finance'
  // must collapse to finance and take the branch below, not close a sale.
  let isCash = false;
  try {
    isCash = toPaymentMode(lead?.payment_method) === "cash";
  } catch {
    // A malformed payment_method is not something a customer can fix in chat.
    // Fall through to the finance branch, which only saves a selection.
    isCash = false;
  }

  if (isCash) {
    try {
      const sale = await confirmCashSale({
        leadId,
        performedBy: dealer.uploaderId,
        dealerId: dealer.dealerCode,
        body: lineFields,
      });
      await setSession(session.id, { current_state: DC_DP_WAIT });
      await reply(
        session,
        `🧾 *Sale confirmed*\n\n${orderLines}\n\n` +
          `Serial *${sale.batterySerial}*\n` +
          // Same guard as the dispatch message: `finalizeSale` derives the end
          // date from `products.warranty_months`, whose `?? 24` fallback does
          // not catch zero, so a 0-month product would otherwise be announced
          // as expiring today.
          (sale.warrantyEnd.getTime() > Date.now()
            ? `Warranty *${sale.warrantyId}* is active until ` +
              `${sale.warrantyEnd.toLocaleDateString("en-IN")}.`
            : `Warranty *${sale.warrantyId}* is now registered against it.`) +
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

  // --- Finance: save the selection and hand over. -------------------------
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
    await reply(
      session,
      "⚠️ I couldn't save that selection just now. Please try again in a moment.",
    );
    return;
  }

  await reply(
    session,
    `🧾 *Your order*\n\n` +
      `🔋 ${battery.model_name ?? battery.serial_number} — ${inr(batteryNet)}\n` +
      (charger
        ? `⚡ ${charger.model_name ?? charger.serial_number} — ${inr(chargerNet)}\n`
        : "") +
      `\n*Total ${inr(total)}* _(incl. GST)_\n\n` +
      HANDOFF,
  );

  await setSession(session.id, { current_state: DC_DP_WAIT });
}

/**
 * DC_DP_WAIT — parked: no stock to pick from yet, the cart is chosen and waiting
 * on the dealer, or the order is already out.
 */
async function onDispatchWait(session: SessionRow): Promise<void> {
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function leadIdOf(session: SessionRow): string | undefined {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  return ctx.lead?.leadId;
}

function dpCtx(session: SessionRow): {
  batterySerial?: string;
  page?: number;
} {
  const ctx = (session.context ?? {}) as {
    lead?: { dp?: { batterySerial?: string; page?: number } };
  };
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
registerLeadState(DC_DP_PRODUCT, onBatteryPick);
registerLeadState(DC_DP_CHARGER, onChargerPick);
registerLeadState(DC_DP_WAIT, onDispatchWait);
