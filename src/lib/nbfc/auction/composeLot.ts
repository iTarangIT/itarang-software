/**
 * E-234 — composing and publishing a multi-battery auction lot (BRD §6, §7, §8).
 *
 * THE CONFLICT THIS RESOLVES
 *   `publishLotFromRecovery()` fires from `transitionStage()` the instant a
 *   battery reaches `ready_for_auction` and creates a lot that is ALREADY LIVE,
 *   with `quantity: 1` and a hard-coded 7-day window. The BRD asks for the
 *   opposite: an NBFC composes a lot by hand from several batteries, sets a
 *   visibility rule, and chooses a window of 2 / 12 / 24 / 48 hours.
 *
 *   So auto-publish becomes auto-DRAFT. The existing call site keeps working
 *   and keeps seeding a lot per battery; that lot is now a draft the operator
 *   can rename, add batteries to, price, and publish — or discard.
 *
 * THE LIFECYCLE
 *   draft -> scheduled -> live -> ended
 *              (or straight to live when starts_at is now)
 *   paused and cancelled hang off live.
 */
import { db } from "@/lib/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auctionLots,
  auctionLotItems,
  recoveryBatteries,
  nbfcRecoveryPipeline,
  nbfcBatteryEvaluations,
  nbfcAuditLog,
} from "@/lib/db/schema";
import {
  freezeAudience,
  type VisibilityRule,
  type AudienceChannel,
} from "@/lib/nbfc/auction/audience";
import { refurbishmentCostForBatteries } from "@/lib/nbfc/recovery/refurbishment";

/**
 * BRD §7 — the only legal windows. 48 h is a HARD maximum.
 *
 * A fixed list rather than a free minutes field: the BRD names four durations,
 * and an arbitrary number invites a 30-day lot that nothing in the anti-snipe
 * or notification design was built for.
 */
export const AUCTION_DURATIONS_HOURS = [2, 12, 24, 48] as const;
export type AuctionDurationHours = (typeof AUCTION_DURATIONS_HOURS)[number];

export const AUCTION_TYPES = ["cash", "cash_refinance"] as const;
export type AuctionType = (typeof AUCTION_TYPES)[number];

const MIN_BID_INCREMENT = 100;
const BID_INCREMENT_PCT = 0.02;

/** Same rule as createLot.ts: 2% of base, rounded to ₹100, floor ₹100. */
export function computeBidIncrement(basePrice: number): number {
  return Math.max(
    MIN_BID_INCREMENT,
    Math.round((basePrice * BID_INCREMENT_PCT) / 100) * 100,
  );
}

function lotCode(): string {
  // Six random base-36 characters. `createLot.ts` derives its code from the
  // pipeline uuid, which is fine for one-battery-one-lot and meaningless for a
  // composed lot that has no single source row.
  const rand = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .toUpperCase()
    .padStart(6, "0");
  return `LOT-${rand}`;
}

export interface ComposeLotInput {
  tenant_id: string;
  actor_user_id: string;
  title?: string | null;
  battery_ids: string[];
  auction_type?: AuctionType;
  /** Omitted → derived from the batteries' evaluations + refurbishment spend. */
  base_price?: number | null;
  reserve_price?: number | null;
  bid_increment?: number | null;
  anti_snipe_seconds?: number;
}

export interface LotSummary {
  lot_id: string;
  lot_code: string;
  title: string | null;
  status: string;
  quantity: number;
  base_price: number;
  bid_increment: number;
  reserve_price: number | null;
  auction_type: string;
  starts_at: string | null;
  ends_at: string | null;
  items: Array<{
    battery_id: string;
    serial: string;
    condition: string;
    item_price: number | null;
  }>;
}

/**
 * Creates a DRAFT lot from a set of batteries.
 *
 * The batteries must be the caller's, must be sellable, and must not already
 * sit in another lot that is still in play. That last check is deliberately in
 * code rather than a unique index on `battery_id`: a battery whose lot was
 * cancelled, or which went unsold, must be re-listable, and a blanket unique
 * would forbid that forever.
 */
