import { db } from "@/lib/db";
import { inventory, products, productCategories } from "@/lib/db/schema";
import { and, eq, ilike, inArray, isNull } from "drizzle-orm";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

// Map slug → canonical asset_category prefix used for ILIKE matching.
const SLUG_TO_CLASS: Record<string, string> = {
  "2w": "2W",
  "3w": "3W",
  "4w": "4W",
};

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

  const canonicalClass = SLUG_TO_CLASS[categoryParam];
  if (!canonicalClass) return successResponse([]);

  // Step 1: pull the dealer's available inventory rows in this vehicle class.
  // Inventory rows may or may not link to the legacy `products` table — newer
  // rows often skip `product_id` entirely. We resolve to a real `products.id`
  // (UUID) below via either `inventory.product_id` or a SKU fallback so the
  // PATCH that writes lead.primary_product_id (uuid column) never receives a
  // SKU literal — that's what was producing the "Something went wrong"
  // toast on Step 4.
  const invRows = await db
    .select({
      id: inventory.id,
      serial_number: inventory.serial_number,
      asset_type: inventory.asset_type,
      asset_category: inventory.asset_category,
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
        ilike(inventory.asset_category, `${canonicalClass}%`),
      ),
    )
    .orderBy(inventory.model_type, inventory.serial_number);

  if (invRows.length === 0) return successResponse([]);

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

          const [inserted] = await tx
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

    entry.available_quantity += 1;
    entry.serials.push({
      id: r.id,
      serial_number: r.serial_number,
      warehouse_location: r.warehouse_location,
      unit_price: r.final_amount != null ? Number(r.final_amount) : 0,
    });
  }

  const result = Array.from(grouped.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return successResponse(result);
});
