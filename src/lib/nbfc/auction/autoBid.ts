/**
 * E-234 — the auto-bid proxy engine (Battery Auction BRD §11).
 *
 * `auction_auto_bids` has stored a bidder's standing maximum since E-093, the
 * UI shows it back to them, and NOTHING HAS EVER ACTED ON IT. A bidder who set
 * a ₹2L maximum and closed the tab lost the auction to a ₹1.6L bid. The route's
 * own header says the engine "lives in a follow-up". This is that follow-up.
 *
 * PROXY SEMANTICS (the eBay rule, and the one users already expect)
 *   A standing maximum does not bid its maximum. It bids the smallest amount
 *   that takes the lead — one increment above the next-highest interest — and
 *   only goes as high as it must. So the winner pays what it took to beat the
 *   runner-up, not what they were willing to pay.
 *
 * WHY THIS RUNS INSIDE placeBid()'s TRANSACTION
 *   The lot row is already locked there. Running the proxy afterwards, in its
 *   own transaction, would leave a window in which the manual bid is visible
 *   and leading while the proxy that should have beaten it has not fired — and
 *   the scheduler could close the lot inside that window and award it to the
 *   wrong bidder.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { auctionBids, auctionAutoBids } from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof import("@/lib/db").db.transaction>[0]>[0];

export interface ProxyBidPlaced {
  bid_id: string;
  amount: number;
  bidder_kind: string;
  bidder_dealer_id: string | null;
  tenant_id: string;
}

/**
 * Identity of an auto-bid row. `auction_auto_bids` predates the dealer
 * re-point and keys on `tenant_id`; a dealer's standing order is keyed by
 * `bidder_dealer_id` on the bid it produces, so both travel together exactly as
 * they do on `auction_bids`.
 */
interface StandingOrder {
  id: string;
  tenant_id: string;
  bidder_dealer_id: string | null;
  max_amount: number;
}

/**
 * Runs the proxy engine after a bid has been accepted.
 *
 * Returns the proxy bids placed, in order. The caller re-reads the standing bid
 * afterwards; this function does not mutate the lot.
 *
 * @param leaderKey  Identity of whoever currently leads — their own standing
 *                   order must not bid against them.
 */
export async function runAutoBidEngine(
  tx: Tx,
  input: {
    lot_id: string;
    current_bid: number;
    bid_increment: number;
    leaderKey: string;
    /** Seller tenant, written to auction_bids.tenant_id for dealer bids. */
    seller_tenant_id: string | null;
    now: Date;
  },
): Promise<ProxyBidPlaced[]> {
  // `bidder_dealer_id` is read straight off the standing order (E-234).
  //
  // The first draft resolved it from "the most recent bid by this tenant on
  // this lot", to avoid a fourth migration. That silently never fires: after
  // the E-232 re-point every dealer bid on a lot carries the SELLER's
  // tenant_id, so the subquery returns whoever bid last — which is the current
  // leader, whose own proxy is then correctly skipped. The feature looked
  // implemented and did nothing, which is exactly the state E-093 left it in.
  const rows = await tx.execute(sql`
    SELECT ab.id, ab.tenant_id, ab.bidder_dealer_id, ab.max_amount
      FROM auction_auto_bids ab
     WHERE ab.lot_id = ${input.lot_id}
       AND ab.status = 'active'
     ORDER BY ab.max_amount DESC, ab.created_at ASC
  `);

  const orders: StandingOrder[] = (
    rows as unknown as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    bidder_dealer_id: r.bidder_dealer_id ? String(r.bidder_dealer_id) : null,
    max_amount: Number(r.max_amount),
  }));

  const keyOf = (o: StandingOrder) => o.bidder_dealer_id ?? o.tenant_id;

  // Only orders that can actually beat the standing bid are in play, and never
  // the current leader's own — a proxy must not bid against its owner.
  const contenders = orders.filter(
    (o) =>
      keyOf(o) !== input.leaderKey &&
      o.max_amount >= input.current_bid + input.bid_increment,
  );

  if (contenders.length === 0) return [];

  const placed: ProxyBidPlaced[] = [];

  // Highest maximum wins; it needs to clear the SECOND-highest interest by one
  // increment, not to spend its whole ceiling. The second-highest interest is
  // the better of the runner-up's maximum and the bid just placed.
  const winner = contenders[0];
  const runnerUpMax = contenders[1]?.max_amount ?? 0;
  const mustBeat = Math.max(runnerUpMax, input.current_bid);
  const target = Math.min(winner.max_amount, mustBeat + input.bid_increment);

  // Only place a bid if it actually improves on the standing bid. Equal is not
  // higher, and a bid that does not lead is noise in an append-only log.
  if (target <= input.current_bid) return [];

  const isDealer = winner.bidder_dealer_id !== null;
  const tenantId = isDealer
    ? (input.seller_tenant_id ?? winner.tenant_id)
    : winner.tenant_id;

  const [bid] = await tx
    .insert(auctionBids)
    .values({
      lot_id: input.lot_id,
      tenant_id: tenantId,
      bidder_dealer_id: winner.bidder_dealer_id,
      bidder_kind: isDealer ? "dealer" : "nbfc",
      amount: String(target),
      placed_at: input.now,
    })
    .returning({ id: auctionBids.id });

  placed.push({
    bid_id: bid.id,
    amount: target,
    bidder_kind: isDealer ? "dealer" : "nbfc",
    bidder_dealer_id: winner.bidder_dealer_id,
    tenant_id: tenantId,
  });

  // A standing order that has reached its ceiling is exhausted — it can never
  // fire again, and leaving it 'active' means it is re-read on every subsequent
  // bid for the rest of the auction.
  if (target >= winner.max_amount) {
    await tx
      .update(auctionAutoBids)
      .set({ status: "exhausted", updated_at: input.now })
      .where(eq(auctionAutoBids.id, winner.id));
  }

  return placed;
}

