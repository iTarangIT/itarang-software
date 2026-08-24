/**
 * E-264 Phase 4 — Step 5, choosing the battery and dispatching, over WhatsApp.
 *
 * WHAT CHANGED, AND WHY THE OLD BOUNDARY MOVED.
 *
 * This module first shipped doing only half of Step 5: the customer received a
 * code and read it back, and the dealer then pressed Confirm Dispatch on the
 * Step-5 screen. The reasoning was that reserving a serial, disbursing the loan
 * and creating a warranty is one transaction that moves stock and money, and the
 * person who owns the stock is the dealer.
 *
 * The product decision has since been made explicitly: the customer completes
 * Step 5 themselves, cart included. So the whole step now runs in chat, and the
 * two objections are answered rather than avoided:
 *
 *  - The serial is never TYPED. It is picked from a list built out of the
 *    dealer's live stock, so there is nothing to mistype.
 *  - The commit is not duplicated. `confirmDispatch()` is the same function the
 *    Step-5 screen calls — one transaction, one implementation.
 *  - The oversell race is now reachable from chat, and is HANDLED: reservation
 *    happens inside the confirm, so a serial can be taken between the pick and
 *    the code. That returns the customer to the picker with a plain explanation
 *    instead of a dead end. See `onDispatchOtp`.
 *
 * WHAT IS DELIBERATELY NOT IN CHAT. Paraphernalia lines and dealer margin. A
 * multi-line quantity cart with per-line GST is not a chat interaction, and
 * guessing on the customer's behalf would put numbers on an invoice nobody
 * chose. The battery and charger carry their own GST snapshot from the inventory
 * row, so the price the customer approves is exact; the margin defaults to zero
 * and the dealer can still adjust everything on the Step-5 screen before the
 * code is sent. Anything the dealer changes there expires the outstanding code,
 * so the customer always approves the final number.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads, loanSanctions, productSelections } from "@/lib/db/schema";
import { sendDispatchOtp, verifyDispatchOtp } from "@/lib/leads/dispatch-otp";
import { DispatchError, confirmDispatch } from "@/lib/leads/confirm-dispatch";
import { saveStep5ProductSelection } from "@/lib/leads/step5-product";
import { InventoryLifecycleError } from "@/lib/inventory/lifecycle";
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
import type { InboundEvent, ReplyButton } from "./types";
import { oneLine } from "./window";

export const DC_DP_PRODUCT = "DC_DP_PRODUCT";
export const DC_DP_CHARGER = "DC_DP_CHARGER";
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

const RESEND_BUTTON: ReplyButton[] = [{ id: "dp_resend", title: "🔁 Resend code" }];

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

/** DC_DP_PRODUCT — one row per available battery in the dealer's stock. */
async function askBattery(
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
    return await saveAndSendCode(session, leadId, dealer, battery, null);
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
    return await saveAndSendCode(session, leadId, dealer, battery, null);
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

  await saveAndSendCode(session, leadId, dealer, battery, charger);
}

/**
 * Persist the cart, then send the confirmation code.
 *
 * The save deliberately writes only what the customer actually chose:
 * paraphernalia stays empty and the dealer margin zero (see the file header).
 * The GST figures come straight off the inventory rows, so the total the
 * customer is about to approve is the real one.
 */
async function saveAndSendCode(
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
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  try {
    const saved = await saveStep5ProductSelection({
      leadId,
      submittedBy: dealer.uploaderId,
      lead: {
        product_category_id: lead?.product_category_id ?? null,
        product_type_id: lead?.product_type_id ?? null,
      },
      body: {
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
      },
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
      `Sending you a confirmation code now.`,
  );

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

/**
 * DC_DP_OTP — the customer reads the code back, and that confirms the dispatch.
 *
 * The code is verified first and then spent inside `confirmDispatch`, which is
 * the same transaction the Step-5 screen runs. Verifying separately first is not
 * redundant: it lets a wrong code report attempts-left without touching stock.
 */
async function onDispatchOtp(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await lost(session);

  const raw = (event.text ?? "").trim();
  if (raw.toLowerCase() === "dp_resend" || raw.toLowerCase() === "resend") {
    return await sendCode(session, leadId);
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 6) {
    await reply(session, "Please type the *6-digit* code you received.", RESEND_BUTTON);
    return;
  }

  const check = await verifyDispatchOtp({ leadId, otp: digits });
  if (!check.ok) {
    await reply(
      session,
      `⚠️ ${check.error}` +
        (check.attemptsLeft !== undefined && check.attemptsLeft > 0
          ? ` ${check.attemptsLeft} attempt${check.attemptsLeft === 1 ? "" : "s"} left.`
          : ""),
      RESEND_BUTTON,
    );
    return;
  }

  const [lead] = await db
    .select({ dealer_id: leads.dealer_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  try {
    const result = await confirmDispatch({
      leadId,
      otp: digits,
      // The customer authorises; the stock and the loan still belong to the
      // dealer, and every row this writes is attributed to their user.
      performedBy: dealer.uploaderId,
      dealerId: lead?.dealer_id ?? dealer.dealerCode,
    });

    await setSession(session.id, { current_state: DC_DP_WAIT });
    await reply(
      session,
      `✅ *Confirmed — your battery is on its way!*\n\n` +
        `Serial *${result.batterySerial}*\n` +
        // Only promise a warranty PERIOD when there is one. `finalizeSale`
        // derives the end date from `products.warranty_months`, whose `?? 24`
        // fallback catches null but NOT zero — so a product with 0 months
        // produces a window that ends the instant it starts. Printing that
        // tells the customer their warranty expires today, which is a worse
        // message than not naming a date at all. The warranty row is still
        // real and still referenced; only the date is withheld.
        (result.warrantyEnd.getTime() > Date.now()
          ? `Warranty *${result.warrantyId}* is now active until ` +
            `${result.warrantyEnd.toLocaleDateString("en-IN")}.\n\n`
          : `Warranty *${result.warrantyId}* is now registered against it.\n\n`) +
        `Thank you for choosing iTarang.`,
    );
    return;
  } catch (err) {
    // The serial was taken between the pick and the code. This is the single
    // most likely real-world failure of the in-chat cart, and it must return the
    // customer to a working picker rather than a dead end.
    if (err instanceof InventoryLifecycleError) {
      await reply(
        session,
        "⚠️ That battery was just sold to someone else. Let's pick another one — " +
          "your loan and your code stay valid.",
      );
      await askBattery(session, leadId, dealer, 0);
      return;
    }
    if (err instanceof DispatchError) {
      await reply(session, `⚠️ ${err.message}`, RESEND_BUTTON);
      return;
    }
    console.error("[dispatch-flow] confirm failed:", err);
    await reply(
      session,
      "⚠️ Something went wrong completing your order. Your dealer has been notified " +
        "and will finish it — nothing has been charged.",
    );
  }
}

/** DC_DP_WAIT — parked, either pre-stock or post-dispatch. */
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
  await reply(
    session,
    "Nothing more is needed from you right now — we'll message you here as soon as there's an update.",
  );
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
registerLeadState(DC_DP_OTP, onDispatchOtp);
registerLeadState(DC_DP_WAIT, onDispatchWait);
