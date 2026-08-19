/**
 * Draft lot lifecycle — edit, add, remove, discard, list.
 *
 * WHY THIS EXISTS
 *   `composeLot()` could create a draft and `publishLot()` could publish one,
 *   and nothing in between. A draft that can only be created and published is
 *   not a draft, it is a one-shot form: an operator who picked the wrong
 *   battery, or mistyped a price, had no way back except a new lot — and the
 *   batteries on the abandoned one stayed `lotted` for ever, unsellable,
 *   because only `ready` and `inspected` stock can be composed.
 *
 * THE RULE THAT RUNS THROUGH ALL OF IT
 *   Every operation refuses anything that is not still a draft. Once a lot is
 *   scheduled or live its audience is frozen and its price is the basis of live
 *   bids; editing either behind a bidder's back is not an edit, it is a
 *   different auction.
 *
 * WHERE BATTERIES GO
 *   A battery leaving a lot is always released to `ready`, never to whatever it
 *   was before. `ready` is also where the scheduler returns unsold stock, so
 *   there is exactly one answer to "where does a battery go when it leaves a
 *   lot" rather than one answer per exit path.
 */
import { db } from "@/lib/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  auctionLots,
  auctionLotItems,
  recoveryBatteries,
  nbfcAuditLog,
} from "@/lib/db/schema";
import {
  buildLotFacts,
  computeBidIncrement,
  getLotDetail,
  type AuctionType,
  type LotBattery,
  type LotSummary,
} from "@/lib/nbfc/auction/composeLot";

/** Loads a lot, asserting it is this tenant's and still a draft. */
async function loadDraftOrThrow(tenant_id: string, lot_id: string) {
  const [lot] = await db
    .select()
    .from(auctionLots)
    .where(
      and(
        eq(auctionLots.id, lot_id),
        eq(auctionLots.seller_tenant_id, tenant_id),
      ),
    )
    .limit(1);
  if (!lot) throw new Error("NOT_FOUND: lot not found for this NBFC");
  if (lot.status !== "draft") {
    throw new Error(
      `CONFLICT: lot is ${lot.status}, only a draft can be edited`,
    );
  }
  return lot;
}

/** The batteries currently on a lot, in the shape the arithmetic needs. */
async function batteriesOnLot(lot_id: string): Promise<LotBattery[]> {
  return db
    .select({
      id: recoveryBatteries.id,
      serial: recoveryBatteries.serial,
      condition_grade: recoveryBatteries.condition_grade,
      capacity: recoveryBatteries.capacity,
    })
    .from(auctionLotItems)
    .innerJoin(
      recoveryBatteries,
      eq(recoveryBatteries.id, auctionLotItems.battery_id),
    )
    .where(eq(auctionLotItems.lot_id, lot_id));
}

/**
 * Re-derives quantity, base price, increment, capacity, average SOH and age
 * from whatever is on the lot right now, and rewrites both the lot row and its
 * per-item prices.
 *
 * Changing the items ALWAYS resets the derived base price. An operator who
 * wants a hand-set price sets it once the item list has settled — the opposite
 * rule, where a custom price silently survives a change to what is being sold,
 * is the more dangerous of the two surprises.
 */
async function resyncDraftAggregates(lot_id: string): Promise<void> {
  const batteries = await batteriesOnLot(lot_id);
  const facts = await buildLotFacts(batteries);
  const basePrice = facts.derivedBase;

  await db.transaction(async (tx) => {
    for (const item of facts.items) {
      await tx
        .update(auctionLotItems)
        .set({
          item_price:
            item.item_price != null ? item.item_price.toFixed(2) : null,
        })
        .where(
          and(
            eq(auctionLotItems.lot_id, lot_id),
            eq(auctionLotItems.battery_id, item.battery_id),
          ),
        );
    }

    await tx
      .update(auctionLots)
      .set({
        quantity: facts.items.length,
        capacity: facts.capacity,
        avg_soh: facts.avgSoh != null ? facts.avgSoh.toFixed(2) : null,
        age_months: facts.ageMonths,
        // An emptied draft keeps its last price rather than writing 0.00 into a
        // NOT NULL numeric — and publishLot refuses an empty lot anyway.
        ...(basePrice > 0
          ? {
              base_price: basePrice.toFixed(2),
              bid_increment: computeBidIncrement(basePrice).toFixed(2),
            }
          : {}),
      })
      .where(eq(auctionLots.id, lot_id));
  });
}

