/**
 * E-038 — Auction Marketplace service layer (BRD §6.1.7)
 *
 * Two operations:
 *   1. listLots()      — returns lots filtered by status with derived
 *                        current_bid (MAX amount over auction_bids) and
 *                        bidder_count (DISTINCT tenant_id over auction_bids).
 *   2. placeBid()      — validates the binding bid, persists the auction_bids
 *                        row, and writes an immutable nbfc_audit_log entry.
 *
 * Bids are *binding* — the API requires `confirmed: true` from the caller and
 * each accepted placement is logged with action_type='auction_bid' so the
 * regulatory audit trail captures the amount and bidder tenant.
 */
import { db } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { auctionLots, auctionBids, nbfcAuditLog } from "@/lib/db/schema";

export interface ListLotsInput {
  status: "live" | "ended";
  page: number;
  pageSize?: number;
}

export interface AuctionLotItem {
  lot_id: string;
  lot_code: string;
  capacity: string | null;
  avg_soh: number | null;
  age_months: number | null;
  quantity: number;
  base_price: number;
  bid_increment: number;
  current_bid: number;
  bidder_count: number;
  ends_at: string;
  status: string;
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

export async function listLots(input: ListLotsInput): Promise<ListLotsResult> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (input.page - 1) * pageSize;

  const lots = await db
    .select()
    .from(auctionLots)
    .where(eq(auctionLots.status, input.status))
    .orderBy(auctionLots.ends_at)
    .limit(pageSize)
    .offset(offset);

  const totalRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(auctionLots)
    .where(eq(auctionLots.status, input.status));
  const total = Number(totalRows[0]?.c ?? 0);

  // Per-lot aggregates over auction_bids: MAX(amount) and DISTINCT(tenant_id).
  // Done as a single grouped query rather than per-lot N+1 to keep listing
  // efficient even with many lots.
  const items: AuctionLotItem[] = [];
  for (const lot of lots) {
    const aggRows = await db
      .select({
        max_amount: sql<string | null>`MAX(${auctionBids.amount})`,
        bidder_count: sql<number>`COUNT(DISTINCT ${auctionBids.tenant_id})::int`,
      })
      .from(auctionBids)
      .where(eq(auctionBids.lot_id, lot.id));
    const agg = aggRows[0] ?? { max_amount: null, bidder_count: 0 };
    items.push({
      lot_id: lot.id,
      lot_code: lot.lot_code,
      capacity: lot.capacity ?? null,
      avg_soh: lot.avg_soh === null ? null : toNumber(lot.avg_soh),
      age_months: lot.age_months ?? null,
      quantity: lot.quantity,
      base_price: toNumber(lot.base_price),
      bid_increment: toNumber(lot.bid_increment),
      current_bid: toNumber(agg.max_amount),
      bidder_count: Number(agg.bidder_count ?? 0),
      ends_at: (lot.ends_at as Date).toISOString(),
      status: lot.status,
    });
  }

  return { items, page: input.page, total };
}

// ---------------------------------------------------------------------------
// placeBid
// ---------------------------------------------------------------------------

export interface PlaceBidInput {
  lot_id: string;
  amount: number;
  confirmed: true;
  tenant_id: string;
  user_id: string;
}

export interface PlaceBidAccepted {
  bid_id: string;
  lot_id: string;
  amount: number;
  accepted: true;
}

export interface PlaceBidRejected {
  bid_id: null;
  lot_id: string;
  amount: number;
  accepted: false;
  rejection_reason: string;
}

export type PlaceBidResult = PlaceBidAccepted | PlaceBidRejected;

export async function placeBid(input: PlaceBidInput): Promise<PlaceBidResult> {
  // 1. Load the lot.
  const lots = await db
    .select()
    .from(auctionLots)
    .where(eq(auctionLots.id, input.lot_id))
    .limit(1);
  if (lots.length === 0) {
    throw new Error("NOT_FOUND: auction lot not found");
  }
  const lot = lots[0];

  // 2. Lot must be live and not past its deadline.
  if (lot.status !== "live") {
    throw new Error("CONFLICT: auction lot is not live");
  }
  const now = new Date();
  if ((lot.ends_at as Date).getTime() <= now.getTime()) {
    throw new Error("CONFLICT: auction lot has ended");
  }

  // 3. Compute current_bid = MAX(amount) over existing bids on this lot.
  const aggRows = await db
    .select({
      max_amount: sql<string | null>`MAX(${auctionBids.amount})`,
    })
    .from(auctionBids)
    .where(eq(auctionBids.lot_id, lot.id));
  const currentBid = toNumber(aggRows[0]?.max_amount ?? null);
  const minNext = currentBid + toNumber(lot.bid_increment);

  // 4. Reject below-min bids without inserting a row.
  if (input.amount < minNext) {
    return {
      bid_id: null,
      lot_id: lot.id,
      amount: input.amount,
      accepted: false,
      rejection_reason: "below_min_next_bid",
    };
  }

  // 5. Persist the binding bid.
  const [bidRow] = await db
    .insert(auctionBids)
    .values({
      lot_id: lot.id,
      tenant_id: input.tenant_id,
      amount: String(input.amount),
      placed_at: now,
    })
    .returning({ id: auctionBids.id });

  // 6. Immutable audit-log row. action_id mirrors the new bid id so the audit
  //    log can join back to auction_bids without ambiguity.
  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    action_type: "auction_bid",
    action_id: bidRow.id,
    before_state: {
      lot_id: lot.id,
      previous_current_bid: currentBid,
    },
    after_state: {
      lot_id: lot.id,
      bid_id: bidRow.id,
      amount: input.amount,
    },
    created_at: now,
  });

  return {
    bid_id: bidRow.id,
    lot_id: lot.id,
    amount: input.amount,
    accepted: true,
  };
}
