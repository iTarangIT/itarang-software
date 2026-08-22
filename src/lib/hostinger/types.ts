/**
 * Hostinger Ecommerce API — vendor response types.
 *
 * Shapes verified 2026-08-23 against the live store by read-only GET probes
 * (see the Phase 1 endpoint map in the implementation plan). Kept isolated in
 * this file so the vendor envelope never leaks into CRM domain types — callers
 * consume the normalised types in `src/lib/ecommerce/types.ts` instead.
 *
 * Fields are typed optional where the probe saw them null on at least one row,
 * so a missing value is a render decision rather than a crash.
 */

export interface HostingerCurrency {
  code: string;
  symbol: string;
  symbol_native?: string;
  name?: string;
  decimal_digits: number;
  min_amount?: number;
  max_amount?: number;
  is_enabled?: boolean;
}

export interface HostingerPrice {
  id: string;
  currency_code: string;
  currency: HostingerCurrency;
  /**
   * SCALE UNVERIFIED. The probe saw `amount: 100` on a variant whose currency
   * declares `decimal_digits: 2` and `min_amount: 5000`, which reads as minor
   * units (paise) but lands below the store's own stated minimum. Treated as
   * minor units throughout, and the raw value is surfaced in the UI so nobody
   * has to trust that inference. Must be settled before any write path.
   */
  amount: number | null;
  sale_amount: number | null;
  region_id: string | null;
}

export interface HostingerVariant {
  id: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  title: string;
  image_url: string | null;
  product_id?: string;
  prices?: HostingerPrice[];
  sku: string | null;
  external_id?: string | null;
  /** Stock lives here, not on the product. Meaningful only when manage_inventory. */
  inventory_quantity?: number | null;
  allow_backorder?: boolean;
  manage_inventory?: boolean;
  weight?: number | null;
  is_active?: boolean;
  track_low_stock?: boolean;
  low_stock_threshold?: number | null;
  is_available?: boolean;
}

export interface HostingerMedia {
  id: string;
  url: string;
  type: string;
  order?: number;
  display_slot?: string;
}

export interface HostingerProduct {
  id: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  /** The vendor field is `title` — there is no `name`. */
  title: string;
  subtitle?: string | null;
  description?: string | null; // HTML
  store_id?: string;
  status?: string; // e.g. "published"
  media?: HostingerMedia[];
  thumbnail?: string | null;
  slug?: string | null;
  url_handle?: string | null;
  variants?: HostingerVariant[];
  options?: unknown[];
  product_collections?: unknown[];
  type?: { id?: string; value?: string } | null; // { value: "physical" }
  purchasable?: boolean;
  is_available?: boolean;
  order?: number;
}

/** GET /store/{storeId}/products */
export interface HostingerProductListResponse {
  products: HostingerProduct[];
  count: number;
  offset: number;
  limit: number;
}

/** GET /store/{storeId}/products/{productId} */
export interface HostingerProductResponse {
  product: HostingerProduct;
}
