import { db } from "@/lib/db";
import { inventory, paraphernaliaStock, productCategories } from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import {
  CANONICAL_VEHICLE_CLASSES,
  canonicalizeAssetCategory,
} from "@/lib/inventory/vehicle-class";

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["dealer"]);
  const dealerId = user.dealer_id;
  if (!dealerId) {
    return errorResponse("No dealer account is linked to this user.", 403);
  }

  // Optional asset-kind filter (battery | charger | paraphernalia). When absent
  // or unrecognised the endpoint behaves exactly as before (counts every kind).
  const assetTypeParam = (new URL(req.url).searchParams.get("assetType") || "")
    .trim()
    .toLowerCase();
  const assetType =
    assetTypeParam === "battery" ||
    assetTypeParam === "charger" ||
    assetTypeParam === "paraphernalia"
      ? assetTypeParam
      : null;

  // Serialized stock (battery / charger) — one unit per available inventory
  // row. `paraphernalia_lot` rows are invoice receipts and are excluded here;
  // their real quantity comes from the paraphernalia_stock ledger below.
  // Skipped entirely when the caller asked for paraphernalia only.
  const serializedRows =
    assetType === "paraphernalia"
      ? []
      : await db
          .select({
            asset_category: inventory.asset_category,
            available_count: sql<number>`count(*)::int`,
          })
          .from(inventory)
          .where(
            and(
              eq(inventory.dealer_id, dealerId),
              eq(inventory.status, "available"),
              sql`${inventory.inventory_type} is distinct from 'paraphernalia_lot'`,
              assetType === "battery" || assetType === "charger"
                ? sql`lower(${inventory.asset_type}) = ${assetType}`
                : undefined,
            ),
          )
          .groupBy(inventory.asset_category);

  // Paraphernalia lot rows — distinct (vehicle class, item_type) pairs that
  // have available stock. A lot row's asset_type is the paraphernalia
  // item_type; its asset_category attributes it to a vehicle class.
  // Skipped when the caller asked for battery/charger only.
  const skipParaphernalia = assetType === "battery" || assetType === "charger";
  const paraLotRows = skipParaphernalia
    ? []
    : await db
        .selectDistinct({
          asset_category: inventory.asset_category,
          item_type: inventory.asset_type,
        })
        .from(inventory)
        .where(
          and(
            eq(inventory.dealer_id, dealerId),
            eq(inventory.status, "available"),
            eq(inventory.inventory_type, "paraphernalia_lot"),
          ),
        );

  // Live paraphernalia ledger — the real available quantity per item_type.
  const paraStockRows = skipParaphernalia
    ? []
    : await db
        .select({
          item_type: paraphernaliaStock.item_type,
          available_qty: paraphernaliaStock.available_qty,
        })
        .from(paraphernaliaStock)
        .where(eq(paraphernaliaStock.dealer_id, dealerId));
  const paraStockByType = new Map<string, number>();
  for (const r of paraStockRows) paraStockByType.set(r.item_type, r.available_qty);

  const totals = new Map<string, number>();
  for (const r of serializedRows) {
    const canonical = canonicalizeAssetCategory(r.asset_category);
    if (!canonical) continue;
    totals.set(canonical, (totals.get(canonical) ?? 0) + r.available_count);
  }
  // Add each paraphernalia item's ledger quantity once per vehicle class.
  const countedPara = new Set<string>();
  for (const r of paraLotRows) {
    const canonical = canonicalizeAssetCategory(r.asset_category);
    if (!canonical || !r.item_type) continue;
    const key = `${canonical}|${r.item_type}`;
    if (countedPara.has(key)) continue;
    countedPara.add(key);
    totals.set(
      canonical,
      (totals.get(canonical) ?? 0) + (paraStockByType.get(r.item_type) ?? 0),
    );
  }

  const activeSlugs = CANONICAL_VEHICLE_CLASSES
    .filter((c) => (totals.get(c.class) ?? 0) > 0)
    .map((c) => c.slug);

  if (activeSlugs.length === 0) {
    return successResponse([]);
  }

  // Resolve each canonical slug to its productCategories UUID so leads store a
  // real FK in product_category_id (the lead column expects a UUID, not a slug).
  const categoryRows = await db
    .select({
      id: productCategories.id,
      slug: productCategories.slug,
    })
    .from(productCategories)
    .where(
      and(
        eq(productCategories.is_active, true),
        inArray(productCategories.slug, activeSlugs),
      ),
    );

  const idBySlug = new Map<string, string>();
  for (const row of categoryRows) idBySlug.set(row.slug, row.id);

  const result = CANONICAL_VEHICLE_CLASSES
    .filter((c) => (totals.get(c.class) ?? 0) > 0 && idBySlug.has(c.slug))
    .map((c) => ({
      id: idBySlug.get(c.slug) as string,
      name: c.class,
      slug: c.slug,
      isVehicleCategory: true,
      available_count: totals.get(c.class) ?? 0,
    }));

  return successResponse(result);
});
