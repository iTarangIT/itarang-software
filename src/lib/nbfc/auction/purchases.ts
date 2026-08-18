/**
 * The buyer's side of a settlement — BRD §12, §13, §14.
 *
 * WHAT WAS MISSING
 *   `auction_settlements` has only ever been readable by the SELLER.
 *   `listSettlements()` filters on `seller_tenant_id`, and there was no dealer
 *   endpoint at all — so a dealer who won a lot saw the word "won" on their
 *   bids page and nothing more. No amount owed, no way to pay, no pickup
 *   details, no record afterwards.
 *
 *   Worse, `payment_pending → in_transit` was a status flip the seller made by
 *   hand with nothing behind it. A settlement could be marked in transit
 *   without a rupee moving, and the schema had nowhere to record that it had.
 *   E-249 adds the columns; this is the code that fills them.
 *
 * THE OFFLINE ESCAPE HATCH
 *   `recordOfflinePayment()` exists because most of these settlements are, in
 *   practice, bank transfers agreed on a phone call. Making the gateway the
 *   only way to satisfy the gate would mean either blocking those sales or
 *   quietly leaving the gate open. Instead the bypass is explicit, attributed,
 *   reason-carrying and audited — and it stamps the same `paid_at` the gateway
 *   would, so downstream code has one thing to check.
 */
import { db } from "@/lib/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auctionSettlements,
  auctionLots,
  auctionLotItems,
  recoveryBatteries,
  nbfcTenants,
  nbfcAuditLog,
} from "@/lib/db/schema";

export type PaymentProvider = "razorpay" | "offline";

export interface DealerPurchase {
  settlement_id: string;
  lot_id: string;
  lot_code: string;
  title: string | null;
  auction_type: string;
  final_price: number;
  status: string;
  seller_name: string | null;
  paid_at: string | null;
  payment_ref: string | null;
  payment_provider: string | null;
  failure_reason: string | null;
  refinance_loan_id: string | null;
  updated_at: string;
  items: Array<{ serial: string; condition: string }>;
}

/** Everything this dealer has won, newest first. */
export async function listDealerPurchases(
  dealer_id: string,
): Promise<DealerPurchase[]> {
  const rows = await db
    .select({
      settlement_id: auctionSettlements.id,
      lot_id: auctionSettlements.lot_id,
      lot_code: auctionLots.lot_code,
      title: auctionLots.title,
      auction_type: auctionLots.auction_type,
      final_price: auctionSettlements.final_price,
      status: auctionSettlements.status,
      seller_name: nbfcTenants.display_name,
      paid_at: auctionSettlements.paid_at,
      payment_ref: auctionSettlements.payment_ref,
      payment_provider: auctionSettlements.payment_provider,
      failure_reason: auctionSettlements.failure_reason,
      refinance_loan_id: auctionSettlements.refinance_loan_id,
      updated_at: auctionSettlements.updated_at,
    })
    .from(auctionSettlements)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionSettlements.lot_id))
    .leftJoin(
      nbfcTenants,
      eq(nbfcTenants.id, auctionSettlements.seller_tenant_id),
    )
    .where(eq(auctionSettlements.winner_dealer_id, dealer_id))
    .orderBy(desc(auctionSettlements.updated_at))
    .limit(100);

  if (rows.length === 0) return [];

  const itemRows = await db
    .select({
      lot_id: auctionLotItems.lot_id,
      serial: recoveryBatteries.serial,
      condition: auctionLotItems.condition,
    })
    .from(auctionLotItems)
    .leftJoin(
      recoveryBatteries,
      eq(recoveryBatteries.id, auctionLotItems.battery_id),
    )
    .where(
      sql`${auctionLotItems.lot_id} IN (${sql.join(
        rows.map((r) => sql`${r.lot_id}::uuid`),
        sql`, `,
      )})`,
    );

  const byLot = new Map<string, Array<{ serial: string; condition: string }>>();
  for (const i of itemRows) {
    const list = byLot.get(i.lot_id) ?? [];
    list.push({ serial: i.serial ?? "", condition: i.condition });
    byLot.set(i.lot_id, list);
  }

  return rows.map((r) => ({
    settlement_id: r.settlement_id,
    lot_id: r.lot_id,
    lot_code: r.lot_code,
    title: r.title ?? null,
    auction_type: r.auction_type,
    final_price: Number(r.final_price),
    status: r.status,
    seller_name: r.seller_name ?? null,
    paid_at: r.paid_at ? (r.paid_at as Date).toISOString() : null,
    payment_ref: r.payment_ref ?? null,
    payment_provider: r.payment_provider ?? null,
    failure_reason: r.failure_reason ?? null,
    refinance_loan_id: r.refinance_loan_id ?? null,
    updated_at: (r.updated_at as Date).toISOString(),
    items: byLot.get(r.lot_id) ?? [],
  }));
}

