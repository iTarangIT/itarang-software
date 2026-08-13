/**
 * E-038 — Auction Marketplace service layer (BRD §6.1.7)
 * E-232 — bidder re-point + concurrency fix (Battery Auction BRD §9, §11)
 *
 * Two operations:
 *   1. listLots()      — returns lots filtered by status with derived
 *                        current_bid (MAX amount over auction_bids) and
 *                        bidder_count (DISTINCT bidder over auction_bids).
 *   2. placeBid()      — validates the binding bid, persists the auction_bids
 *                        row, and writes an immutable nbfc_audit_log entry.
 *
 * Bids are *binding* — the API requires `confirmed: true` from the caller and
 * each accepted placement is logged with action_type='auction_bid' so the
 * regulatory audit trail captures the amount and the bidder.
 *
 * E-232 changed three things here, all of which were defects rather than
 * missing features:
 *
 *   - placeBid() now runs in ONE transaction with the lot row locked
 *     `FOR UPDATE`. It previously read `MAX(amount)`, decided, and inserted as
 *     three separate statements with nothing between them, so two simultaneous
 *     equal bids BOTH passed the check and BOTH inserted. That was survivable
 *     while every bidder was an internal NBFC tenant; it is not survivable now
 *     that dealers bid real money against each other.
 *
 *   - ListLotsInput.status was a hard `"live" | "ended"` union, so a paused or
 *     cancelled lot was invisible to every screen in the product rather than
 *     showing as paused (Battery Auction BRD §8 defect list).
 *
 *   - The per-lot aggregate loop claimed in its own comment to be "a single
 *     grouped query rather than per-lot N+1" and was, in fact, per-lot N+1. It
 *     is now genuinely one grouped query.
 */
import { db } from "@/lib/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auctionLots, auctionBids, nbfcAuditLog } from "@/lib/db/schema";
import { runAutoBidEngine } from "@/lib/nbfc/auction/autoBid";
import { notifyOutbid } from "@/lib/nbfc/auction/notify";

/**
 * Every status a lot can hold. `draft` and `scheduled` arrive with E-232 — a
 * lot is no longer published the instant a battery reaches ready_for_auction.
 * `all` is a listing convenience, not a stored value.
 */
export const AUCTION_LOT_STATUSES = [
  "draft",
  "scheduled",
  "live",
  "paused",
  "ended",
  "cancelled",
] as const;

export type AuctionLotStatus = (typeof AUCTION_LOT_STATUSES)[number];

export interface ListLotsInput {
  status: AuctionLotStatus | "all";
  page: number;
  pageSize?: number;
  /** Restrict to one seller. Omitted by the platform-wide admin listing. */
  seller_tenant_id?: string;
}

export interface AuctionLotItem {
  lot_id: string;
  lot_code: string;
  title: string | null;
  capacity: string | null;
  avg_soh: number | null;
  age_months: number | null;
  quantity: number;
  base_price: number;
  bid_increment: number;
  current_bid: number;
  bidder_count: number;
  starts_at: string | null;
  ends_at: string;
  status: string;
  auction_type: string;
  seller_tenant_id: string | null;
}

export interface ListLotsResult {
  items: AuctionLotItem[];
  page: number;
  total: number;
}

const DEFAULT_PAGE_SIZE = 50;

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A bidder is EITHER an NBFC tenant (the legacy, pre-E-232 shape) or a dealer
 * account (what the Battery Auction BRD §9 requires). They are modelled as a
 * discriminated union rather than two optional fields so that "a dealer bid
 * with no dealer id" is unrepresentable.
 */
export type BidderIdentity =
  | { kind: "nbfc"; tenant_id: string; user_id: string }
  | { kind: "dealer"; dealer_id: string; user_id: string };

export interface PlaceBidInput {
  lot_id: string;
  amount: number;
  confirmed: true;
  bidder: BidderIdentity;
}

export interface PlaceBidAccepted {
  bid_id: string;
  lot_id: string;
  amount: number;
  accepted: true;
  /**
   * The lot's deadline AFTER the bid. Anti-snipe may have pushed it out, and
   * the caller needs the new value to re-render its countdown — otherwise the
   * bidder watches a clock that is wrong until the next poll.
   */
  ends_at: string;
  /** True when this bid triggered an anti-snipe extension. */
  extended: boolean;
  /**
   * Set when a standing auto-bid immediately overtook this bid. The bidder is
   * told at once rather than being shown "accepted" while already losing.
   */
  outbid_by_proxy: number | null;
  /**
   * Whoever was leading immediately before this bid, or null on the opening
   * bid. This is the seam the `auction.outbid` notification hangs off in
   * Phase 5 — resolved inside the same locked transaction, so it cannot
   * misattribute the outbid to someone who has since been overtaken.
   */
  previous_leader: {
    bidder_kind: string;
    bidder_dealer_id: string | null;
    tenant_id: string;
    amount: number;
  } | null;
}

