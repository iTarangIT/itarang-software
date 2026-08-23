/**
 * Hostinger product operations — READ-ONLY (documented API v1).
 *
 * Create/update/delete are not implemented here; those phases are separately
 * gated. The documented write verbs are PATCH and DELETE — the server confirms
 * this itself, returning 405 "Supported methods: PATCH, DELETE." for any other
 * verb on a product. There is no PUT.
 */

import { hostingerGet } from "./client";
import type {
  HostingerProductListResponse,
  HostingerProductRow,
  HostingerProductStatus,
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