export interface UpdateDraftLotInput {
  tenant_id: string;
  actor_user_id: string;
  lot_id: string;
  title?: string | null;
  auction_type?: AuctionType;
  base_price?: number | null;
  reserve_price?: number | null;
  bid_increment?: number | null;
  anti_snipe_seconds?: number;
}

/** Edits the scalar fields of a draft. Does not touch its items. */
export async function updateDraftLot(
  input: UpdateDraftLotInput,
): Promise<LotSummary> {
  const lot = await loadDraftOrThrow(input.tenant_id, input.lot_id);

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title || null;
  if (input.auction_type !== undefined) patch.auction_type = input.auction_type;
  if (input.anti_snipe_seconds !== undefined) {
    patch.anti_snipe_seconds = input.anti_snipe_seconds;
  }
  if (input.base_price !== undefined && input.base_price !== null) {
    if (!(input.base_price > 0)) {
      throw new Error("BAD_REQUEST: base price must be greater than zero");
    }
    patch.base_price = input.base_price.toFixed(2);
    // Keep the increment coherent unless one arrived in the same call.
    if (input.bid_increment === undefined || input.bid_increment === null) {
      patch.bid_increment = computeBidIncrement(input.base_price).toFixed(2);
    }
  }
  if (input.bid_increment !== undefined && input.bid_increment !== null) {
    if (!(input.bid_increment > 0)) {
      throw new Error("BAD_REQUEST: bid increment must be greater than zero");
    }
    patch.bid_increment = input.bid_increment.toFixed(2);
  }
  if (input.reserve_price !== undefined) {
    patch.reserve_price =
      input.reserve_price === null ? null : input.reserve_price.toFixed(2);
  }

  // A reserve below the base price can never bind: bidding opens AT the base
  // price, so such a reserve is always met by the first legal bid. Refusing it
  // is kinder than silently accepting a control that does nothing.
  const effectiveBase =
    input.base_price != null ? input.base_price : Number(lot.base_price);
  const effectiveReserve =
    input.reserve_price !== undefined
      ? input.reserve_price
      : lot.reserve_price != null
        ? Number(lot.reserve_price)
        : null;
  if (effectiveReserve != null && effectiveReserve < effectiveBase) {
    throw new Error(
      "BAD_REQUEST: reserve price cannot be below the base price — bidding opens at the base price",
    );
  }

  if (Object.keys(patch).length > 0) {
    await db
      .update(auctionLots)
      .set(patch)
      .where(eq(auctionLots.id, input.lot_id));

    await db.insert(nbfcAuditLog).values({
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "auction_lot_draft_updated",
      action_id: input.lot_id,
      before_state: {
        title: lot.title,
        base_price: Number(lot.base_price),
        reserve_price: lot.reserve_price ? Number(lot.reserve_price) : null,
        auction_type: lot.auction_type,
      },
      after_state: patch,
    });
  }

  const detail = await getLotDetail(input.lot_id);
  if (!detail) throw new Error("NOT_FOUND: lot not found for this NBFC");
  return detail;
}

export interface MutateLotItemsInput {
  tenant_id: string;
  actor_user_id: string;
  lot_id: string;
  battery_ids: string[];
}