export interface PlaceBidRejected {
  bid_id: null;
  lot_id: string;
  amount: number;
  accepted: false;
  rejection_reason: string;
  /** What the bidder would have had to offer. Lets the UI say so precisely. */
  min_next_bid: number;
}

export type PlaceBidResult = PlaceBidAccepted | PlaceBidRejected;

export async function listLots(input: ListLotsInput): Promise<ListLotsResult> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (input.page - 1) * pageSize;

  const conditions = [
    input.status === "all" ? undefined : eq(auctionLots.status, input.status),
    input.seller_tenant_id
      ? eq(auctionLots.seller_tenant_id, input.seller_tenant_id)
      : undefined,
  ].filter(Boolean);
  const where = conditions.length === 0 ? undefined : and(...conditions);

  const lotsQuery = db.select().from(auctionLots);
  const lots = await (where ? lotsQuery.where(where) : lotsQuery)
    .orderBy(auctionLots.ends_at)
    .limit(pageSize)
    .offset(offset);

  const totalQuery = db
    .select({ c: sql<number>`count(*)::int` })
    .from(auctionLots);
  const totalRows = await (where ? totalQuery.where(where) : totalQuery);
  const total = Number(totalRows[0]?.c ?? 0);

  // ONE grouped query for every lot on the page, not one query per lot.
  //
  // bidder_count counts DISTINCT *bidders*, and after E-232 a bidder is either
  // a dealer account or an NBFC tenant. COALESCE picks whichever identity the
  // row actually carries — counting tenant_id alone would collapse every dealer
  // bidding on one seller's lot into a single "bidder", because a dealer bid
  // stores the SELLER's tenant in that column.
  const aggByLot = new Map<string, { max_amount: number; bidder_count: number }>();
  if (lots.length > 0) {
    const aggRows = await db
      .select({
        lot_id: auctionBids.lot_id,
        max_amount: sql<string | null>`MAX(${auctionBids.amount})`,
        bidder_count: sql<number>`COUNT(DISTINCT COALESCE(${auctionBids.bidder_dealer_id}::text, ${auctionBids.tenant_id}::text))::int`,
      })
      .from(auctionBids)
      .where(
        inArray(
          auctionBids.lot_id,
          lots.map((l) => l.id),
        ),
      )
      .groupBy(auctionBids.lot_id);

    for (const row of aggRows) {
      aggByLot.set(row.lot_id, {
        max_amount: toNumber(row.max_amount),
        bidder_count: Number(row.bidder_count ?? 0),
      });
    }
  }

  const items: AuctionLotItem[] = lots.map((lot) => {
    const agg = aggByLot.get(lot.id);
    return {
      lot_id: lot.id,
      lot_code: lot.lot_code,
      title: lot.title ?? null,
      capacity: lot.capacity ?? null,
      avg_soh: lot.avg_soh === null ? null : toNumber(lot.avg_soh),
      age_months: lot.age_months ?? null,
      quantity: lot.quantity,
      base_price: toNumber(lot.base_price),
      bid_increment: toNumber(lot.bid_increment),
      current_bid: agg?.max_amount ?? 0,
      bidder_count: agg?.bidder_count ?? 0,
      starts_at: lot.starts_at ? (lot.starts_at as Date).toISOString() : null,
      ends_at: (lot.ends_at as Date).toISOString(),
      status: lot.status,
      auction_type: lot.auction_type,
      seller_tenant_id: lot.seller_tenant_id ?? null,
    };
  });

  return { items, page: input.page, total };
}

// ---------------------------------------------------------------------------
// placeBid
// ---------------------------------------------------------------------------

type LockedLot = {
  id: string;
  status: string;
  ends_at: Date;
  base_price: string;
  bid_increment: string;
  reserve_price: string | null;
  anti_snipe_seconds: number;
  seller_tenant_id: string | null;
};

/**
 * Places one binding bid.
 *
 * The whole body runs inside a single transaction with the lot row locked
 * `FOR UPDATE`. That lock is the entire point of this function's shape: the
 * "is this bid high enough" question and the INSERT that answers it must be
 * indivisible, or two bidders racing to the same amount both win.
 *
 * Anti-snipe (BRD §11) is applied in the same transaction. It has to be — a
 * bid accepted against `ends_at` and an extension written afterwards is a
 * window in which the scheduler can close the lot the bid just saved.
 */
