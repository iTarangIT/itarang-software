/**
 * E-234 — the auction scheduler (Battery Auction BRD §25).
 *
 * THE HOLE THIS FILLS
 *   There is no job anywhere in this repo that closes an auction lot. A lot
 *   past its `ends_at` stays `live` forever unless an admin ends it by hand.
 *   With the 7-day windows the old auto-publish used, that was merely untidy.
 *   With the 2-hour windows the BRD asks for, it is fatal: the auction is over
 *   and the marketplace does not know.
 *
 * WHY AN IN-PROCESS TICKER AND NOT BULLMQ
 *   The design document says "BullMQ, never inline". BullMQ is dead code in
 *   this repo: `callQueue.add()` is never invoked, `ecosystem.prod.config.js`
 *   declares NO worker process at all, and the sandbox worker is deliberately
 *   dormant (`autorestart: false`, after a 1136-restart loop). Vercel crons do
 *   not fire on the pm2 VPS either. An in-process ticker is the only mechanism
 *   that demonstrably runs in BOTH sandbox and production — which is exactly
 *   the reasoning `startBuybackDispatchTicker()` already records for the same
 *   decision. `POST /api/cron/auction/tick` calls the same function, so an
 *   external scheduler can drive it too if one ever exists.
 *
 * WHAT ONE TICK DOES
 *   1. scheduled -> live   where starts_at has passed
 *   2. live      -> ended  where ends_at has passed, picking the winning bid
 *   3. flags lots inside their final hour so the notifier can warn bidders
 *
 * Ties are broken by EARLIEST bid. Two bidders at the same amount means the
 * second one never actually improved on the first, and rewarding the later bid
 * would make a tie worth manufacturing.
 */
import { db } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import {
  notifyEndingSoon,
  notifyLotClosed,
  runAuctionNotifications,
  type FanOutSummary,
} from "@/lib/nbfc/auction/notify";

/** One lot taken from `live` to `ended`, with the outcome that was recorded. */
export interface ClosedLot {
  lot_id: string;
  lot_code: string;
  winning_bid_id: string | null;
  winning_amount: number | null;
  winner_dealer_id: string | null;
  reserve_met: boolean;
  settlement_created: boolean;
}

export interface AuctionTickResult {
  opened: string[];
  closed: ClosedLot[];
  ending_soon: string[];
  /** One entry per lot whose publish fan-out was drained this tick. */
  fanned_out: FanOutSummary[];
}

/**
 * Claims ONE lot that is due to close, settles it, and returns what happened.
 * Returns null when there is nothing to claim.
 *
 * THIS IS THE ONLY PLACE AN EXPIRED LOT ENDS, and everything that wants a lot
 * ended goes through it. The admin "End now" action used to write
 * `auction_lots.status = 'ended'` itself, and because the claim below only ever
 * looks at lots that are still `live`, such a lot was never claimed: no winner
 * picked, no `auction_settlements` row, no `scheduler_close` audit, and its
 * batteries stranded at `lotted` — neither sold nor released for re-listing.
 * The sale was agreed and nothing recorded it.
 *
 * `reduceTime()` now moves `ends_at` only and calls `closeLotNow()`, and
 * `approveWinningBid()` calls it before awarding, so an early end is
 * indistinguishable from a natural one downstream. The one remaining writer of
 * `status = 'ended'` is `approveWinningBid()`'s own idempotent backstop, which
 * covers awarding a lot this closer will never claim (a paused lot past its
 * deadline); it runs after `closeLotNow()` has had its chance.
 *
 * THE CLAIM IS THE LOCK. `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
 * LOCKED)` rather than SELECT-then-UPDATE, so closers racing each other — a
 * slow tick, the cron route, and an admin ending a lot by hand — cannot both
 * take the same lot and both open a settlement.
 *
 * `status = 'live' AND ends_at <= now()` lives INSIDE the claim on purpose: a
 * caller may ask to close any lot at any moment and be told "not yet" by the
 * database rather than having to judge for itself. That is what makes an
 * unconditional call from `reduceTime()` safe — a lot with time left on it is
 * simply not claimed.
 */