/**
 * Sets or replaces a bidder's standing maximum.
 *
 * The partial unique index from E-093 allows only one 'active' row per
 * (lot, tenant), so an existing one is cancelled first — which is also what
 * keeps the change auditable rather than overwriting the previous ceiling.
 */
export async function setAutoBid(input: {
  lot_id: string;
  /** Seller tenant for a dealer order; the bidder's own tenant for an NBFC one. */
  tenant_id: string;
  bidder_dealer_id?: string | null;
  max_amount: number;
}): Promise<{ auto_bid_id: string }> {
  const { db } = await import("@/lib/db");
  return db.transaction(async (tx) => {
    await tx
      .update(auctionAutoBids)
      .set({ status: "cancelled", updated_at: new Date() })
      .where(and(eq(auctionAutoBids.lot_id, input.lot_id), ownerMatch(input)));

    const [row] = await tx
      .insert(auctionAutoBids)
      .values({
        lot_id: input.lot_id,
        tenant_id: input.tenant_id,
        bidder_dealer_id: input.bidder_dealer_id ?? null,
        max_amount: String(input.max_amount),
        status: "active",
      })
      .returning({ id: auctionAutoBids.id });

    return { auto_bid_id: row.id };
  });
}

export async function cancelAutoBid(input: {
  lot_id: string;
  tenant_id: string;
  bidder_dealer_id?: string | null;
}): Promise<{ cancelled: number }> {
  const { db } = await import("@/lib/db");
  const rows = await db
    .update(auctionAutoBids)
    .set({ status: "cancelled", updated_at: new Date() })
    .where(and(eq(auctionAutoBids.lot_id, input.lot_id), ownerMatch(input)))
    .returning({ id: auctionAutoBids.id });
  return { cancelled: rows.length };
}

/**
 * Matches the caller's own ACTIVE standing order.
 *
 * A dealer is identified by `bidder_dealer_id` and an NBFC by `tenant_id`,
 * because after the E-232 re-point tenant_id is the seller's on every dealer
 * row and therefore identifies nobody. Matching on tenant_id alone would let
 * one dealer cancel another dealer's standing order on the same lot.
 */
function ownerMatch(input: { tenant_id: string; bidder_dealer_id?: string | null }) {
  return and(
    eq(auctionAutoBids.status, "active"),
    input.bidder_dealer_id
      ? eq(auctionAutoBids.bidder_dealer_id, input.bidder_dealer_id)
      : and(
          eq(auctionAutoBids.tenant_id, input.tenant_id),
          isNull(auctionAutoBids.bidder_dealer_id),
        ),
  );
}