/** Adds batteries to a draft under the same eligibility rules as compose. */
export async function addLotItems(
  input: MutateLotItemsInput,
): Promise<LotSummary> {
  await loadDraftOrThrow(input.tenant_id, input.lot_id);
  const uniqueIds = [...new Set(input.battery_ids)];
  if (uniqueIds.length === 0) {
    throw new Error("BAD_REQUEST: no batteries given");
  }

  const batteries = await db
    .select()
    .from(recoveryBatteries)
    .where(
      and(
        eq(recoveryBatteries.tenant_id, input.tenant_id),
        inArray(recoveryBatteries.id, uniqueIds),
      ),
    );
  if (batteries.length !== uniqueIds.length) {
    throw new Error(
      "NOT_FOUND: one or more batteries do not exist or belong to another NBFC",
    );
  }

  const notSellable = batteries.filter(
    (b) => b.state_code !== "ready" && b.state_code !== "inspected",
  );
  if (notSellable.length > 0) {
    throw new Error(
      `CONFLICT: ${notSellable
        .map((b) => `${b.serial} is ${b.state_code}`)
        .join(", ")} — only inspected or ready batteries can go into a lot`,
    );
  }

  const openRows = await db
    .select({
      battery_id: auctionLotItems.battery_id,
      lot_code: auctionLots.lot_code,
      status: auctionLots.status,
    })
    .from(auctionLotItems)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionLotItems.lot_id))
    .where(
      and(
        inArray(auctionLotItems.battery_id, uniqueIds),
        inArray(auctionLots.status, ["draft", "scheduled", "live", "paused"]),
      ),
    );
  if (openRows.length > 0) {
    throw new Error(
      `CONFLICT: already in an open lot — ${openRows
        .map((r) => `${r.lot_code} (${r.status})`)
        .join(", ")}`,
    );
  }

  await db.transaction(async (tx) => {
    await tx.insert(auctionLotItems).values(
      batteries.map((b) => ({
        lot_id: input.lot_id,
        battery_id: b.id,
        condition: b.condition_grade ?? "partial_working",
        item_price: null,
      })),
    );
    await tx
      .update(recoveryBatteries)
      .set({ state_code: "lotted", updated_at: new Date() })
      .where(inArray(recoveryBatteries.id, uniqueIds));
  });

  await resyncDraftAggregates(input.lot_id);

  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: "auction_lot_items_added",
    action_id: input.lot_id,
    before_state: {},
    after_state: { battery_ids: uniqueIds },
  });

  const detail = await getLotDetail(input.lot_id);
  if (!detail) throw new Error("NOT_FOUND: lot not found for this NBFC");
  return detail;
}

/** Removes one battery from a draft and releases it back to `ready`. */
export async function removeLotItem(input: {
  tenant_id: string;
  actor_user_id: string;
  lot_id: string;
  battery_id: string;
}): Promise<LotSummary> {
  await loadDraftOrThrow(input.tenant_id, input.lot_id);

  const removed = await db
    .delete(auctionLotItems)
    .where(
      and(
        eq(auctionLotItems.lot_id, input.lot_id),
        eq(auctionLotItems.battery_id, input.battery_id),
      ),
    )
    .returning({ battery_id: auctionLotItems.battery_id });

  if (removed.length === 0) {
    throw new Error("NOT_FOUND: that battery is not on this lot");
  }

  await db
    .update(recoveryBatteries)
    .set({ state_code: "ready", updated_at: new Date() })
    .where(
      and(
        eq(recoveryBatteries.id, input.battery_id),
        eq(recoveryBatteries.tenant_id, input.tenant_id),
      ),
    );

  await resyncDraftAggregates(input.lot_id);

  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: "auction_lot_item_removed",
    action_id: input.lot_id,
    before_state: { battery_id: input.battery_id },
    after_state: { released_to: "ready" },
  });

  const detail = await getLotDetail(input.lot_id);
  if (!detail) throw new Error("NOT_FOUND: lot not found for this NBFC");
  return detail;
}