export async function composeLot(input: ComposeLotInput): Promise<LotSummary> {
  if (input.battery_ids.length === 0) {
    throw new Error("BAD_REQUEST: a lot needs at least one battery");
  }
  const uniqueIds = [...new Set(input.battery_ids)];

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

  // Already in a lot that is still in play?
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

  // Per-item price: the battery's own evaluation price plus what its
  // refurbishment actually cost (BRD §15 — accessories are rolled in so the
  // dealer sees ONE number rather than an itemised bill).
  const refurbCosts = await refurbishmentCostForBatteries(uniqueIds);

  // Built with the query builder rather than raw SQL: drizzle's `sql` template
  // expands a JS array into a record tuple, so `= ANY(${ids}::uuid[])` fails
  // with `42846 cannot cast type record to uuid[]`. `inArray` emits the right
  // thing and stays parameterised.
  //
  // DISTINCT ON has no builder equivalent, so the newest-evaluation-per-battery
  // pick happens in JS off an ordered read. Reading the LATEST matters: a
  // battery re-evaluated after refurbishment has two rows, and pricing it off
  // the pre-repair figure would undercharge for the repair.
  const evalRows = await db
    .select({
      battery_id: nbfcRecoveryPipeline.battery_id,
      price: nbfcBatteryEvaluations.base_auction_price,
    })
    .from(nbfcRecoveryPipeline)
    .innerJoin(
      nbfcBatteryEvaluations,
      eq(nbfcBatteryEvaluations.recovery_pipeline_id, nbfcRecoveryPipeline.id),
    )
    .where(inArray(nbfcRecoveryPipeline.battery_id, uniqueIds))
    .orderBy(desc(nbfcBatteryEvaluations.created_at));

  const evalByBattery = new Map<string, number>();
  for (const r of evalRows) {
    if (!r.battery_id) continue;
    if (evalByBattery.has(r.battery_id)) continue; // first = newest
    evalByBattery.set(r.battery_id, Number(r.price) || 0);
  }

  const items = batteries.map((b) => {
    const itemPrice =
      (evalByBattery.get(b.id) ?? 0) + (refurbCosts.get(b.id) ?? 0);
    return {
      battery_id: b.id,
      serial: b.serial,
      condition: b.condition_grade ?? "partial_working",
      item_price: itemPrice > 0 ? itemPrice : null,
    };
  });

  const derivedBase = items.reduce((sum, i) => sum + (i.item_price ?? 0), 0);
  const basePrice = input.base_price ?? derivedBase;
  if (!(basePrice > 0)) {
    throw new Error(
      "BAD_REQUEST: base price is zero — evaluate the batteries first or set a base price explicitly",
    );
  }

  const increment = input.bid_increment ?? computeBidIncrement(basePrice);
  const avgSoh = null; // filled from telemetry at publish time if available

  const created = await db.transaction(async (tx) => {
    const [lot] = await tx
      .insert(auctionLots)
      .values({
        lot_code: lotCode(),
        title: input.title ?? null,
        capacity: batteries[0]?.capacity ?? null,
        avg_soh: avgSoh,
        age_months: null,
        quantity: items.length,
        base_price: basePrice.toFixed(2),
        bid_increment: increment.toFixed(2),
        reserve_price:
          input.reserve_price != null ? input.reserve_price.toFixed(2) : null,
        // Draft. This is the line that undoes the unconditional auto-publish.
        status: "draft",
        auction_type: input.auction_type ?? "cash",
        seller_tenant_id: input.tenant_id,
        anti_snipe_seconds: input.anti_snipe_seconds ?? 120,
        // NOT NULL on the table and meaningless for a draft. A far-future
        // placeholder is used rather than `now`, so that a draft accidentally
        // flipped to live cannot be instantly closed by the scheduler; publish
        // overwrites it with the real window.
        ends_at: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      })
      .returning();

    await tx.insert(auctionLotItems).values(
      items.map((i) => ({
        lot_id: lot.id,
        battery_id: i.battery_id,
        condition: i.condition,
        item_price: i.item_price != null ? i.item_price.toFixed(2) : null,
      })),
    );

    await tx
      .update(recoveryBatteries)
      .set({ state_code: "lotted", updated_at: new Date() })
      .where(inArray(recoveryBatteries.id, uniqueIds));

    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "auction_lot_draft",
      action_id: lot.id,
      before_state: { battery_ids: uniqueIds },
      after_state: {
        lot_id: lot.id,
        lot_code: lot.lot_code,
        quantity: items.length,
        base_price: basePrice,
        derived_base_price: derivedBase,
      },
    });

    return lot;
  });

  return {
    lot_id: created.id,
    lot_code: created.lot_code,
    title: created.title ?? null,
    status: created.status,
    quantity: created.quantity,
    base_price: Number(created.base_price),
    bid_increment: Number(created.bid_increment),
    reserve_price: created.reserve_price ? Number(created.reserve_price) : null,
    auction_type: created.auction_type,
    starts_at: null,
    ends_at: null,
    items,
  };
}

export interface PublishLotInput {
  tenant_id: string;
  actor_user_id: string;
  lot_id: string;
  duration_hours: AuctionDurationHours;
  /** Omitted → opens immediately. */
  starts_at?: string | null;
  visibility: VisibilityRule;
  channels?: AudienceChannel[];
}

export interface PublishLotResult {
  lot_id: string;
  lot_code: string;
  status: "scheduled" | "live";
  starts_at: string;
  ends_at: string;
  audience_dealers: number;
  audience_rows: number;
}

