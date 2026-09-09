/**
 * E-292 — the money legs of a refurbishment lot: ADVANCE (before the batteries
 * move) and BALANCE (after the NBFC signs for them back). OFFLINE ONLY since
 * v3: the NBFC pays straight into iTarang's bank (NEFT / RTGS / UPI) and the
 * platform RECORDS it — it does not collect. The v2 Razorpay Checkout path is
 * gone; the order/payment columns stay on the table unused.
 *
 * Two-step by design: RECORDED (the NBFC says it paid and gives the UTR) then
 * CONFIRMED (iTarang saw the money — admin marks "amount received"). Only
 * CONFIRMED moves the lot status. Trust-based for now: an admin may confirm a
 * leg the NBFC never recorded, typing the reference itself.
 */
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { refurbishmentLots } from "@/lib/db/schema";
import {
  appendEvent,
  asUuid,
  audit,
  confirmAdvance,
  getLot,
  loadLot,
  type LotDetail,
  type LotRow,
} from "@/lib/nbfc/recovery/refurbishment-lots";
import { num } from "@/lib/nbfc/recovery/refurbishment";

export type MoneyLegName = "advance" | "balance";

function legState(lot: LotRow, leg: MoneyLegName) {
  const r = lot as unknown as Record<string, unknown>;
  return {
    amount: num(r[`${leg}_amount`]) ?? 0,
    status: String(r[`${leg}_status`] ?? ""),
    reference: (r[`${leg}_reference`] as string | null) ?? null,
  };
}

/**
 * E-293: the balance is payable from the moment the final bill goes out
 * (lot `costed` with final_sent_at, then `ready`) right through to
 * `balance_due` — it must be recorded BEFORE the return truck, but a lot that
 * slipped through (legacy, or a bill re-sent in transit) can still be paid late.
 */
const BALANCE_PAYABLE_STATUSES = new Set(["costed", "ready", "in_transit_return", "delivered_back", "balance_due"]);

function assertPayable(lot: LotRow, leg: MoneyLegName) {
  if (leg === "advance") {
    if (lot.status !== "pi_accepted") throw new Error(`CONFLICT: the advance is not due — the lot is ${lot.status.replace(/_/g, " ")}`);
  } else if (!BALANCE_PAYABLE_STATUSES.has(lot.status) || !lot.final_sent_at) {
    throw new Error(`CONFLICT: the balance is not due — ${lot.final_sent_at ? `the lot is ${lot.status.replace(/_/g, " ")}` : "iTarang has not sent the final bill yet"}`);
  }
  const s = legState(lot, leg);
  if (leg === "balance" && s.status === "not_due") throw new Error("CONFLICT: nothing is owed on this lot");
  if (s.status === "confirmed") throw new Error(`CONFLICT: the ${leg} is already confirmed`);
  if (leg === "advance" && s.status === "not_required") throw new Error("CONFLICT: this PI carries no advance");
  if (s.amount <= 0) throw new Error(`CONFLICT: there is no ${leg} amount on this lot`);
  return s;
}

/**
 * Confirms in one transaction, then moves the lot. E-293: the balance is
 * normally confirmed while the batteries are still with the refurbisher — that
 * only unlocks the return truck; the lot SETTLES when the NBFC signs for them
 * (confirmReceipt). Only a lot already `balance_due` settles here.
 */