/** Discards a draft and releases every battery on it. */
export async function discardDraftLot(input: {
  tenant_id: string;
  actor_user_id: string;
  lot_id: string;
}): Promise<{ lot_id: string; lot_code: string; released: number }> {
  const lot = await loadDraftOrThrow(input.tenant_id, input.lot_id);
  const batteries = await batteriesOnLot(input.lot_id);
  const ids = batteries.map((b) => b.id);

  await db.transaction(async (tx) => {
    await tx
      .delete(auctionLotItems)
      .where(eq(auctionLotItems.lot_id, input.lot_id));

    if (ids.length > 0) {
      await tx
        .update(recoveryBatteries)
        .set({ state_code: "ready", updated_at: new Date() })
        .where(
          and(
            inArray(recoveryBatteries.id, ids),
            eq(recoveryBatteries.tenant_id, input.tenant_id),
          ),
        );
    }

    // The lot row is cancelled, not deleted. A deleted draft leaves its audit
    // rows pointing at nothing, and lot_code is UNIQUE — a code that came back
    // later could never be reconciled against the log.
    await tx
      .update(auctionLots)
      .set({ status: "cancelled" })
      .where(eq(auctionLots.id, input.lot_id));

    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "auction_lot_draft_discarded",
      action_id: input.lot_id,
      before_state: { status: "draft", battery_ids: ids },
      after_state: { status: "cancelled", released: ids.length },
    });
  });

  return { lot_id: lot.id, lot_code: lot.lot_code, released: ids.length };
}

export type DraftLotSummary = LotSummary & {
  created_at: string;
  /** Seeded by the recovery Kanban rather than composed by hand. */
  auto_created: boolean;
};

/** Draft lots for a tenant, newest first — the composer's resume list. */
export async function listDraftLots(
  tenant_id: string,
): Promise<DraftLotSummary[]> {
  const lots = await db
    .select()
    .from(auctionLots)
    .where(
      and(
        eq(auctionLots.seller_tenant_id, tenant_id),
        eq(auctionLots.status, "draft"),
      ),
    )
    .orderBy(desc(auctionLots.created_at))
    .limit(100);

  if (lots.length === 0) return [];

  const itemRows = await db
    .select({
      lot_id: auctionLotItems.lot_id,
      battery_id: auctionLotItems.battery_id,
      condition: auctionLotItems.condition,
      item_price: auctionLotItems.item_price,
      serial: recoveryBatteries.serial,
    })
    .from(auctionLotItems)
    .leftJoin(
      recoveryBatteries,
      eq(recoveryBatteries.id, auctionLotItems.battery_id),
    )
    .where(
      inArray(
        auctionLotItems.lot_id,
        lots.map((l) => l.id),
      ),
    );

  const byLot = new Map<string, LotSummary["items"]>();
  for (const r of itemRows) {
    const list = byLot.get(r.lot_id) ?? [];
    list.push({
      battery_id: r.battery_id,
      serial: r.serial ?? "",
      condition: r.condition,
      item_price: r.item_price ? Number(r.item_price) : null,
    });
    byLot.set(r.lot_id, list);
  }

  return lots.map((lot) => ({
    lot_id: lot.id,
    lot_code: lot.lot_code,
    title: lot.title ?? null,
    status: lot.status,
    quantity: lot.quantity,
    base_price: Number(lot.base_price),
    bid_increment: Number(lot.bid_increment),
    reserve_price: lot.reserve_price ? Number(lot.reserve_price) : null,
    auction_type: lot.auction_type,
    starts_at: null,
    ends_at: null,
    items: byLot.get(lot.id) ?? [],
    created_at: (lot.created_at as Date).toISOString(),
    // publishLotFromRecovery derives its code from the pipeline uuid (8 hex
    // chars); the composer uses 6 random base-36 chars. Same prefix, different
    // length — enough to tell an operator where a draft came from.
    auto_created: lot.lot_code.replace("LOT-", "").length > 6,
  }));
}
