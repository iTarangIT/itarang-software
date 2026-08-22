/**
 * Ecommerce product service — normalises Hostinger's envelope into CRM view
 * types. READ-ONLY: list and detail only.
 *
 * Hostinger is the source of truth. Nothing here is cached, mirrored, or
 * written to the CRM database, and there is no correlation with the CRM's
 * separate physical `products` / `product_master_*` system.
 */

import { getProduct, listProducts } from "@/lib/hostinger/products";
import type { HostingerPrice, HostingerProduct, HostingerVariant } from "@/lib/hostinger/types";
import type {
  EcommercePrice,
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
    currencyCode: p.currency_code ?? p.currency?.code ?? "",
    currencySymbol: p.currency?.symbol ?? "",
    // Default to 2 rather than 0: guessing 0 would render paise as rupees and
    // overstate every price by 100x, which is the worse failure direction.
    decimalDigits: typeof p.currency?.decimal_digits === "number" ? p.currency.decimal_digits : 2,
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
    allowBackorder: v.allow_backorder === true,
    trackLowStock: v.track_low_stock === true,
    lowStockThreshold: typeof v.low_stock_threshold === "number" ? v.low_stock_threshold : null,
    isActive: v.is_active !== false,
    price: toPrice(v.prices?.[0]),
    imageUrl: v.image_url ?? null,
  };
}

function summarise(p: HostingerProduct): EcommerceProductSummary {
  const variants = (p.variants ?? []).map(toVariant);
  const managed = variants.filter((v) => v.manageInventory && v.inventoryQuantity !== null);

  return {
    id: p.id,
    title: p.title ?? "",
    subtitle: p.subtitle ?? null,
    status: p.status ?? null,
    type: p.type?.value ?? null,
    thumbnail: p.thumbnail ?? null,
    slug: p.slug ?? p.url_handle ?? null,
    variantCount: variants.length,
    sku: variants.length === 1 ? (variants[0].sku ?? null) : null,
    totalInventory: managed.length
      ? managed.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0)
      : null,
    anyBackorder: variants.some((v) => v.allowBackorder),
    price: variants[0]?.price ?? null,
    updatedAt: p.updated_at ?? null,
  };
}

export async function getEcommerceProductList(params: {
  limit: number;
  offset: number;
}): Promise<EcommerceProductListResult> {
  const res = await listProducts(params);
  return {
    rows: res.products.map(summarise),
    total: res.count,
    offset: res.offset,
    limit: res.limit,
  };
}

export async function getEcommerceProductDetail(
  productId: string,
): Promise<EcommerceProductDetail> {
  const p = await getProduct(productId);
  return {
    ...summarise(p),
    descriptionHtml: p.description ?? null,
    media: (p.media ?? []).map((m) => ({ id: m.id, url: m.url })),
    variants: (p.variants ?? []).map(toVariant),
    createdAt: p.created_at ?? null,
    purchasable: p.purchasable !== false,
    urlHandle: p.url_handle ?? null,
  };
}
