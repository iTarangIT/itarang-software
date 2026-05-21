import { and, eq, sql, SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, paraphernaliaStock } from "@/lib/db/schema";
import { normalizeInventoryStatus } from "@/lib/inventory/status";

/**
 * Canonical inventory aggregator — the single source of truth shared by the
 * admin inventory dashboard and the dealer inventory dashboard so the two
 * screens always report the same numbers for the same dealer.
 *
 * Counting rules:
 *  - Serialized stock (battery, charger): one unit per `inventory` row whose
 *    `inventory_type` is NOT `paraphernalia_lot`.
 *  - Paraphernalia stock: the live `paraphernalia_stock` ledger
 *    (`available_qty` / `reserved_qty` / `sold_qty`).
 *  - `inventory` rows with `inventory_type = 'paraphernalia_lot'` are invoice
 *    receipts — they are NEVER counted as stock units.
 *
 * Status → bucket mapping (serialized rows):
 *    available | transferred_in | in_stock  → available
 *    reserved                               → reserved
 *    sold | dispatched                      → sold
 *    written_off                            → writtenOff (NOT in totalUnits)
 *    transferred_out                        → excluded entirely
 *
 * Total Units = available + reserved + sold.
 * Stock Value = available serialized value + available paraphernalia value.
 */

export interface InventorySummary {
  totalUnits: number; // available + reserved + sold
  availableUnits: number;
  reservedUnits: number;
  soldUnits: number;
  writtenOffUnits: number; // serialized only; NOT part of totalUnits
  stockValue: number; // value of currently-available stock
}

export type InventorySummaryScope = {
  /** Omit for an all-dealers (network-wide) total. */
  dealerId?: string;
  /** Omit for all categories. */
  category?: "battery" | "charger" | "paraphernalia";
};

// NOTE: there is deliberately no `status` scope. The summary IS the per-status
// breakdown (available / reserved / sold), so scoping it by a single status
// would be self-contradictory and would make "Total units" jump around as the
// caller changes a status filter.

type Bucket = "available" | "reserved" | "sold" | "writtenOff" | null;

function bucketOf(rawStatus: string | null | undefined): Bucket {
  const s = normalizeInventoryStatus(rawStatus);
  if (s === "available" || s === "transferred_in") return "available";
  if (s === "reserved") return "reserved";
  if (s === "sold" || s === "dispatched") return "sold";
  if (s === "written_off") return "writtenOff";
  return null; // transferred_out and anything unknown → excluded
}

/** True when a pg error (or any wrapped cause) carries the given SQLSTATE. */
function hasPgCode(error: unknown, code: string): boolean {
  let curr: unknown = error;
  while (curr && typeof curr === "object") {
    const rec = curr as { code?: string; cause?: unknown };
    if (rec.code === code) return true;
    curr = rec.cause;
  }
  return false;
}

const EMPTY_SUMMARY: InventorySummary = {
  totalUnits: 0,
  availableUnits: 0,
  reservedUnits: 0,
  soldUnits: 0,
  writtenOffUnits: 0,
  stockValue: 0,
};

export async function getInventorySummary(
  scope: InventorySummaryScope,
): Promise<InventorySummary> {
  const { dealerId, category } = scope;

  const summary: InventorySummary = { ...EMPTY_SUMMARY };

  // ── Serialized stock (battery / charger) from `inventory` ────────────────
  if (category !== "paraphernalia") {
    const conds: SQL[] = [
      // NULL-safe: keeps legacy rows whose inventory_type was never populated.
      sql`${inventory.inventory_type} is distinct from 'paraphernalia_lot'`,
    ];
    if (dealerId) conds.push(eq(inventory.dealer_id, dealerId));
    if (category === "battery" || category === "charger") {
      conds.push(eq(inventory.asset_type, category));
    }

    try {
      const rows = await db
        .select({
          status: inventory.status,
          units: sql<number>`count(*)::int`,
          value: sql<number>`coalesce(sum(coalesce(${inventory.final_amount}, ${inventory.inventory_amount})), 0)::float`,
        })
        .from(inventory)
        .where(and(...conds))
        .groupBy(inventory.status);

      for (const r of rows) {
        const bucket = bucketOf(r.status);
        if (bucket === "available") {
          summary.availableUnits += r.units;
          summary.stockValue += Number(r.value || 0);
        } else if (bucket === "reserved") {
          summary.reservedUnits += r.units;
        } else if (bucket === "sold") {
          summary.soldUnits += r.units;
        } else if (bucket === "writtenOff") {
          summary.writtenOffUnits += r.units;
        }
      }
    } catch (error) {
      // Legacy schema without inventory_type / final_amount columns —
      // degrade gracefully rather than 500 the whole dashboard.
      if (!hasPgCode(error, "42703")) throw error;

      const legacyConds: SQL[] = [];
      if (dealerId) legacyConds.push(eq(inventory.dealer_id, dealerId));
      if (category === "battery" || category === "charger") {
        legacyConds.push(eq(inventory.asset_type, category));
      }
      const rows = await db
        .select({
          status: inventory.status,
          units: sql<number>`count(*)::int`,
          value: sql<number>`coalesce(sum(${inventory.inventory_amount}), 0)::float`,
        })
        .from(inventory)
        .where(legacyConds.length ? and(...legacyConds) : undefined)
        .groupBy(inventory.status);

      for (const r of rows) {
        const bucket = bucketOf(r.status);
        if (bucket === "available") {
          summary.availableUnits += r.units;
          summary.stockValue += Number(r.value || 0);
        } else if (bucket === "reserved") {
          summary.reservedUnits += r.units;
        } else if (bucket === "sold") {
          summary.soldUnits += r.units;
        } else if (bucket === "writtenOff") {
          summary.writtenOffUnits += r.units;
        }
      }
    }
  }

  // ── Paraphernalia stock from the `paraphernalia_stock` ledger ────────────
  if (category !== "battery" && category !== "charger") {
    try {
      const [para] = await db
        .select({
          available: sql<number>`coalesce(sum(${paraphernaliaStock.available_qty}), 0)::int`,
          reserved: sql<number>`coalesce(sum(${paraphernaliaStock.reserved_qty}), 0)::int`,
          sold: sql<number>`coalesce(sum(${paraphernaliaStock.sold_qty}), 0)::int`,
          value: sql<number>`coalesce(sum(${paraphernaliaStock.available_qty} * ${paraphernaliaStock.unit_cost}), 0)::float`,
        })
        .from(paraphernaliaStock)
        .where(dealerId ? eq(paraphernaliaStock.dealer_id, dealerId) : undefined);

      if (para) {
        summary.availableUnits += para.available;
        summary.reservedUnits += para.reserved;
        summary.soldUnits += para.sold;
        summary.stockValue += Number(para.value || 0);
      }
    } catch (error) {
      // paraphernalia_stock table/columns absent — skip paraphernalia.
      if (!hasPgCode(error, "42P01") && !hasPgCode(error, "42703")) throw error;
    }
  }

  summary.totalUnits =
    summary.availableUnits + summary.reservedUnits + summary.soldUnits;

  return summary;
}