/** Loads a settlement and asserts this dealer is the buyer. */
async function loadOwnSettlement(dealer_id: string, settlement_id: string) {
  const [row] = await db
    .select()
    .from(auctionSettlements)
    .where(
      and(
        eq(auctionSettlements.id, settlement_id),
        eq(auctionSettlements.winner_dealer_id, dealer_id),
      ),
    )
    .limit(1);
  // 404 rather than 403: a dealer should not be able to probe for the
  // existence of settlements that are not theirs.
  if (!row) throw new Error("NOT_FOUND: settlement not found");
  return row;
}

export interface PaymentIntent {
  settlement_id: string;
  amount: number;
  /** Razorpay order id, when the gateway is configured. */
  order_id: string | null;
  key_id: string | null;
  /** True when no gateway is configured and payment must be recorded offline. */
  gateway_unavailable: boolean;
}

/**
 * Opens a payment for a settlement the caller won.
 *
 * Idempotent by design: an order id already on the row is returned rather than
 * a second order being created, so a dealer who reloads the page mid-payment
 * does not end up with two live orders against one lot.
 */
export async function createPaymentIntent(input: {
  dealer_id: string;
  settlement_id: string;
}): Promise<PaymentIntent> {
  const row = await loadOwnSettlement(input.dealer_id, input.settlement_id);

  if (row.paid_at) {
    throw new Error("CONFLICT: this purchase has already been paid for");
  }
  if (row.status !== "payment_pending") {
    throw new Error(
      `CONFLICT: settlement is ${row.status} — payment is only taken while it is payment_pending`,
    );
  }

  const amount = Number(row.final_price);
  const keyId = process.env.RAZORPAY_KEY_ID ?? null;

  if (!keyId || !process.env.RAZORPAY_KEY_SECRET) {
    // Said plainly rather than throwing: the settlement is still valid and can
    // be settled by bank transfer and recorded offline by an admin.
    return {
      settlement_id: row.id,
      amount,
      order_id: null,
      key_id: null,
      gateway_unavailable: true,
    };
  }

  if (row.payment_ref) {
    return {
      settlement_id: row.id,
      amount,
      order_id: row.payment_ref,
      key_id: keyId,
      gateway_unavailable: false,
    };
  }

  const { createEmandateOrder } = await import("@/lib/razorpay");
  const order = await createEmandateOrder({
    amount,
    currency: "INR",
    receipt: `auction-${row.id.slice(0, 18)}`,
  } as Parameters<typeof createEmandateOrder>[0]);

  const orderId = (order as { id?: string })?.id ?? null;
  if (!orderId) {
    throw new Error("CONFLICT: the payment gateway did not return an order id");
  }

  await db
    .update(auctionSettlements)
    .set({ payment_ref: orderId, payment_provider: "razorpay" })
    .where(eq(auctionSettlements.id, row.id));

  return {
    settlement_id: row.id,
    amount,
    order_id: orderId,
    key_id: keyId,
    gateway_unavailable: false,
  };
}

/**
 * Confirms a gateway payment.
 *
 * The signature is verified server-side: a captured payment is never taken on
 * the client's word, which is the same rule the e-mandate confirm endpoint
 * already follows.
 */
export async function confirmPayment(input: {
  dealer_id: string;
  settlement_id: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}): Promise<{ settlement_id: string; paid_at: string }> {
  const row = await loadOwnSettlement(input.dealer_id, input.settlement_id);
  if (row.paid_at) {
    // Idempotent: a replayed confirm is not an error.
    return {
      settlement_id: row.id,
      paid_at: (row.paid_at as Date).toISOString(),
    };
  }

  const { verifyPaymentSignature } = await import("@/lib/razorpay");
  const ok = verifyPaymentSignature(
    input.razorpay_order_id,
    input.razorpay_payment_id,
    input.razorpay_signature,
  );
  if (!ok) {
    throw new Error("BAD_REQUEST: payment signature did not verify");
  }
  if (row.payment_ref && row.payment_ref !== input.razorpay_order_id) {
    throw new Error(
      "CONFLICT: that payment belongs to a different order on this settlement",
    );
  }

  const now = new Date();
  await db
    .update(auctionSettlements)
    .set({
      payment_ref: input.razorpay_payment_id,
      payment_provider: "razorpay",
      paid_at: now,
      failure_reason: null,
      updated_at: now,
    })
    .where(eq(auctionSettlements.id, row.id));

  await db.insert(nbfcAuditLog).values({
    tenant_id: row.seller_tenant_id,
    user_id: null,
    action_type: "auction_settlement_paid",
    action_id: row.id,
    before_state: { status: row.status, paid_at: null },
    after_state: {
      provider: "razorpay",
      payment_ref: input.razorpay_payment_id,
      amount: Number(row.final_price),
    },
    created_at: now,
  });

  return { settlement_id: row.id, paid_at: now.toISOString() };
}

