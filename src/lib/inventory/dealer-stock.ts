/**
 * A dealer's selectable stock — the query behind the Step-5 product picker.
 *
 * WHY THIS EXISTS. `GET /api/inventory/dealer/[dealerId]/{batteries,chargers}`
 * were the only readers, and everything below their auth check is
 * channel-agnostic. The customer now picks a battery inside their WhatsApp chat,
 * where there is no Supabase session for `requireAuth()`. Same split as
 * `submit-step4.ts`: the route decides *who may look*, this decides *what stock
 * there is*.
 *
 * THE PARTS THAT LOOK LIKE DETAIL AND ARE NOT:
 *
 *  - **Oldest first.** `oem_invoice_date ASC` is the BRD ageing rule, and the
 *    first row is flagged `recommended`. Sorting any other way quietly ages the
 *    dealer's stock.
 *  - **`includeSerials`.** Without it a lead whose battery is already reserved
 *    renders an EMPTY picker and silently loses the existing choice — which is
 *    what every lead submitted before the Step-4/Step-5 split looks like, since
 *    Step 4 used to reserve on submit.
 *  - **Chargers are NOT voltage-filtered.** A strict `products.voltage_v` match
 *    was tried and returned zero chargers in practice: real inventories label
 *    battery and charger voltages on different conventions (a 51V LFP pack pairs
 *    with a 58.4V charger). `batteryVoltage` is accepted and deliberately
 *    ignored until a real compatibility table exists.
 */

import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, products, productCategories } from "@/lib/db/schema";

/** Ageing thresholds, in days (BRD §3842). */
const AGEING_DAYS = 90;
const OLD_DAYS = 180;

export interface DealerStockItem {
  id: string;
  serial_number: string;
  model_name: string | null;
  model_type: string | null;
  product_id: string | null;
  asset_category: string | null;
  invoice_date: Date | string | null;
  status: string | null;
  price: string | null;
  warranty_months: number | null;
  /** GST snapshot, captured per inventory row at OEM upload. */
  gross_amount: string | null;
  gst_percent: string | null;
  gst_amount: string | null;
  net_amount: string | null;
  inventory_age_days: number;
  age_badge: "fresh" | "ageing" | "old";
  /** The oldest unit — what the dealer should sell next. */
  recommended: boolean;
}

export interface DealerBattery extends DealerStockItem {
  soc_percent: string | null;
  soc_last_sync_at: Date | string | null;
  voltage_v: string | null;
  capacity_ah: string | null;
}