export async function placeBid(input: PlaceBidInput): Promise<PlaceBidResult> {
  const result = await db.transaction(async (tx) => {
    // 1. Load AND lock the lot. Everything below reads a lot nobody else can
    //    move until this transaction commits.
    const lockedRows = await tx.execute(sql`
      SELECT id, status, ends_at, base_price, bid_increment,
             reserve_price, anti_snipe_seconds, seller_tenant_id
        FROM auction_lots
       WHERE id = ${input.lot_id}
       FOR UPDATE
    `);
    const row = (lockedRows as unknown as Array<Record<string, unknown>>)[0];
    if (!row) {
      throw new Error("NOT_FOUND: auction lot not found");
    }
    const lot: LockedLot = {
      id: String(row.id),
      status: String(row.status),
      ends_at: new Date(row.ends_at as string),
      base_price: String(row.base_price),
      bid_increment: String(row.bid_increment),
      reserve_price: row.reserve_price === null ? null : String(row.reserve_price),
      anti_snipe_seconds: Number(row.anti_snipe_seconds ?? 120),
      seller_tenant_id: row.seller_tenant_id ? String(row.seller_tenant_id) : null,
    };

    // 2. Lot must be live and not past its deadline.
    if (lot.status !== "live") {
      throw new Error(`CONFLICT: auction lot is ${lot.status}, not live`);
    }
    const now = new Date();
    if (lot.ends_at.getTime() <= now.getTime()) {
      throw new Error("CONFLICT: auction lot has ended");
    }

    // 3. Resolve the two identity columns.
    //
    //    auction_bids.tenant_id is NOT NULL and, for a dealer bid, carries the
    //    SELLER's tenant — which is what puts the nbfc_audit_log row for this
    //    bid in the right tenant's log and keeps every existing tenant-scoped
    //    index on auction_bids meaningful. A pre-E-232 lot has no seller at
    //    all, so a dealer bid on one cannot be attributed to anybody and is
    //    refused rather than mis-filed.
    let tenantId: string;
    let bidderDealerId: string | null = null;
    if (input.bidder.kind === "dealer") {
      if (!lot.seller_tenant_id) {
        throw new Error(
          "CONFLICT: this lot predates E-232 and has no seller tenant; it cannot accept dealer bids",
        );
      }
      tenantId = lot.seller_tenant_id;
      bidderDealerId = input.bidder.dealer_id;
    } else {
      tenantId = input.bidder.tenant_id;
    }

    // 4. Current standing bid, read under the same lock, plus the leader we are
    //    about to displace.
    const leaderRows = await tx.execute(sql`
      SELECT amount, tenant_id, bidder_dealer_id, bidder_kind
        FROM auction_bids
       WHERE lot_id = ${lot.id}
       ORDER BY amount DESC, placed_at ASC
       LIMIT 1
    `);
    const leader = (leaderRows as unknown as Array<Record<string, unknown>>)[0];
    const currentBid = leader ? toNumber(leader.amount) : 0;

    // The first bid must clear the base price; every later bid must clear the
    // standing bid by at least one increment.
    const minNext =
      currentBid === 0
        ? toNumber(lot.base_price)
        : currentBid + toNumber(lot.bid_increment);

    // 5. Reject a low bid without inserting a row. A rejected bid is not a bid.
    if (input.amount < minNext) {
      return {
        bid_id: null,
        lot_id: lot.id,
        amount: input.amount,
        accepted: false,
        rejection_reason: "below_min_next_bid",
        min_next_bid: minNext,
      } satisfies PlaceBidRejected;
    }

    // 6. Anti-snipe. A bid inside the window pushes the deadline out by the
    //    same window, so the auction always ends on a quiet moment rather than
    //    on whoever clicked last.
    let endsAt = lot.ends_at;
    let extended = false;
    const msRemaining = lot.ends_at.getTime() - now.getTime();
    const windowMs = lot.anti_snipe_seconds * 1000;
    if (lot.anti_snipe_seconds > 0 && msRemaining <= windowMs) {
      endsAt = new Date(now.getTime() + windowMs);
      extended = true;
      await tx
        .update(auctionLots)
        .set({ ends_at: endsAt })
        .where(eq(auctionLots.id, lot.id));
    }

    // 7. Persist the binding bid.
    const [bidRow] = await tx
      .insert(auctionBids)
      .values({
        lot_id: lot.id,
        tenant_id: tenantId,
        bidder_dealer_id: bidderDealerId,
        bidder_kind: input.bidder.kind,
        amount: String(input.amount),
        placed_at: now,
      })
      .returning({ id: auctionBids.id });

    // 8. [E-234] The auto-bid proxy engine, inside the SAME transaction.
    //
    //    Running it afterwards would leave a window in which this manual bid is
    //    visible and leading while the standing order that should have beaten
    //    it has not fired — and the scheduler could close the lot inside that
    //    window and award it to the wrong bidder.
    const leaderKey = bidderDealerId ?? tenantId;
    const proxyBids = await runAutoBidEngine(tx, {
      lot_id: lot.id,
      current_bid: input.amount,
      bid_increment: toNumber(lot.bid_increment),
      leaderKey,
      seller_tenant_id: lot.seller_tenant_id,
      now,
    });

    // 9. Immutable audit-log row. action_id mirrors the new bid id so the audit
    //    log can join back to auction_bids without ambiguity.
    await tx.insert(nbfcAuditLog).values({
      tenant_id: tenantId,
      user_id: input.bidder.user_id,
      action_type: "auction_bid",
      action_id: bidRow.id,
      before_state: {
        lot_id: lot.id,
        previous_current_bid: currentBid,
        ends_at: lot.ends_at.toISOString(),
      },
      after_state: {
        lot_id: lot.id,
        bid_id: bidRow.id,
        amount: input.amount,
        bidder_kind: input.bidder.kind,
        bidder_dealer_id: bidderDealerId,
        ends_at: endsAt.toISOString(),
        anti_snipe_extended: extended,
        proxy_bids: proxyBids.map((p) => ({
          bid_id: p.bid_id,
          amount: p.amount,
          bidder_dealer_id: p.bidder_dealer_id,
        })),
      },
      created_at: now,
    });

    return {
      bid_id: bidRow.id,
      lot_id: lot.id,
      amount: input.amount,
      accepted: true,
      ends_at: endsAt.toISOString(),
      extended,
      // The bidder needs to know immediately that a standing order overtook
      // them — telling them "bid accepted" while they are already losing is
      // the single most misleading thing this endpoint could do.
      outbid_by_proxy:
        proxyBids.length > 0 ? proxyBids[proxyBids.length - 1].amount : null,
      previous_leader: leader
        ? {
            bidder_kind: String(leader.bidder_kind ?? "nbfc"),
            bidder_dealer_id: leader.bidder_dealer_id
              ? String(leader.bidder_dealer_id)
              : null,
            tenant_id: String(leader.tenant_id),
            amount: currentBid,
          }
        : null,
    } satisfies PlaceBidAccepted;
  });

  // AFTER the commit, never inside it. An emit() that hangs on SMTP must not
  // hold the lot's row lock — that lock is what every other bidder is queued
  // behind — and a notification failure must not roll back an accepted bid.
  if (result.accepted) await announceOutbids(input, result);
  return result;
}