/**
 * Publishes a draft: fixes the window, resolves and freezes the audience, and
 * either opens the lot immediately or hands it to the scheduler.
 *
 * The duration is validated here AND typed, because the type only binds
 * TypeScript callers and this value arrives over HTTP.
 */
export async function publishLot(
  input: PublishLotInput,
): Promise<PublishLotResult> {
  if (
    !(AUCTION_DURATIONS_HOURS as readonly number[]).includes(
      input.duration_hours,
    )
  ) {
    throw new Error(
      `BAD_REQUEST: duration must be one of ${AUCTION_DURATIONS_HOURS.join(", ")} hours (48 h is the hard maximum)`,
    );
  }

  const [lot] = await db
    .select()
    .from(auctionLots)
    .where(
      and(
        eq(auctionLots.id, input.lot_id),
        eq(auctionLots.seller_tenant_id, input.tenant_id),
      ),
    )
    .limit(1);
  if (!lot) throw new Error("NOT_FOUND: lot not found for this NBFC");
  if (lot.status !== "draft") {
    throw new Error(`CONFLICT: lot is ${lot.status}, only a draft can be published`);
  }

  const [{ n: itemCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auctionLotItems)
    .where(eq(auctionLotItems.lot_id, lot.id));
  if (Number(itemCount) === 0) {
    throw new Error("CONFLICT: cannot publish a lot with no batteries in it");
  }

  const now = new Date();
  const startsAt = input.starts_at ? new Date(input.starts_at) : now;
  if (Number.isNaN(startsAt.getTime())) {
    throw new Error("BAD_REQUEST: starts_at is not a valid date");
  }
  // A start in the past is treated as "now" rather than refused: the operator's
  // intent is unambiguous, and refusing would fail a publish for being a few
  // seconds late.
  const effectiveStart = startsAt.getTime() < now.getTime() ? now : startsAt;
  const endsAt = new Date(
    effectiveStart.getTime() + input.duration_hours * 3600 * 1000,
  );
  const opensNow = effectiveStart.getTime() <= now.getTime();

  // Freeze the audience BEFORE flipping the status. A lot that goes live with
  // no audience row is a lot nobody can see and nobody was told about, and the
  // scheduler would happily run it to completion with zero bids.
  const audience = await freezeAudience({
    lot_id: lot.id,
    rule: input.visibility,
    channels: input.channels,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(auctionLots)
      .set({
        status: opensNow ? "live" : "scheduled",
        starts_at: effectiveStart,
        ends_at: endsAt,
        published_at: now,
      })
      .where(eq(auctionLots.id, lot.id));

    await tx.insert(nbfcAuditLog).values({
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "auction_lot_published",
      action_id: lot.id,
      before_state: { status: lot.status },
      after_state: {
        status: opensNow ? "live" : "scheduled",
        starts_at: effectiveStart.toISOString(),
        ends_at: endsAt.toISOString(),
        duration_hours: input.duration_hours,
        visibility: input.visibility,
        audience_dealers: audience.dealer_count,
      },
      created_at: now,
    });
  });

  return {
    lot_id: lot.id,
    lot_code: lot.lot_code,
    status: opensNow ? "live" : "scheduled",
    starts_at: effectiveStart.toISOString(),
    ends_at: endsAt.toISOString(),
    audience_dealers: audience.dealer_count,
    audience_rows: audience.row_count,
  };
}

/** Full detail for a lot, including its items. Used by every lot screen. */
export async function getLotDetail(
  lot_id: string,
): Promise<(LotSummary & { seller_tenant_id: string | null }) | null> {
  const [lot] = await db
    .select()
    .from(auctionLots)
    .where(eq(auctionLots.id, lot_id))
    .limit(1);
  if (!lot) return null;

  const items = await db
    .select({
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
    .where(eq(auctionLotItems.lot_id, lot_id));

  return {
    lot_id: lot.id,
    lot_code: lot.lot_code,
    title: lot.title ?? null,
    status: lot.status,
    quantity: lot.quantity,
    base_price: Number(lot.base_price),
    bid_increment: Number(lot.bid_increment),
    reserve_price: lot.reserve_price ? Number(lot.reserve_price) : null,
    auction_type: lot.auction_type,
    starts_at: lot.starts_at ? (lot.starts_at as Date).toISOString() : null,
    ends_at: (lot.ends_at as Date).toISOString(),
    seller_tenant_id: lot.seller_tenant_id ?? null,
    items: items.map((i) => ({
      battery_id: i.battery_id,
      serial: i.serial ?? "",
      condition: i.condition,
      item_price: i.item_price ? Number(i.item_price) : null,
    })),
  };
}
