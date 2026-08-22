/**
 * Hostinger product operations — READ-ONLY.
 *
 * One function per endpoint verified in Phase 1. Create/update/delete are not
 * implemented here; those phases are separately gated.
 */

import { hostingerGet } from "./client";
import type {
  HostingerProduct,
  HostingerProductListResponse,
  HostingerProductResponse,
} from "./types";

/**
 * The list endpoint accepted limit=100 during probing. Held at 100 rather than
 * assuming it is the ceiling — the store currently has 6 products, so the cap
 * has never actually been exercised.
 */
export const MAX_PAGE_SIZE = 100;

export async function listProducts(params: {
  limit: number;
  offset: number;
}): Promise<HostingerProductListResponse> {
  const res = await hostingerGet<HostingerProductListResponse>("/products", {
    limit: params.limit,
    offset: params.offset,
  });
  // Defensive: the envelope is the vendor's, so don't assume every key arrived.
  return {
    products: Array.isArray(res?.products) ? res.products : [],
    count: typeof res?.count === "number" ? res.count : 0,
    offset: typeof res?.offset === "number" ? res.offset : params.offset,
    limit: typeof res?.limit === "number" ? res.limit : params.limit,
  };
}

export async function getProduct(productId: string): Promise<HostingerProduct> {
  const res = await hostingerGet<HostingerProductResponse>(
    `/products/${encodeURIComponent(productId)}`,
  );
  if (!res?.product) {
    const err = new Error("Product not found in Hostinger") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return res.product;
}
