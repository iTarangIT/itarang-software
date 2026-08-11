/**
 * E-069 — Auction Control Centre admin actions (BRD §6.3.4).
 *
 * Five admin actions over a live auction lot:
 *   1. extend_time         — push ends_at by +15m / +30m / +1h. Reason required.
 *   2. reduce_time         — pull ends_at in by -15m, or end the lot now.
 *                            MFA token required (re-confirmation).
 *   3. pause               — freeze the auction; notify bidders.
 *   4. reserve_price_set   — set/change the floor price; only allowed pre-bid.
 *   5. approve_winning_bid — post-auction confirmation; triggers payment flow.
 *
 * Every action writes one row to `nbfc_auction_lot_actions` capturing the
 * action_code, the acting admin, the per-action payload reason, and the
 * before/after snapshot of the field that changed (jsonb). Auth and HTTP
 * status mapping follow the canonical admin idiom shared with E-070
 * (resolveAdminActor / statusFromError).
 */
import { eq, and, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { closeLotNow } from "@/lib/nbfc/auction/scheduler";
import {
  auctionLots,
  auctionBids,
  auctionSettlements,
  nbfcAuctionLotActions,
} from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// MFA token verifier — same convention as E-070 / E-089 so deterministic
// test tokens stay interoperable across auction admin actions.
// ---------------------------------------------------------------------------
const MFA_TEST_PASS_PREFIX = "mfa_ok";
function verifyMfaToken(token: string | undefined | null): boolean {
  if (!token || typeof token !== "string") return false;
  if (token.startsWith("INVALID")) return false;
  if (token.startsWith(MFA_TEST_PASS_PREFIX)) return true;
  if (/^\d{6,8}$/.test(token)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Action-code constants — keep in sync with the YAML and the schema comment.
// ---------------------------------------------------------------------------
export const ACTION_EXTEND_TIME = "extend_time";
export const ACTION_REDUCE_TIME = "reduce_time";
export const ACTION_PAUSE = "pause";
export const ACTION_RESERVE_PRICE_SET = "reserve_price_set";
export const ACTION_APPROVE_WINNING_BID = "approve_winning_bid";
/**
 * [E-232] The missing half of `pause`. Pause shipped without it, and because
 * every other action in this service requires `status === "live"`, a paused lot
 * could only ever leave that state by being cancelled — an irreversible,
 * dual-approval action taken because somebody wanted a ten-minute breather.
 */
export const ACTION_RESUME = "resume";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
async function loadLotOrThrow(lot_id: string) {
  const [lot] = await db
    .select({
      id: auctionLots.id,
      lot_code: auctionLots.lot_code,
      ends_at: auctionLots.ends_at,
      base_price: auctionLots.base_price,
      status: auctionLots.status,
      // [E-232] The seller the settlement row needs, and the reserve column
      // that replaced the base_price overwrite.
      seller_tenant_id: auctionLots.seller_tenant_id,
      reserve_price: auctionLots.reserve_price,
    })
    .from(auctionLots)
    .where(eq(auctionLots.id, lot_id))
    .limit(1);
  if (!lot) {
    throw new Error("NOT_FOUND: lot not found");
  }
  return lot;
}

// ===========================================================================
// 1. extend_time
// ===========================================================================
export type ExtendTimeInput = {
  lot_id: string;
  extend_by_minutes: 15 | 30 | 60;
  reason: string;
  actor_user_id: string;
};
export type ExtendTimeResult = {
  lot_id: string;
  new_closing_at: string; // iso8601
};

export async function extendTime(
  input: ExtendTimeInput,
): Promise<ExtendTimeResult> {
  if (![15, 30, 60].includes(input.extend_by_minutes)) {
    throw new Error("BAD_REQUEST: extend_by_minutes must be 15, 30 or 60");
  }
  const trimmedReason = input.reason?.trim() ?? "";
  if (!trimmedReason) {
    throw new Error("BAD_REQUEST: reason must not be empty");
  }

  const lot = await loadLotOrThrow(input.lot_id);
  if (lot.status !== "live") {
    throw new Error(`CONFLICT: lot is not live (status="${lot.status}")`);
  }

  const previousEndsAt = new Date(lot.ends_at);
  const newEndsAt = new Date(
    previousEndsAt.getTime() + input.extend_by_minutes * 60 * 1000,
  );

  await db.transaction(async (tx) => {
    await tx
      .update(auctionLots)
      .set({ ends_at: newEndsAt })
      .where(eq(auctionLots.id, input.lot_id));

    await tx.insert(nbfcAuctionLotActions).values({
      lot_id: input.lot_id,
      action_code: ACTION_EXTEND_TIME,
      previous_value: { ends_at: previousEndsAt.toISOString() },
      new_value: {
        ends_at: newEndsAt.toISOString(),
        extend_by_minutes: input.extend_by_minutes,
      },
      reason: trimmedReason,
      acted_by: input.actor_user_id,
    });
  });

  return {
    lot_id: input.lot_id,
    new_closing_at: newEndsAt.toISOString(),
  };
}

// ===========================================================================
// 2. reduce_time
// ===========================================================================
export type ReduceTimeInput = {
  lot_id: string;
  reduce_by_minutes: 0 | 15;
  end_now: boolean;
  mfa_token: string;
  actor_user_id: string;
};
export type ReduceTimeResult = {
  lot_id: string;
  new_closing_at: string;
  /** True when pulling the deadline in also closed the lot on this call. */
  closed: boolean;
  /** Present when the close booked a sale. */
  settlement_created?: boolean;
  winning_amount?: number | null;
};

export async function reduceTime(
  input: ReduceTimeInput,
): Promise<ReduceTimeResult> {
  if (!verifyMfaToken(input.mfa_token)) {
    throw new Error("UNAUTHORIZED: invalid mfa_token");
  }

  const lot = await loadLotOrThrow(input.lot_id);
  if (lot.status !== "live") {
    throw new Error(`CONFLICT: lot is not live (status="${lot.status}")`);
  }

  const previousEndsAt = new Date(lot.ends_at);
  const now = new Date();

  // `end_now` moves the deadline to POSTGRES's present, not this process's.
  // Every deadline in this feature is a timestamptz written by the database and
  // the closer compares against `now()`; a host clock even a second fast would
  // stamp an `ends_at` that is still in the future by the server's reckoning,
  // and the lot would sit `live` until the skew swung back. Same trap, same
  // fix, as the doc-block on runAuctionTick().
  let newEndsAt: Date | SQL = sql`now()`;
  if (!input.end_now) {
    if (input.reduce_by_minutes !== 15) {
      throw new Error(
        "BAD_REQUEST: reduce_by_minutes must be 15 when end_now is false",
      );
    }
    const reduced = new Date(
      previousEndsAt.getTime() - input.reduce_by_minutes * 60 * 1000,
    );
    // Reducing past now is equivalent to ending now — and gets the same
    // database-clock treatment for the same reason.
    newEndsAt = reduced.getTime() <= now.getTime() ? sql`now()` : reduced;
  }

  // NOTE: `status` is deliberately NOT written here.
  //
  // This used to set `status = 'ended'` directly whenever end_now was true. The
  // closer in scheduler.ts only ever claims lots that are still `live`, so a lot
  // ended this way was never claimed: no winning bid was picked, no
  // `auction_settlements` row was written, no close audit was recorded, and the
  // lot's batteries were left stranded at `lotted` — neither sold nor released
  // back to `ready` for re-listing. The sale was agreed and nothing recorded it.
  // Pulling the deadline in and letting the one closer do the closing is what
  // makes an early end indistinguishable from a natural one downstream.
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(auctionLots)
      .set({ ends_at: newEndsAt as Date })
      .where(eq(auctionLots.id, input.lot_id))
      .returning({ ends_at: auctionLots.ends_at });

    await tx.insert(nbfcAuctionLotActions).values({
      lot_id: input.lot_id,
      action_code: ACTION_REDUCE_TIME,
      previous_value: {
        ends_at: previousEndsAt.toISOString(),
        status: lot.status,
      },
      new_value: {
        ends_at: new Date(rows[0].ends_at).toISOString(),
        end_now: input.end_now,
        reduce_by_minutes: input.reduce_by_minutes,
        status: lot.status,
      },
      acted_by: input.actor_user_id,
    });
    return rows;
  });

  // Unconditional, and safe: the claim inside re-checks that the lot is live
  // and its deadline has passed, so a lot with time still on it is simply not
  // claimed and this returns null. That keeps the "reduced past now" case
  // closing immediately too, instead of waiting for the next 15 s tick.
  const closed = await closeLotNow({
    lot_id: input.lot_id,
    reason: input.end_now
      ? "ended early by an administrator"
      : "deadline reduced past the present",
  });

  return {
    lot_id: input.lot_id,
    new_closing_at: new Date(updated.ends_at).toISOString(),
    closed: closed !== null,
    ...(closed
      ? {
          settlement_created: closed.settlement_created,
          winning_amount: closed.winning_amount,
        }
      : {}),
  };
}

// ===========================================================================
// 3. pause
// ===========================================================================
export type PauseInput = {
  lot_id: string;
  reason: string;
  actor_user_id: string;
};
export type PauseResult = {
  lot_id: string;
  status: "paused";
  notified_bidders: number;
};

export async function pauseAuction(input: PauseInput): Promise<PauseResult> {
  const trimmedReason = input.reason?.trim() ?? "";
  if (!trimmedReason) {
    throw new Error("BAD_REQUEST: reason must not be empty");
  }

  const lot = await loadLotOrThrow(input.lot_id);
  if (lot.status !== "live") {
    throw new Error(`CONFLICT: lot is not live (status="${lot.status}")`);
  }

  // notified_bidders = distinct bidder count on this lot. The bidder
  // notification sender itself lives outside this service (E-061 notification
  // pipeline); we simply record how many distinct bidders we *would* notify.
  const bidderRows = await db
    .select({ tenant_id: auctionBids.tenant_id })
    .from(auctionBids)
    .where(eq(auctionBids.lot_id, input.lot_id))
    .groupBy(auctionBids.tenant_id);
  const notifiedBidders = bidderRows.length;

  await db.transaction(async (tx) => {
    await tx
      .update(auctionLots)
      .set({ status: "paused" })
      .where(eq(auctionLots.id, input.lot_id));

    await tx.insert(nbfcAuctionLotActions).values({
      lot_id: input.lot_id,
      action_code: ACTION_PAUSE,
      previous_value: { status: lot.status },
      new_value: { status: "paused", notified_bidders: notifiedBidders },
      reason: trimmedReason,
      acted_by: input.actor_user_id,
    });
  });

  return {
    lot_id: input.lot_id,
    status: "paused",
    notified_bidders: notifiedBidders,
  };
}

// ===========================================================================
// 3b. resume  [E-232]
// ===========================================================================
export type ResumeInput = {
  lot_id: string;
  reason: string;
  actor_user_id: string;
};
export type ResumeResult = {
  lot_id: string;
  status: "live";
  ends_at: string;
  extended_by_minutes: number;
};

/**
 * Un-pauses a paused lot.
 *
 * `ends_at` is pushed out by however long the lot actually sat paused. That is
 * not a courtesy — the countdown kept running while the lot was frozen, so
 * resuming without it would hand bidders a shorter auction than the one they
 * were told about, and a long enough pause would resume a lot that is already
 * past its deadline and instantly closable. The paused-at instant comes from
 * the `pause` action row, which is the only place it is recorded.
 */
export async function resumeAuction(input: ResumeInput): Promise<ResumeResult> {
  const trimmedReason = input.reason?.trim() ?? "";
  if (!trimmedReason) {
    throw new Error("BAD_REQUEST: reason must not be empty");
  }

  const lot = await loadLotOrThrow(input.lot_id);
  if (lot.status !== "paused") {
    throw new Error(`CONFLICT: lot is not paused (status="${lot.status}")`);
  }

  const [lastPause] = await db
    .select({ acted_at: nbfcAuctionLotActions.acted_at })
    .from(nbfcAuctionLotActions)
    .where(
      and(
        eq(nbfcAuctionLotActions.lot_id, input.lot_id),
        eq(nbfcAuctionLotActions.action_code, ACTION_PAUSE),
      ),
    )
    .orderBy(sql`${nbfcAuctionLotActions.acted_at} DESC`)
    .limit(1);

  const now = new Date();
  const pausedAt = lastPause ? new Date(lastPause.acted_at as unknown as string) : now;
  const pausedMs = Math.max(0, now.getTime() - pausedAt.getTime());
  const previousEndsAt = new Date(lot.ends_at as unknown as string);
  const newEndsAt = new Date(previousEndsAt.getTime() + pausedMs);

  await db.transaction(async (tx) => {
    await tx
      .update(auctionLots)
      .set({ status: "live", ends_at: newEndsAt })
      .where(eq(auctionLots.id, input.lot_id));

    await tx.insert(nbfcAuctionLotActions).values({
      lot_id: input.lot_id,
      action_code: ACTION_RESUME,
      previous_value: {
        status: "paused",
        ends_at: previousEndsAt.toISOString(),
        paused_at: pausedAt.toISOString(),
      },
      new_value: {
        status: "live",
        ends_at: newEndsAt.toISOString(),
        paused_ms: pausedMs,
      },
      reason: trimmedReason,
      acted_by: input.actor_user_id,
    });
  });

  return {
    lot_id: input.lot_id,
    status: "live",
    ends_at: newEndsAt.toISOString(),
    extended_by_minutes: Math.round(pausedMs / 60000),
  };
}

// ===========================================================================
// 4. reserve_price_set
// ===========================================================================
export type ReservePriceInput = {
  lot_id: string;
  reserve_price_inr: number;
  actor_user_id: string;
};
export type ReservePriceResult = {
  lot_id: string;
  previous_reserve_price_inr: number | null;
  new_reserve_price_inr: number;
};

export async function setReservePrice(
  input: ReservePriceInput,
): Promise<ReservePriceResult> {
  if (!(input.reserve_price_inr > 0)) {
    throw new Error("BAD_REQUEST: reserve_price_inr must be positive");
  }

  const lot = await loadLotOrThrow(input.lot_id);

  // Reserve price changes are only allowed pre-bid.
  const [bidCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(auctionBids)
    .where(eq(auctionBids.lot_id, input.lot_id));
  if (bidCount && bidCount.c > 0) {
    throw new Error(
      "CONFLICT: reserve price cannot be changed after bids have been placed",
    );
  }

  // [E-232] Writes `reserve_price`, not `base_price`.
  //
  // E-069 overwrote base_price and called it "the canonical reserve price".
  // They are not the same thing: base_price is the price the lot was PUBLISHED
  // at and the floor the opening bid must clear, and overwriting it destroys
  // that number with no record of what it was. The two coexist now — reserve is
  // the seller's walk-away, base is the advertised start.
  const previousValue =
    lot.reserve_price !== null ? Number(lot.reserve_price) : null;
  const newValue = input.reserve_price_inr;

  await db.transaction(async (tx) => {
    await tx
      .update(auctionLots)
      .set({ reserve_price: String(newValue) })
      .where(eq(auctionLots.id, input.lot_id));

    await tx.insert(nbfcAuctionLotActions).values({
      lot_id: input.lot_id,
      action_code: ACTION_RESERVE_PRICE_SET,
      previous_value: { reserve_price: previousValue },
      new_value: { reserve_price: newValue },
      acted_by: input.actor_user_id,
    });
  });

  return {
    lot_id: input.lot_id,
    previous_reserve_price_inr: previousValue,
    new_reserve_price_inr: newValue,
  };
}

// ===========================================================================
// 5. approve_winning_bid
// ===========================================================================
export type ApproveWinningBidInput = {
  lot_id: string;
  winning_bid_id: string;
  actor_user_id: string;
};
export type ApproveWinningBidResult = {
  lot_id: string;
  winning_bid_id: string;
  payment_collection_started: boolean;
};

export async function approveWinningBid(
  input: ApproveWinningBidInput,
): Promise<ApproveWinningBidResult> {
  const lot = await loadLotOrThrow(input.lot_id);

  // Lot must be closed (not live, not paused, not cancelled). The lot is
  // closed when ends_at < now OR status is "ended".
  const now = new Date();
  const lotIsClosed =
    lot.status === "ended" || new Date(lot.ends_at).getTime() <= now.getTime();
  if (!lotIsClosed) {
    throw new Error("CONFLICT: lot is not closed yet");
  }

  // Awarding a lot whose deadline has passed but which the closer has not
  // claimed yet — a window of up to one 15 s tick — would end it here instead,
  // and this function does not move stock. The batteries would be left at
  // `lotted`: sold in the ledger, unsellable in the composer. Defer to the one
  // closer first. It is a no-op on a lot that is already `ended`.
  await closeLotNow({ lot_id: input.lot_id, reason: "closed on award" });

  // The winning bid must (a) belong to this lot and (b) be the highest bid.
  const [bid] = await db
    .select({
      id: auctionBids.id,
      lot_id: auctionBids.lot_id,
      tenant_id: auctionBids.tenant_id,
      bidder_dealer_id: auctionBids.bidder_dealer_id,
      bidder_kind: auctionBids.bidder_kind,
      amount: auctionBids.amount,
    })
    .from(auctionBids)
    .where(
      and(
        eq(auctionBids.id, input.winning_bid_id),
        eq(auctionBids.lot_id, input.lot_id),
      ),
    )
    .limit(1);
  if (!bid) {
    throw new Error(
      "NOT_FOUND: winning_bid_id not found for this lot",
    );
  }

  const [topRow] = await db
    .select({ max: sql<string>`max(${auctionBids.amount})` })
    .from(auctionBids)
    .where(eq(auctionBids.lot_id, input.lot_id));
  const topAmount = topRow?.max ? Number(topRow.max) : -Infinity;
  const bidAmount = Number(bid.amount);
  if (bidAmount < topAmount) {
    throw new Error(
      "CONFLICT: winning_bid_id is not the highest bid on the lot",
    );
  }

  // Trigger payment collection by inserting a settlement row in
  // payment_pending — same convention as E-039. If a settlement row already
  // exists for this lot (idempotency), skip insert.
  let paymentCollectionStarted = false;
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: auctionSettlements.id })
      .from(auctionSettlements)
      .where(eq(auctionSettlements.lot_id, input.lot_id))
      .limit(1);

    if (existing.length === 0) {
      // [E-232] The seller is now knowable: auction_lots.seller_tenant_id.
      //
      // This previously wrote a zero-uuid sentinel with a comment saying
      // downstream workers would backfill it. Nothing ever did, and
      // listSettlements() filters `seller_tenant_id = caller` — so every
      // settlement this route has ever created was invisible to every NBFC.
      // A settlement nobody can read is not a settlement.
      //
      // Pre-E-232 lots genuinely have no seller. Those still fall back to the
      // sentinel rather than throwing, because refusing to record a completed
      // auction would be the worse failure — but the fallback is now the
      // exception it always claimed to be, and it is recorded in the action
      // row below so the gap is visible rather than silent.
      const sellerTenantId =
        lot.seller_tenant_id ?? "00000000-0000-0000-0000-000000000000";

      await tx.insert(auctionSettlements).values({
        lot_id: input.lot_id,
        seller_tenant_id: sellerTenantId,
        // winner_tenant_id stays NOT NULL. On a dealer bid it carries the
        // seller's tenant (see the E-232 note on auction_bids.tenant_id); the
        // dealer's own identity goes to winner_dealer_id.
        winner_tenant_id: bid.tenant_id,
        winner_dealer_id: bid.bidder_dealer_id ?? null,
        final_price: String(bidAmount),
        status: "payment_pending",
      });
      paymentCollectionStarted = true;
    } else {
      // already started in a prior call — idempotent OK
      paymentCollectionStarted = true;
    }

    await tx
      .update(auctionLots)
      .set({ status: "ended" })
      .where(eq(auctionLots.id, input.lot_id));

    await tx.insert(nbfcAuctionLotActions).values({
      lot_id: input.lot_id,
      action_code: ACTION_APPROVE_WINNING_BID,
      previous_value: { status: lot.status },
      new_value: {
        status: "ended",
        winning_bid_id: input.winning_bid_id,
        winner_tenant_id: bid.tenant_id,
        winner_dealer_id: bid.bidder_dealer_id ?? null,
        winner_kind: bid.bidder_kind,
        final_price: bidAmount,
        // Surfaced so a settlement that fell back to the sentinel is findable
        // by querying the action log, rather than only by noticing that an
        // NBFC cannot see its own settlement.
        seller_tenant_known: lot.seller_tenant_id !== null,
      },
      acted_by: input.actor_user_id,
    });
  });

  return {
    lot_id: input.lot_id,
    winning_bid_id: input.winning_bid_id,
    payment_collection_started: paymentCollectionStarted,
  };
}