async function claimAndCloseOneLot(opts: {
  nowSql: SQL;
  /** Restrict the claim to this lot. Absent: whichever lot is due first. */
  lotId?: string;
  /** Recorded on the audit row, so "ended early" is distinguishable later. */
  reason: string;
}): Promise<ClosedLot | null> {
  const { nowSql, lotId, reason } = opts;
  const onlyThisLot = lotId ? sql`AND id = ${lotId}` : sql``;

  // ONE TRANSACTION, and that matters as much as the claim itself.
  //
  // These five statements used to auto-commit one at a time, which published
  // `status = 'ended'` to every reader before the settlement, the stock move
  // and the audit row existed. Two consequences: readers saw a lot that had
  // ended with no sale recorded, and — worse — a crash in the gap left the lot
  // permanently unrecoverable, because the claim below only ever takes lots
  // that are still `live`. Committing the whole close together means a lot is
  // ended if and only if its outcome was written too.
  //
  // The row lock the claim takes is now held for the duration rather than
  // released at statement end, which is what makes the read-then-write of the
  // winning bid safe against a concurrent closer. `SKIP LOCKED` means the other
  // closer moves on to the next lot instead of blocking.
  return db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      UPDATE auction_lots
         SET status = 'ended'
       WHERE id = (
         SELECT id FROM auction_lots
          WHERE status = 'live' AND ends_at <= ${nowSql}
          ${onlyThisLot}
          ORDER BY ends_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, lot_code, reserve_price, seller_tenant_id
    `);
    const lot = (claimed as unknown as Array<Record<string, unknown>>)[0];
    if (!lot) return null;

    const lotIdStr = String(lot.id);
    const reserve = lot.reserve_price === null ? null : Number(lot.reserve_price);

    // Highest bid; earliest wins a tie.
    const topRows = await tx.execute(sql`
      SELECT id, amount, bidder_dealer_id, bidder_kind, tenant_id
        FROM auction_bids
       WHERE lot_id = ${lotIdStr}
       ORDER BY amount DESC, placed_at ASC
       LIMIT 1
    `);
    const top = (topRows as unknown as Array<Record<string, unknown>>)[0];

    const winningAmount = top ? Number(top.amount) : null;
    const reserveMet =
      reserve === null || (winningAmount !== null && winningAmount >= reserve);

    let settlementCreated = false;

    // A settlement is opened only when there IS a winner and the reserve was
    // met. An unsold lot ends with no settlement at all rather than one in a
    // "nobody bought it" state — `auction_settlements` means a sale happened,
    // and diluting that would break every seller-side report built on it.
    if (top && reserveMet && lot.seller_tenant_id) {
      const inserted = await tx.execute(sql`
        INSERT INTO auction_settlements
          (lot_id, seller_tenant_id, winner_tenant_id, winner_dealer_id,
           final_price, status)
        VALUES
          (${lotIdStr}, ${String(lot.seller_tenant_id)}, ${String(top.tenant_id)},
           ${top.bidder_dealer_id ? String(top.bidder_dealer_id) : null},
           ${String(winningAmount)}, 'payment_pending')
        ON CONFLICT (lot_id) DO NOTHING
        RETURNING id
      `);
      settlementCreated = (inserted as unknown as Array<unknown>).length > 0;

      // The batteries are sold. Without this they stay 'lotted' forever and
      // never appear in the composer again even though the lot is finished.
      await tx.execute(sql`
        UPDATE recovery_batteries
           SET state_code = 'sold', updated_at = ${nowSql}
         WHERE id IN (SELECT battery_id FROM auction_lot_items WHERE lot_id = ${lotIdStr})
      `);
    } else {
      // Unsold: hand the batteries back so they can be re-listed. This is the
      // case the old code had no path for at all, because it never closed a lot.
      await tx.execute(sql`
        UPDATE recovery_batteries
           SET state_code = 'ready', updated_at = ${nowSql}
         WHERE id IN (SELECT battery_id FROM auction_lot_items WHERE lot_id = ${lotIdStr})
           AND state_code = 'lotted'
      `);
    }

    await tx.execute(sql`
      INSERT INTO nbfc_auction_lot_actions
        (lot_id, action_code, previous_value, new_value, reason, acted_by)
      VALUES (
        ${lotIdStr}, 'scheduler_close',
        ${JSON.stringify({ status: "live" })}::jsonb,
        ${JSON.stringify({
          status: "ended",
          winning_bid_id: top ? String(top.id) : null,
          winning_amount: winningAmount,
          reserve_price: reserve,
          reserve_met: reserveMet,
          settlement_created: settlementCreated,
        })}::jsonb,
        ${reason},
        '00000000-0000-0000-0000-000000000000'
      )
    `);

    return {
      lot_id: lotIdStr,
      lot_code: String(lot.lot_code),
      winning_bid_id: top ? String(top.id) : null,
      winning_amount: winningAmount,
      winner_dealer_id: top?.bidder_dealer_id ? String(top.bidder_dealer_id) : null,
      reserve_met: reserveMet,
      settlement_created: settlementCreated,
    };
  });
}

/**
 * Closes one named lot right now, if it is due — the entry point for the admin
 * "End now" action, which pulls `ends_at` back to the present and then asks for
 * the close rather than performing one of its own.
 *
 * Safe to call unconditionally: the claim inside re-checks that the lot is
 * still live and its deadline has passed, so a lot with time left is left
 * alone and `null` comes back.
 */
export async function closeLotNow(input: {
  lot_id: string;
  reason?: string;
}): Promise<ClosedLot | null> {
  const closed = await claimAndCloseOneLot({
    nowSql: sql`now()`,
    lotId: input.lot_id,
    reason: input.reason ?? "ended early by an administrator",
  });
  if (!closed) return null;

  // Best-effort, same as the tick: the close is already committed, and a
  // notifier that throws must not make a completed sale look like a failure.
  try {
    await notifyLotClosed({
      lot_id: closed.lot_id,
      winner_dealer_id: closed.winner_dealer_id,
      final_price: closed.winning_amount,
      reserve_met: closed.reserve_met,
    });
  } catch (err) {
    console.error(
      `[auction] close notification failed for ${closed.lot_code}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return closed;
}

/**
 * Runs one scheduler pass.
 *
 * THE CLOCK IS THE DATABASE'S, NOT THIS PROCESS'S.
 *   Every deadline in this feature is a `timestamptz` written by Postgres, and
 *   every comparison below therefore uses Postgres's own `now()`. An earlier
 *   version stamped `new Date().toISOString()` in the application and compared
 *   against that; a local clock ~1 s behind RDS was enough to make a lot whose
 *   `ends_at` had demonstrably passed fail to match, so it stayed live and only
 *   closed once the skew happened to swing the other way. On a pm2 VPS with
 *   drifting NTP that is a lot that closes minutes late, silently.
 *
 *   `now` remains a parameter, but ONLY as an explicit override for tests that
 *   need to pin the clock. Absent it, nothing here reads the host clock at all.
 */
export async function runAuctionTick(now?: Date): Promise<AuctionTickResult> {
  const result: AuctionTickResult = {
    opened: [],
    closed: [],
    ending_soon: [],
    fanned_out: [],
  };

  // postgres-js binds parameters itself and does NOT accept a JS Date through
  // drizzle's raw `sql` template — it throws
  // `ERR_INVALID_ARG_TYPE: The "string" argument must be ... Received an
  // instance of Date`. An overriding timestamp goes in as ISO text and is cast
  // by Postgres. (The drizzle query builder converts Dates for you; `execute`
  // does not.)
  const nowSql = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;

  // ---- 1. Open scheduled lots whose start has passed. ----
  const opened = await db.execute(sql`
    UPDATE auction_lots
       SET status = 'live'
     WHERE status = 'scheduled'
       AND starts_at IS NOT NULL
       AND starts_at <= ${nowSql}
    RETURNING id, lot_code
  `);
  result.opened = (opened as unknown as Array<Record<string, unknown>>).map((r) =>
    String(r.lot_code),
  );

  // ---- 2. Close live lots whose deadline has passed. ----
  // One claim at a time through the shared closer, so this and the admin's
  // "End now" reach `ended` by exactly the same route.
  for (;;) {
    const closed = await claimAndCloseOneLot({
      nowSql,
      reason: "auction window elapsed",
    });
    if (!closed) break;
    result.closed.push(closed);

    // Safety valve: a runaway loop here would hold a DB connection forever.
    if (result.closed.length >= 200) break;
  }

  // Result notifications, once the closes are all committed. Outside the loop
  // so a slow SMTP server cannot hold a claimed-but-unclosed lot open, and
  // best-effort so it can never stop the next lot from closing.
  for (const c of result.closed) {
    await notifyLotClosed({
      lot_id: c.lot_id,
      winner_dealer_id: c.winner_dealer_id,
      final_price: c.winning_amount,
      reserve_met: c.reserve_met,
    });
  }

  // ---- 3. Lots entering their final hour. ----
  // The window is expressed as an interval on the SAME clock as the deadline,
  // rather than a millisecond offset computed here — for the reason in the
  // function's doc-block.
  const soon = await db.execute(sql`
    SELECT id, lot_code FROM auction_lots
     WHERE status = 'live'
       AND ends_at > ${nowSql}
       AND ends_at <= ${nowSql} + interval '1 hour'
  `);
  const soonRows = soon as unknown as Array<Record<string, unknown>>;
  result.ending_soon = soonRows.map((r) => String(r.lot_code));
  // notifyEndingSoon() is idempotent per lot — it writes an
  // `ending_soon_notified` action row and returns early if one exists. That
  // guard is load-bearing: at a 15 s interval this query matches the same lot
  // roughly 240 times inside its final hour.
  for (const r of soonRows) {
    await notifyEndingSoon(String(r.id));
  }

  // ---- 4. Drain the publish fan-out. ----
  // Deliberately last: closing lots on time matters more than announcing new
  // ones, so if a tick runs long it is the announcements that wait.
  result.fanned_out = await runAuctionNotifications();

  return result;
}