/**
 * Records a payment that happened outside the app.
 *
 * Deliberately visible, attributed and reason-carrying. The alternative — a
 * seller flipping the status and nobody knowing whether money moved — is what
 * this whole file exists to end.
 */
export async function recordOfflinePayment(input: {
  actor_tenant_id: string;
  actor_user_id: string;
  settlement_id: string;
  reference: string;
  note?: string | null;
}): Promise<{ settlement_id: string; paid_at: string }> {
  const [row] = await db
    .select()
    .from(auctionSettlements)
    .where(
      and(
        eq(auctionSettlements.id, input.settlement_id),
        eq(auctionSettlements.seller_tenant_id, input.actor_tenant_id),
      ),
    )
    .limit(1);
  if (!row) throw new Error("NOT_FOUND: settlement not found for this NBFC");
  if (row.paid_at) {
    throw new Error("CONFLICT: this settlement is already marked paid");
  }
  if (!input.reference.trim()) {
    throw new Error(
      "BAD_REQUEST: a payment reference is required — a UTR, cheque number or receipt id",
    );
  }

  const now = new Date();
  await db
    .update(auctionSettlements)
    .set({
      payment_ref: input.reference.trim(),
      payment_provider: "offline",
      paid_at: now,
      failure_reason: null,
      updated_at: now,
    })
    .where(eq(auctionSettlements.id, row.id));

  await db.insert(nbfcAuditLog).values({
    tenant_id: input.actor_tenant_id,
    user_id: input.actor_user_id,
    action_type: "auction_settlement_paid_offline",
    action_id: row.id,
    before_state: { status: row.status, paid_at: null },
    after_state: {
      provider: "offline",
      reference: input.reference.trim(),
      note: input.note ?? null,
      amount: Number(row.final_price),
    },
    created_at: now,
  });

  return { settlement_id: row.id, paid_at: now.toISOString() };
}

/**
 * Abandons a settlement that was never paid, and puts the stock back.
 *
 * Without this a winner who vanishes freezes the batteries in `sold` for ever:
 * the lot is closed, the settlement never completes, and nothing can re-list
 * them. Releasing to `ready` is the same state the scheduler returns unsold
 * stock to, so a released lot can go straight back into the composer.
 */
export async function abandonSettlement(input: {
  actor_tenant_id: string;
  actor_user_id: string;
  settlement_id: string;
  reason: string;
}): Promise<{ settlement_id: string; released: number }> {
  const [row] = await db
    .select()
    .from(auctionSettlements)
    .where(
      and(
        eq(auctionSettlements.id, input.settlement_id),
        eq(auctionSettlements.seller_tenant_id, input.actor_tenant_id),
      ),
    )
    .limit(1);
  if (!row) throw new Error("NOT_FOUND: settlement not found for this NBFC");
  if (row.paid_at) {
    throw new Error(
      "CONFLICT: this settlement has been paid — refund it before abandoning",
    );
  }
  if (!input.reason.trim()) {
    throw new Error("BAD_REQUEST: a reason is required");
  }

  const now = new Date();
  let released = 0;

  await db.transaction(async (tx) => {
    await tx
      .update(auctionSettlements)
      .set({
        status: "payment_pending",
        failure_reason: input.reason.trim(),
        updated_at: now,
      })
      .where(eq(auctionSettlements.id, row.id));

    const back = (await tx.execute(sql`
      UPDATE recovery_batteries
         SET state_code = 'ready', updated_at = ${now}
       WHERE state_code IN ('lotted', 'sold')
         AND id IN (SELECT battery_id FROM auction_lot_items
                     WHERE lot_id = ${row.lot_id})
      RETURNING id
    `)) as unknown as Array<unknown>;
    released = back.length;

    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.actor_tenant_id,
      user_id: input.actor_user_id,
      action_type: "auction_settlement_abandoned",
      action_id: row.id,
      before_state: { status: row.status },
      after_state: { reason: input.reason.trim(), released },
      created_at: now,
    });
  });

  return { settlement_id: row.id, released };
}