export interface StockQuery {
  dealerId: string;
  /** Category id or name — `inventory.asset_category` stores the NAME. */
  category?: string | null;
  /** Serials to show whatever their status (see the header). */
  includeSerials?: string[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `inventory.asset_category` stores the `productCategories.name` (set at
 * bulk-upload time). Callers may pass either the id or the name — resolve to the
 * name so both work.
 *
 * THE UUID GUARD IS LOAD-BEARING, not defensive tidying. `product_categories.id`
 * is a uuid column, so querying it with a NAME does not return zero rows — it
 * throws `invalid input syntax for type uuid` and takes the whole call down.
 * The web picker never hit this because the Step-5 page always passes the lead's
 * `product_category_id` (a uuid); the WhatsApp picker reads
 * `product_selections.category`, which holds the NAME once anything has written
 * a selection. So the same input the doc comment above always promised to accept
 * was a guaranteed 500.
 */
async function resolveCategoryName(input: string): Promise<string> {
  if (!UUID_RE.test(input)) return input;
  const [cat] = await db
    .select({ name: productCategories.name })
    .from(productCategories)
    .where(eq(productCategories.id, input))
    .limit(1);
  return cat?.name ?? input;
}

async function baseFilters(
  q: StockQuery,
  assetTypes: [string, string],
): Promise<ReturnType<typeof and>[]> {
  const serials = (q.includeSerials ?? []).filter(Boolean);
  const filters = [
    eq(inventory.dealer_id, q.dealerId),
    or(eq(inventory.asset_type, assetTypes[0]), eq(inventory.asset_type, assetTypes[1]))!,
    serials.length > 0
      ? or(
          eq(inventory.status, "available"),
          inArray(inventory.serial_number, serials),
        )!
      : eq(inventory.status, "available"),
  ];
  if (q.category) {
    const categoryName = await resolveCategoryName(q.category);
    // Prefix match so a canonical "3W" also picks up rows tagged
    // "3W Batteries", "3W Vehicles", etc.
    filters.push(ilike(inventory.asset_category, `${categoryName}%`));
  }
  return filters as ReturnType<typeof and>[];
}

function enrich<T extends { invoice_date: Date | string | null }>(
  rows: T[],
): Array<T & { inventory_age_days: number; age_badge: "fresh" | "ageing" | "old"; recommended: boolean }> {
  const today = Date.now();
  return rows.map((r, idx) => {
    const ageMs = r.invoice_date ? today - new Date(r.invoice_date).getTime() : 0;
    const ageDays = Math.max(0, Math.floor(ageMs / (1000 * 60 * 60 * 24)));
    const badge: "fresh" | "ageing" | "old" =
      ageDays > OLD_DAYS ? "old" : ageDays > AGEING_DAYS ? "ageing" : "fresh";
    // Rows are already sorted oldest-first, so index 0 is the recommendation.
    return { ...r, inventory_age_days: ageDays, age_badge: badge, recommended: idx === 0 };
  });
}

/** Every battery this dealer can sell right now, oldest stock first. */
export async function listDealerBatteries(
  q: StockQuery & { subCategory?: string | null },
): Promise<DealerBattery[]> {
  const filters = await baseFilters(q, ["Battery", "battery"]);
  // Step 5 is where the battery is actually chosen, so every available battery
  // in the category is listed. It must NOT be narrowed to the lead's
  // primary_product_id: that "Product Type" can be a charger or paraphernalia,
  // which would zero the list.
  if (q.subCategory) filters.push(eq(inventory.model_type, q.subCategory));

  const rows = await db
    .select({
      id: inventory.id,
      serial_number: inventory.serial_number,
      model_name: products.name,
      model_type: inventory.model_type,
      product_id: inventory.product_id,
      asset_category: inventory.asset_category,
      invoice_date: inventory.oem_invoice_date,
      soc_percent: inventory.soc_percent,
      soc_last_sync_at: inventory.soc_last_sync_at,
      status: inventory.status,
      price: products.price,
      voltage_v: products.voltage_v,
      capacity_ah: products.capacity_ah,
      warranty_months: products.warranty_months,
      gross_amount: inventory.inventory_amount,
      gst_percent: inventory.gst_percent,
      gst_amount: inventory.gst_amount,
      net_amount: sql<string | null>`COALESCE(${inventory.price_inclusive_gst}, ${inventory.final_amount})`,
    })
    .from(inventory)
    .leftJoin(products, eq(inventory.product_id, products.id))
    .where(and(...filters))
    .orderBy(asc(inventory.oem_invoice_date));

  return enrich(rows) as DealerBattery[];
}

/**
 * Every charger this dealer can sell right now, oldest stock first.
 *
 * `batteryVoltage` is accepted for forwards compatibility and ignored — see the
 * file header for why a strict voltage match strands dealers.
 */
export async function listDealerChargers(
  q: StockQuery & { batteryVoltage?: string | number | null },
): Promise<DealerStockItem[]> {
  const filters = await baseFilters(q, ["Charger", "charger"]);

  const rows = await db
    .select({
      id: inventory.id,
      serial_number: inventory.serial_number,
      model_name: products.name,
      model_type: inventory.model_type,
      product_id: inventory.product_id,
      asset_category: inventory.asset_category,
      invoice_date: inventory.oem_invoice_date,
      status: inventory.status,
      price: products.price,
      warranty_months: products.warranty_months,
      gross_amount: inventory.inventory_amount,
      gst_percent: inventory.gst_percent,
      gst_amount: inventory.gst_amount,
      net_amount: sql<string | null>`COALESCE(${inventory.price_inclusive_gst}, ${inventory.final_amount})`,
    })
    .from(inventory)
    .leftJoin(products, eq(inventory.product_id, products.id))
    .where(and(...filters))
    .orderBy(asc(inventory.oem_invoice_date));

  return enrich(rows) as DealerStockItem[];
}
