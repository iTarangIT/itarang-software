import { db } from "@/lib/db";
import { inventory, paraphernaliaStock, products, productCategories } from "@/lib/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import {
  canonicalizeAssetCategory,
  vehicleClassFromSlug,
} from "@/lib/inventory/vehicle-class";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/**
 * Classify an inventory row into one of the three asset kinds. `inventory_type`
 * is the only reliable paraphernalia signal (`paraphernalia_lot`); battery /
 * charger come from the `asset_type` column. Returns null for anything
 * unrecognised so the caller can decide how to treat it.
 */
function classifyAssetKind(
  inventoryType: string | null,
  assetType: string | null,
): "battery" | "charger" | "paraphernalia" | null {
  if (inventoryType === "paraphernalia_lot") return "paraphernalia";
  const at = (assetType || "").toLowerCase();
  if (at === "battery") return "battery";
  if (at === "charger") return "charger";
  return null;
}

type SerialRow = {
  id: string;
  serial_number: string | null;
  warehouse_location: string | null;
  unit_price: number;
};

type ProductOption = {
  id: string;
  name: string;
  slug: string;
  sku: string;
  hsn_code: string | null;
  asset_type: string;
  voltage_v: number | null;
  capacity_ah: number | null;
  warranty_months: number | null;
  is_serialized: boolean;
  sort_order: number | null;
  status: string;
  category_id: string | null;
  asset_category: string;
  category_slug: string;
  available_quantity: number;
  serials: SerialRow[];
};

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["dealer"]);
  const dealerId = user.dealer_id;
  if (!dealerId) {
    return errorResponse("No dealer account is linked to this user.", 403);
  }

  const { searchParams } = new URL(req.url);
  const categoryParam = (searchParams.get("category") || "").trim().toLowerCase();
  if (!categoryParam) return errorResponse("category is required", 400);

  // Optional asset-kind filter (battery | charger | paraphernalia). When absent
  // or unrecognised the endpoint returns every kind in the category (back-compat).
  const assetTypeParam = (searchParams.get("assetType") || "")
    .trim()
    .toLowerCase();
  const assetType =
    assetTypeParam === "battery" ||
    assetTypeParam === "charger" ||
    assetTypeParam === "paraphernalia"
      ? assetTypeParam
      : null;

  const canonicalClass = vehicleClassFromSlug(categoryParam);
  if (!canonicalClass) return successResponse([]);

  // Step 1: pull the dealer's available inventory rows in this vehicle class.
  // Inventory rows may or may not link to the legacy `products` table — newer
  // rows often skip `product_id` entirely. We resolve to a real `products.id`
  // (UUID) below via either `inventory.product_id` or a SKU fallback so the
  // PATCH that writes lead.primary_product_id (uuid column) never receives a
  // SKU literal — that's what was producing the "Something went wrong"
  // toast on Step 4.
  const allInvRows = await db
    .select({
      id: inventory.id,
      serial_number: inventory.serial_number,
      asset_type: inventory.asset_type,
      asset_category: inventory.asset_category,
      inventory_type: inventory.inventory_type,
      model_type: inventory.model_type,
      voltage_v: inventory.voltage_v,
      capacity_ah: inventory.capacity_ah,
      warehouse_location: inventory.warehouse_location,
      final_amount: inventory.final_amount,
      product_id: inventory.product_id,
    })
    .from(inventory)
    .where(
      and(
        eq(inventory.dealer_id, dealerId),
        eq(inventory.status, "available"),
      ),
    )
    .orderBy(inventory.model_type, inventory.serial_number);

  // Bucket each row into a vehicle class the same way the lead "categories"
  // endpoint does (canonicalizeAssetCategory), instead of a brittle
  // `asset_category ILIKE '3W%'`. The ILIKE prefix silently dropped messy
  // values like "3 Wheeler" / "3-Wheeler", which hid whole paraphernalia
  // lots from the Product-type list and made it disagree with the
  // "N in stock" total.
  const invRows = allInvRows.filter(
    (r) =>
      canonicalizeAssetCategory(r.asset_category) === canonicalClass &&
      (assetType === null ||
        classifyAssetKind(r.inventory_type, r.asset_type) === assetType),
  );

  if (invRows.length === 0) return successResponse([]);

  // Live paraphernalia ledger for this dealer. Paraphernalia availability is
  // tracked here as a quantity per item_type — the `paraphernalia_lot` rows in
  // `inventory` are invoice receipts and must NOT be counted one-per-row.
  const paraStockRows = await db
    .select({
      item_type: paraphernaliaStock.item_type,
      available_qty: paraphernaliaStock.available_qty,
    })
    .from(paraphernaliaStock)
    .where(eq(paraphernaliaStock.dealer_id, dealerId));
  const paraStockByType = new Map<string, number>();
  for (const r of paraStockRows) paraStockByType.set(r.item_type, r.available_qty);

  // Step 2: collect product_ids and skus seen in inventory; load matching
  // products in one round-trip and index by both id and sku.
  const seenProductIds = new Set<string>();
  const seenSkus = new Set<string>();
  for (const r of invRows) {
    if (r.product_id) seenProductIds.add(r.product_id);
    if (r.model_type) seenSkus.add(r.model_type);
  }

  const productLookups = await Promise.all([
    seenProductIds.size > 0
      ? db
          .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            sku: products.sku,
            hsn_code: products.hsn_code,
            warranty_months: products.warranty_months,
            is_serialized: products.is_serialized,
            sort_order: products.sort_order,
            status: products.status,
            category_id: products.category_id,
            asset_category: productCategories.name,
            category_slug: productCategories.slug,
          })
          .from(products)
          .leftJoin(productCategories, eq(products.category_id, productCategories.id))
          .where(inArray(products.id, Array.from(seenProductIds)))
      : Promise.resolve([]),
    seenSkus.size > 0
      ? db
          .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            sku: products.sku,
            hsn_code: products.hsn_code,
            warranty_months: products.warranty_months,
            is_serialized: products.is_serialized,
            sort_order: products.sort_order,
            status: products.status,
            category_id: products.category_id,
            asset_category: productCategories.name,
            category_slug: productCategories.slug,
          })
          .from(products)
          .leftJoin(productCategories, eq(products.category_id, productCategories.id))
          .where(inArray(products.sku, Array.from(seenSkus)))
      : Promise.resolve([]),
  ]);

  type ProductRow = (typeof productLookups)[0][number];
  const byId = new Map<string, ProductRow>();
  const bySku = new Map<string, ProductRow>();
  for (const p of productLookups[0]) byId.set(p.id, p);
  for (const p of productLookups[1]) if (p.sku) bySku.set(p.sku, p);

  // Step 3a: any inventory model_type that didn't resolve via id or sku gets a
  // stub products row auto-upserted, then we backfill inventory.product_id so
  // tile fetches that filter on product_id work afterward. The legacy
  // `products` table is sparsely populated on this app — newer inventory uses
  // Product Master tables and skips the FK — so a bridge is needed for the
  // lead workflow which still stores leads.primary_product_id (uuid).
  const unresolvedSkus = new Set<string>();
  for (const r of invRows) {
    if (!r.model_type) continue;
    const hasIdMatch = r.product_id ? byId.has(r.product_id) : false;
    const hasSkuMatch = bySku.has(r.model_type);
    if (!hasIdMatch && !hasSkuMatch) unresolvedSkus.add(r.model_type);
  }

  if (unresolvedSkus.size > 0) {
    // Resolve the canonical productCategory UUID once for the new rows.
    const [canonicalCategoryRow] = await db
      .select({ id: productCategories.id, slug: productCategories.slug, name: productCategories.name })
      .from(productCategories)
      .where(
        and(
          eq(productCategories.is_active, true),
          eq(productCategories.slug, categoryParam),
        ),
      )
      .limit(1);

    if (canonicalCategoryRow) {
      const firstInvBySku = new Map<string, (typeof invRows)[number]>();
      for (const r of invRows) {
        if (r.model_type && !firstInvBySku.has(r.model_type)) {
          firstInvBySku.set(r.model_type, r);
        }
      }

      await db.transaction(async (tx) => {
        for (const sku of unresolvedSkus) {
          const inv = firstInvBySku.get(sku);
          if (!inv) continue;

          const voltageInt = Math.round(Number(inv.voltage_v) || 0);
          const capacityInt = Math.round(Number(inv.capacity_ah) || 0);

          let [inserted] = await tx
            .insert(products)
            .values({
              category_id: canonicalCategoryRow.id,
              name: sku,
              slug: slugify(sku) || sku,
              sku,
              voltage_v: voltageInt,
              capacity_ah: capacityInt,
              asset_type: inv.asset_type ?? null,
              is_active: true,
              is_serialized: true,
              warranty_months: 0,
              status: "active",
            })
            // The (category_id, voltage_v, capacity_ah) unique constraint can
            // already be held by a different SKU — e.g. two paraphernalia items
            // both at 0V/0Ah. Skip on conflict instead of aborting the whole
            // transaction (that 23505 was 500-ing the route → empty dropdown).
            .onConflictDoNothing({
              target: [
                products.category_id,
                products.voltage_v,
                products.capacity_ah,
              ],
            })
            .returning({
              id: products.id,
              name: products.name,
              slug: products.slug,
              sku: products.sku,
              hsn_code: products.hsn_code,
              warranty_months: products.warranty_months,
              is_serialized: products.is_serialized,
              sort_order: products.sort_order,
              status: products.status,
              category_id: products.category_id,
            });

          // Conflict skipped the insert — reuse the row already occupying that
          // (category, voltage, capacity) slot so the SKU still resolves.
          if (!inserted) {
            [inserted] = await tx
              .select({
                id: products.id,
                name: products.name,
                slug: products.slug,
                sku: products.sku,
                hsn_code: products.hsn_code,
                warranty_months: products.warranty_months,
                is_serialized: products.is_serialized,
                sort_order: products.sort_order,
                status: products.status,
                category_id: products.category_id,
              })
              .from(products)
              .where(
                and(
                  eq(products.category_id, canonicalCategoryRow.id),
                  eq(products.voltage_v, voltageInt),
                  eq(products.capacity_ah, capacityInt),
                ),
              )
              .limit(1);
          }

          if (!inserted) continue;

          // Backfill the dealer's inventory rows with the new product_id so
          // downstream tile / serial endpoints can filter on the FK.
          await tx
            .update(inventory)
            .set({ product_id: inserted.id, updated_at: new Date() })
            .where(
              and(
                eq(inventory.dealer_id, dealerId),
                eq(inventory.model_type, sku),
                isNull(inventory.product_id),
              ),
            );

          // Index the new row so the grouping pass below picks it up.
          const enriched: ProductRow = {
            ...inserted,
            asset_category: canonicalCategoryRow.name,
            category_slug: canonicalCategoryRow.slug,
          };
          bySku.set(sku, enriched);
          byId.set(inserted.id, enriched);
        }
      });
    } else {
      console.warn(
        "[dealer/leads/products] no productCategories row matches slug",
        categoryParam,
        "— skipping auto-upsert for SKUs:",
        Array.from(unresolvedSkus),
      );
    }
  }

  // Step 3b: group inventory rows by their resolved product UUID.
  const grouped = new Map<string, ProductOption>();
  // paraphernalia item_type -> the product UUID its lot rows resolve to (first
  // match wins). Keyed by item_type, NOT by product id: several item_types can
  // collapse onto one `products` row, and each item_type's ledger quantity must
  // still be counted exactly once. Availability comes from paraphernalia_stock,
  // never from counting `paraphernalia_lot` rows one-per-row.
  const productIdByItemType = new Map<string, string>();

  for (const r of invRows) {
    const product =
      (r.product_id && byId.get(r.product_id)) ||
      (r.model_type && bySku.get(r.model_type)) ||
      null;

    if (!product) continue; // should not happen after auto-upsert

    let entry = grouped.get(product.id);
    if (!entry) {
      entry = {
        id: product.id,
        name: product.name,
        slug: product.slug ?? product.id,
        sku: product.sku ?? r.model_type ?? "",
        hsn_code: product.hsn_code ?? null,
        asset_type: r.asset_type ?? "",
        voltage_v: r.voltage_v != null ? Number(r.voltage_v) : null,
        capacity_ah: r.capacity_ah != null ? Number(r.capacity_ah) : null,
        warranty_months: product.warranty_months ?? null,
        is_serialized: product.is_serialized ?? true,
        sort_order: product.sort_order ?? null,
        status: product.status ?? "active",
        category_id: product.category_id ?? null,
        asset_category: product.asset_category ?? canonicalClass,
        category_slug: product.category_slug ?? categoryParam,
        available_quantity: 0,
        serials: [],
      };
      grouped.set(product.id, entry);
    }

    // Paraphernalia: defer the count to the paraphernalia_stock ledger (below).
    // A `paraphernalia_lot` row is an invoice receipt, not one sellable unit.
    if (r.inventory_type === "paraphernalia_lot") {
      const itemType = r.asset_type ?? "";
      if (itemType && !productIdByItemType.has(itemType)) {
        productIdByItemType.set(itemType, product.id);
      }
      continue;
    }

    entry.available_quantity += 1;
    entry.serials.push({
      id: r.id,
      serial_number: r.serial_number,
      warehouse_location: r.warehouse_location,
      unit_price: r.final_amount != null ? Number(r.final_amount) : 0,
    });
  }

  // Set paraphernalia availability from the live ledger. Each item_type's
  // quantity is added exactly once, to the product its lot rows resolve to —
  // so when several item_types collapse onto one `products` row their
  // quantities sum (instead of a last-write-wins map dropping all but one).
  // Paraphernalia is qty-tracked, not serialized — it carries no serials here.
  for (const [itemType, productId] of productIdByItemType) {
    const entry = grouped.get(productId);
    if (!entry) continue;
    entry.available_quantity += paraStockByType.get(itemType) ?? 0;
    entry.serials = [];
  }

  const result = Array.from(grouped.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return successResponse(result);
});