/**
 * Fans out `auction.outbid` for a bid that has already committed.
 *
 * TWO dealers can be displaced by one bid, which is why this is not a single
 * emit at the call site:
 *
 *   1. whoever was leading before it (`previous_leader`), and
 *   2. the bidder themselves, when the proxy engine walked a rival's standing
 *      maximum past them in the same transaction.
 *
 * The current leader is re-read rather than inferred, because `outbid_by_proxy`
 * carries the winning amount but not who owns it. One indexed read is cheaper
 * than threading the identity through the engine's return type, and it is
 * self-correcting: whoever the lot says is leading now is who is leading now.
 */
async function announceOutbids(
  input: PlaceBidInput,
  result: PlaceBidAccepted,
): Promise<void> {
  try {
    const bidderDealerId =
      input.bidder.kind === "dealer" ? input.bidder.dealer_id : null;

    const topRows = await db.execute(sql`
      SELECT amount, bidder_dealer_id
        FROM auction_bids
       WHERE lot_id = ${input.lot_id}
       ORDER BY amount DESC, placed_at ASC
       LIMIT 1
    `);
    const top = (topRows as unknown as Array<Record<string, unknown>>)[0];
    const leaderDealerId = top?.bidder_dealer_id
      ? String(top.bidder_dealer_id)
      : null;
    const leadingAmount = top ? Number(top.amount) : result.amount;

    // Both calls no-op when the dealer is null or is the new leader.
    await notifyOutbid({
      lot_id: input.lot_id,
      outbid_dealer_id: result.previous_leader?.bidder_dealer_id ?? null,
      new_leader_dealer_id: leaderDealerId,
      new_amount: leadingAmount,
    });
    if (result.outbid_by_proxy != null) {
      await notifyOutbid({
        lot_id: input.lot_id,
        outbid_dealer_id: bidderDealerId,
        new_leader_dealer_id: leaderDealerId,
        new_amount: leadingAmount,
      });
    }
  } catch (err) {
    console.error("[auction] outbid fan-out failed:", err);
  }
}
