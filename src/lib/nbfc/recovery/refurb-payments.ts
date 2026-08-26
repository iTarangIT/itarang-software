/**
 * E-271 — the money legs of a refurbishment lot: ADVANCE (before the batteries
 * move) and BALANCE (after the NBFC signs for them back). Money flows
 * NBFC → iTarang, so this is Razorpay CHECKOUT (collect) with an offline
 * bank-transfer fallback — modelled on src/lib/nbfc/auction/purchases.ts
 * (createPaymentIntent / confirmPayment / recordOfflinePayment).
 *
 * Two-step by design: RECORDED (the NBFC says it paid — a UTR, or a verified
 * Razorpay signature) then CONFIRMED (iTarang saw the money). A Razorpay
 * success is both at once because the signature IS the proof; an offline
 * record waits for an admin. Only CONFIRMED moves the lot status.
 */
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { refurbishmentLots } from "@/lib/db/schema";
import { checkoutConfigured, createPlainOrder, razorpayErrorMessage, verifyPaymentSignature } from "@/lib/razorpay";
import {
  advanceToShipping,
  appendEvent,
  asUuid,
  audit,
  getLot,
  loadLot,
  type LotDetail,
  type LotRow,
} from "@/lib/nbfc/recovery/refurbishment-lots";
import { num } from "@/lib/nbfc/recovery/refurbishment";

export type MoneyLegName = "advance" | "balance";

export interface PaymentIntent {
  lot_id: string;
  leg: MoneyLegName;
  amount: number; // rupees
  order_id: string | null;
  key_id: string | null;
  gateway_unavailable: boolean;
}

function legState(lot: LotRow, leg: MoneyLegName) {
  const r = lot as unknown as Record<string, unknown>;
  return {
    amount: num(r[`${leg}_amount`]) ?? 0,
    status: String(r[`${leg}_status`] ?? ""),
    order_id: (r[`${leg}_order_id`] as string | null) ?? null,
    payment_id: (r[`${leg}_payment_id`] as string | null) ?? null,
  };
}

function assertPayable(lot: LotRow, leg: MoneyLegName) {
  const expected = leg === "advance" ? "awaiting_advance" : "balance_due";
  if (lot.status !== expected) {
    throw new Error(`CONFLICT: the ${leg} is not due — the lot is ${lot.status.replace(/_/g, " ")}`);
  }
  const s = legState(lot, leg);
  if (s.status === "confirmed") throw new Error(`CONFLICT: the ${leg} is already confirmed`);
  if (s.amount <= 0) throw new Error(`CONFLICT: there is no ${leg} amount on this lot`);
  return s;
}

/** Step 1 of Razorpay: mint (or reuse) an order the NBFC's browser can open. */
export async function createRefurbPaymentIntent(input: { lot_id: string; tenant_id: string; leg: MoneyLegName }): Promise<PaymentIntent> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  const s = assertPayable(lot, input.leg);
  if (!checkoutConfigured()) {
    return { lot_id: lot.id, leg: input.leg, amount: s.amount, order_id: null, key_id: null, gateway_unavailable: true };
  }
  // Idempotent: a second click reuses the stored order rather than minting another.
  if (s.order_id) {
    return { lot_id: lot.id, leg: input.leg, amount: s.amount, order_id: s.order_id, key_id: process.env.RAZORPAY_KEY_ID ?? null, gateway_unavailable: false };
  }
  let order;
  try {
    order = await createPlainOrder({
      amountRupees: s.amount,
      receipt: `rfb-${input.leg}-${lot.id.slice(0, 18)}`,
      notes: { itarang_purpose: `refurb_${input.leg}`, lot_id: lot.id, tenant_id: lot.tenant_id, ref_code: lot.ref_code },
    });
  } catch (e) {
    throw new Error(`CONFLICT: payment gateway refused the order — ${razorpayErrorMessage(e)}`);
  }
  await db
    .update(refurbishmentLots)
    .set({ [`${input.leg}_order_id`]: order.order_id, [`${input.leg}_provider`]: "razorpay", updated_at: new Date() } as Partial<LotRow>)
    .where(eq(refurbishmentLots.id, lot.id));
  return { lot_id: lot.id, leg: input.leg, amount: s.amount, order_id: order.order_id, key_id: order.key_id, gateway_unavailable: false };
}

/** Records + confirms in one transaction, then moves the lot. */
async function settleLeg(
  lot: LotRow,
  leg: MoneyLegName,
  actor: string | null,
  by: "nbfc" | "admin" | "system",
  patch: Partial<LotRow>,
  eventPayload: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({
        ...patch,
        [`${leg}_status`]: "confirmed",
        [`${leg}_confirmed_at`]: now,
        [`${leg}_confirmed_by`]: asUuid(actor),
        ...(leg === "balance" ? { status: "settled", settled_at: now, last_party: by === "nbfc" ? "nbfc" : "admin" } : {}),
        updated_at: now,
      } as Partial<LotRow>)
      .where(eq(refurbishmentLots.id, lot.id));
    if (leg === "advance") {
      await appendEvent(tx, lot, { party: by, kind: "advance_confirmed", actor, payload: eventPayload });
      await advanceToShipping(tx, lot, actor, now);
    } else {
      await appendEvent(tx, lot, { party: by, kind: "settled", actor, payload: eventPayload });
    }
    await audit(tx, lot, actor, leg === "advance" ? "refurb_adv_confirmed" : "refurb_lot_settled", { [`${leg}_status`]: legState(lot, leg).status }, { [`${leg}_status`]: "confirmed", ...eventPayload });
  });
}