async function settleLeg(lot: LotRow, leg: MoneyLegName, actor: string | null, patch: Partial<LotRow>, eventPayload: Record<string, unknown>): Promise<void> {
  const now = new Date();
  const settlesNow = leg === "balance" && lot.status === "balance_due";
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({
        ...patch,
        [`${leg}_status`]: "confirmed",
        [`${leg}_provider`]: "offline",
        [`${leg}_confirmed_at`]: now,
        [`${leg}_confirmed_by`]: asUuid(actor),
        ...(settlesNow ? { status: "settled", settled_at: now } : {}),
        last_party: "admin",
        updated_at: now,
      } as Partial<LotRow>)
      .where(eq(refurbishmentLots.id, lot.id));
    if (leg === "advance") {
      await appendEvent(tx, lot, { party: "admin", kind: "advance_confirmed", actor, payload: eventPayload });
      await confirmAdvance(tx, lot, actor, now);
    } else {
      await appendEvent(tx, lot, { party: "admin", kind: settlesNow ? "settled" : "balance_confirmed", actor, payload: eventPayload });
    }
    await audit(
      tx,
      lot,
      actor,
      leg === "advance" ? "refurb_adv_confirmed" : settlesNow ? "refurb_lot_settled" : "refurb_bal_confirmed",
      { [`${leg}_status`]: legState(lot, leg).status },
      { [`${leg}_status`]: "confirmed", ...eventPayload },
    );
  });
}

/** NBFC: transferred by bank and enters the UTR. Waits for admin confirmation. */
export async function recordRefurbOfflinePayment(input: { lot_id: string; tenant_id: string; actor_user_id: string | null; leg: MoneyLegName; reference: string; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, { tenant_id: input.tenant_id });
  const s = assertPayable(lot, input.leg);
  const reference = input.reference.trim();
  if (reference.length < 3) throw new Error("BAD_REQUEST: give the bank reference — a UTR, cheque number or receipt id");
  // E-293: the balance needs the payment slip on file (uploaded first through
  // the lot photo route, target `balance_slip`) — it is what unlocks the return truck.
  const proofUrls = ((lot as unknown as Record<string, unknown>)[`${input.leg}_proof_urls`] as string[] | null) ?? [];
  if (input.leg === "balance" && proofUrls.length === 0) {
    throw new Error("BAD_REQUEST: upload the payment slip (screenshot or PDF of the bank transfer) before recording the balance");
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(refurbishmentLots)
      .set({ [`${input.leg}_status`]: "recorded", [`${input.leg}_provider`]: "offline", [`${input.leg}_reference`]: reference, [`${input.leg}_recorded_at`]: now, last_party: "nbfc", updated_at: now } as Partial<LotRow>)
      .where(eq(refurbishmentLots.id, lot.id));
    await appendEvent(tx, lot, { party: "nbfc", kind: input.leg === "advance" ? "advance_recorded" : "balance_recorded", message: input.note ?? null, actor: input.actor_user_id, payload: { provider: "offline", reference, amount: s.amount, proof_count: proofUrls.length } });
    await audit(tx, lot, input.actor_user_id, input.leg === "advance" ? "refurb_adv_recorded" : "refurb_bal_recorded", { [`${input.leg}_status`]: s.status }, { [`${input.leg}_status`]: "recorded", reference });
  });
  return (await getLot(lot.id, { tenant_id: input.tenant_id }, "nbfc"))!;
}

/**
 * Admin: "amount received". Normally after the NBFC recorded a UTR; may also
 * confirm a leg still `pending` by typing the reference itself (trust-based).
 */
export async function confirmRefurbOfflinePayment(input: { lot_id: string; actor_user_id: string | null; leg: MoneyLegName; reference?: string | null; note?: string | null }): Promise<LotDetail> {
  const lot = await loadLot(input.lot_id, null);
  const s = assertPayable(lot, input.leg);
  const typed = input.reference?.trim() || null;
  if (s.status === "pending" && !typed) {
    throw new Error(`CONFLICT: the NBFC has not recorded the ${input.leg} yet — enter the bank reference to confirm it anyway`);
  }
  const reference = typed ?? s.reference;
  await settleLeg(
    lot,
    input.leg,
    input.actor_user_id,
    { ...(typed ? { [`${input.leg}_reference`]: typed, [`${input.leg}_recorded_at`]: new Date() } : {}) } as Partial<LotRow>,
    { provider: "offline", reference, amount: s.amount, note: input.note ?? null, recorded_by_nbfc: s.status === "recorded" },
  );
  return (await getLot(lot.id, null, "admin"))!;
}
