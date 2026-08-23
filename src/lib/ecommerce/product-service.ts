/**
 * Ecommerce product service — normalises Hostinger's envelope into CRM view
 * types. READ-ONLY: list and detail only.
 *
 * Hostinger is the source of truth. Nothing here is cached, mirrored, or written
 * to the CRM database, and there is no correlation with the CRM's separate
 * physical `products` / `product_master_*` system.
 */

import { getProductById, listProducts } from "@/lib/hostinger/products";
import type {
  HostingerPrice,
  HostingerProductRow,
  HostingerProductStatus,
  HostingerVariant,
} from "@/lib/hostinger/types";
import type {
  EcommercePrice,
  EcommercePriceRange,
  EcommerceProductDetail,
  EcommerceProductListResult,
  EcommerceProductSummary,
  EcommerceVariant,
} from "./types";

function toPrice(p: HostingerPrice | undefined): EcommercePrice | null {
  if (!p) return null;
  return {
    amountMinor: typeof p.amount === "number" ? p.amount : null,
    saleAmountMinor: typeof p.sale_amount === "number" ? p.sale_amount : null,
    currencyCode: p.currency_code ?? "",
  };
}

function toPriceRange(row: HostingerProductRow): EcommercePriceRange | null {
  const r = row.price_range;
  if (!r) return null;
  return {
    minMinor: typeof r.min === "number" ? r.min : null,
    maxMinor: typeof r.max === "number" ? r.max : null,
    currencyCode: r.currency_code ?? "",
  };
}

function toVariant(v: HostingerVariant): EcommerceVariant {
  const manageInventory = v.manage_inventory === true;
  return {
    id: v.id,
    title: v.title ?? "",
    sku: v.sku ?? null,
    // Only meaningful when managed. Reporting 0 for an unmanaged variant would
    // read as "out of stock" when it actually means "stock not tracked".
    inventoryQuantity:
      manageInventory && typeof v.inventory_quantity === "number" ? v.inventory_quantity : null,
    manageInventory,
    price: toPrice(v.prices?.[0]),
    options: Array.isArray(v.options) ? v.options : [],
  };
}

function summarise(row: HostingerProductRow): EcommerceProductSummary {
  // `variants` is null unless include[]=variants was requested; treat that as
  // "not loaded" rather than "no variants", so the counts below stay honest.
  const variants = (row.variants ?? []).map(toVariant);
  const managed = variants.filter((v) => v.manageInventory && v.inventoryQuantity !== null);

  return {
    id: row.id,
    title: row.title ?? "",
    status: row.status ?? null,
    type: row.type ?? null,
    thumbnail: row.thumbnail ?? null,
    variantCount: typeof row.variant_count === "number" ? row.variant_count : variants.length,
    sku: variants.length === 1 ? (variants[0].sku ?? null) : null,
    totalInventory: managed.length
      ? managed.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0)
      : null,
    priceRange: toPriceRange(row),
  };
}

export async function getEcommerceProductList(params: {
  page: number;
  q?: string;
  status?: HostingerProductStatus[];
}): Promise<EcommerceProductListResult> {
  const res = await listProducts(params);
  return {
    rows: res.data.map(summarise),
    total: res.meta.total,
    page: res.meta.current_page,
    perPage: res.meta.per_page,
  };
}

export async function getEcommerceProductDetail(
  productId: string,
): Promise<EcommerceProductDetail> {
  const row = await getProductById(productId);
  return {
    ...summarise(row),
    media: (row.media ?? []).map((m) => ({ url: m.url })),
    variants: (row.variants ?? []).map(toVariant),
  };
}