/** Step 2 of Razorpay: the browser hands back order/payment/signature; verify server-side. */
export async function confirmRefurbRazorpayPayment(input: {
  lot_id: string;
  tenant_id: string;
  actor_user_id: string | null;
  leg: MoneyLegName;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  const s = legState(lot, input.leg);
  // Replay-idempotent: a second callback for the same payment is a no-op.
  if (s.status === "confirmed" && s.payment_id === input.razorpay_payment_id) return (await getLot(lot.id, input.tenant_id))!;
  assertPayable(lot, input.leg);
  if (!s.order_id || s.order_id !== input.razorpay_order_id) {
    throw new Error("CONFLICT: the payment does not belong to this lot's order");
  }
  if (!verifyPaymentSignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature)) {
    throw new Error("FORBIDDEN: payment signature did not verify");
  }
  await settleLeg(
    lot,
    input.leg,
    input.actor_user_id,
    "nbfc",
    { [`${input.leg}_provider`]: "razorpay", [`${input.leg}_payment_id`]: input.razorpay_payment_id, [`${input.leg}_reference`]: input.razorpay_payment_id, [`${input.leg}_recorded_at`]: new Date() } as Partial<LotRow>,
    { provider: "razorpay", payment_id: input.razorpay_payment_id, amount: s.amount },
  );
  return (await getLot(lot.id, input.tenant_id))!;
}

/** Webhook path: Razorpay says `payment.captured` for one of our orders. Idempotent. */
export async function confirmRefurbPaymentFromWebhook(input: { lot_id: string; leg: MoneyLegName; order_id: string; payment_id: string; amount_paise: number }): Promise<"ok" | "already" | "ignored"> {
  let lot: LotRow;
  try {
    lot = await loadLot(input.lot_id, null);
  } catch {
    return "ignored";
  }
  const s = legState(lot, input.leg);
  if (s.status === "confirmed") return "already";
  if (s.order_id !== input.order_id) return "ignored";
  if (Math.round(s.amount * 100) !== input.amount_paise) return "ignored";
  const expected = input.leg === "advance" ? "awaiting_advance" : "balance_due";
  if (lot.status !== expected) return "ignored";
  await settleLeg(
    lot,
    input.leg,
    null,
    "system",
    { [`${input.leg}_provider`]: "razorpay", [`${input.leg}_payment_id`]: input.payment_id, [`${input.leg}_reference`]: input.payment_id, [`${input.leg}_recorded_at`]: new Date() } as Partial<LotRow>,
    { provider: "razorpay", payment_id: input.payment_id, amount: s.amount, via: "webhook" },
  );
  return "ok";
}

/** Offline: the NBFC transferred by bank and enters the UTR. Waits for admin confirmation. */
export async function recordRefurbOfflinePayment(input: { lot_id: string; tenant_id: string; actor_user_id: string | null; leg: MoneyLegName; reference: string; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, input.tenant_id);
  const s = assertPayable(lot, input.leg);
  const reference = input.reference.trim();
  if (reference.length < 3) throw new Error("BAD_REQUEST: give the bank reference — a UTR, cheque number or receipt id");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({ [`${input.leg}_status`]: "recorded", [`${input.leg}_provider`]: "offline", [`${input.leg}_reference`]: reference, [`${input.leg}_recorded_at`]: now, last_party: "nbfc", updated_at: now } as Partial<LotRow>)
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, { party: "nbfc", kind: input.leg === "advance" ? "advance_recorded" : "balance_recorded", message: input.note ?? null, actor: input.actor_user_id, payload: { provider: "offline", reference, amount: s.amount } });
    await audit(tx, lot, input.actor_user_id, input.leg === "advance" ? "refurb_adv_recorded" : "refurb_bal_recorded", { [`${input.leg}_status`]: s.status }, { [`${input.leg}_status`]: "recorded", reference });
  });
  return (await getLot(lot.id, input.tenant_id))!;
}

/** Admin: the bank transfer landed. */
export async function confirmRefurbOfflinePayment(input: { lot_id: string; actor_user_id: string | null; leg: MoneyLegName; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const s = assertPayable(lot, input.leg);
  if (s.status !== "recorded") throw new Error(`CONFLICT: nothing to confirm — the NBFC has not recorded a ${input.leg} payment yet`);
  await settleLeg(lot, input.leg, input.actor_user_id, "admin", {} as Partial<LotRow>, { provider: "offline", reference: (lot as unknown as Record<string, unknown>)[`${input.leg}_reference`], amount: s.amount, note: input.note ?? null });
  return (await getLot(lot.id, null))!;
}
