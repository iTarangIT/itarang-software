/**
 * Hostinger product operations (documented API v1).
 *
 * Reads: list + single-product lookup. Writes (Phase 5): create physical/digital,
 * partial product update, and variant price update. Delete is NOT here — it is
 * Phase 7.
 *
 * The documented write verbs are PATCH and DELETE; the server confirms this
 * itself, returning 405 "Supported methods: PATCH, DELETE." for any other verb
 * on a product. There is no PUT.
 */

import { hostingerDelete, hostingerGet, hostingerWrite } from "./client";
import type {
  HostingerCreateDigitalRequest,
  HostingerCreatePhysicalRequest,
  HostingerCreateResponse,
  HostingerProductListResponse,
  HostingerProductRow,
  HostingerProductStatus,
  HostingerUpdateProductRequest,
  HostingerVariant,
  HostingerVariantBatchRequest,
  HostingerVariantInventoryBatchRequest,
  HostingerVariantInventoryUpdate,
  HostingerVariantListResponse,
} from "./types";

/**
 * The API fixes the page size at 50 and exposes no `per_page` parameter, so this
 * is the server's value rather than a client preference. It is echoed back in
 * `meta.per_page`; callers should prefer that over this constant where available.
 */
export const PER_PAGE = 50;

/** Opt-in heavy data. Without these, `variants` and `media` come back null. */
const FULL_INCLUDE = ["variants", "media"] as const;

export async function listProducts(params: {
  page: number;
  q?: string;
  status?: HostingerProductStatus[];
  /** Omit the heavy payload for a leaner list where variants aren't needed. */
  includeDetail?: boolean;
}): Promise<HostingerProductListResponse> {
  const res = await hostingerGet<HostingerProductListResponse>("/products", {
    page: params.page,
    q: params.q,
    status: params.status,
    include: params.includeDetail === false ? undefined : [...FULL_INCLUDE],
  });

  // Defensive: the envelope is the vendor's, so don't assume every key arrived.
  return {
    data: Array.isArray(res?.data) ? res.data : [],
    meta: {
      current_page: res?.meta?.current_page ?? params.page,
      per_page: res?.meta?.per_page ?? PER_PAGE,
      total: res?.meta?.total ?? 0,
    },
  };
}

/**
 * There is no single-product GET — the API returns 405 for it. The documented
 * substitute is the `product_ids` filter, which the reference describes as
 * "doubles as a single-product lookup".
 */
export async function getProductById(productId: string): Promise<HostingerProductRow> {
  const res = await hostingerGet<HostingerProductListResponse>("/products", {
    page: 1,
    product_ids: [productId],
    include: [...FULL_INCLUDE],
  });

  const row = res?.data?.[0];
  if (!row) {
    const err = new Error("Product not found in Hostinger") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return row;
}

/* ---------------------------------------------------------------------------
 * Writes (Phase 5). Create + update only — no delete (Phase 7), no inventory
 * (Phase 6).
 * ------------------------------------------------------------------------- */

/** Both create endpoints produce a PUBLISHED product; there is no status field. */
export async function createPhysicalProduct(
  body: HostingerCreatePhysicalRequest,
): Promise<HostingerCreateResponse> {
  return hostingerWrite<HostingerCreateResponse>("POST", "/products/physical", body);
}

export async function createDigitalProduct(
  body: HostingerCreateDigitalRequest,
): Promise<HostingerCreateResponse> {
  return hostingerWrite<HostingerCreateResponse>("POST", "/products/digital", body);
}

/** Partial update. Omitted keys are left untouched. */
export async function updateProduct(
  productId: string,
  body: HostingerUpdateProductRequest,
): Promise<unknown> {
  return hostingerWrite("PATCH", `/products/${encodeURIComponent(productId)}`, body);
}

/**
 * Price only. The batch endpoint is partial (verified), so inventory fields are
 * deliberately NOT sent — including them would drag stock into a price edit and
 * reintroduce a lost-update race against concurrent purchases.
 */
export async function updateVariantPrice(
  productId: string,
  variantId: string,
  amountMinor: number,
  currency: string,
): Promise<unknown> {
  const body: HostingerVariantBatchRequest = {
    // sale_amount is omitted, not nulled — the API rejects a null.
    variants: [{ variant_id: variantId, prices: [{ amount: amountMinor, currency }] }],
  };
  return hostingerWrite(
    "PATCH",
    `/products/${encodeURIComponent(productId)}/variants/batch`,
    body,
  );
}

/** Variants for one product. Used for the pre-write stock re-read. */
export async function listVariants(productId: string): Promise<HostingerVariant[]> {
  const res = await hostingerGet<HostingerVariantListResponse>(
    `/products/${encodeURIComponent(productId)}/variants`,
  );
  return Array.isArray(res?.data) ? res.data : [];
}

/**
 * Inventory only. Absolute — `quantity` is the resulting stock, not a delta, and
 * the write is idempotent (verified: setting 7 twice leaves 7).
 *
 * `prices` is never sent: the batch endpoint replaces a variant's prices in full,
 * so including them would let a stock edit disturb pricing.
 *
 * Note: setting manage_inventory=false does NOT clear inventory_quantity — the
 * stored figure survives and is simply ignored, so it will be stale if tracking
 * is switched back on. Callers should treat an untracked variant's quantity as
 * meaningless rather than current.
 */
export async function updateVariantInventory(
  productId: string,
  variantId: string,
  fields: { quantity?: number; manageInventory?: boolean },
): Promise<unknown> {
  const variant: HostingerVariantInventoryUpdate = { variant_id: variantId };
  if (fields.quantity !== undefined) variant.inventory_quantity = fields.quantity;
  if (fields.manageInventory !== undefined) variant.manage_inventory = fields.manageInventory;

  const body: HostingerVariantInventoryBatchRequest = { variants: [variant] };
  return hostingerWrite(
    "PATCH",
    `/products/${encodeURIComponent(productId)}/variants/batch`,
    body,
  );
}

/**
 * Permanent removal. Irreversible from the CRM: afterwards the product is absent
 * from every endpoint available to us, and there is no way to list deleted
 * products, so absence is the only confirmation obtainable.
 *
 * One documented exception — "a subscription product with active subscribers is
 * archived instead of deleted so its data stays available" — means a 200 here
 * does NOT prove the product is gone. Callers must read back rather than assume.
 */
export async function deleteProduct(productId: string): Promise<void> {
  await hostingerDelete(`/products/${encodeURIComponent(productId)}`);
}
