/**
 * Hostinger Ecommerce API — vendor response types (documented API v1).
 *
 * Shapes taken from the official reference at developers.hostinger.com and
 * verified against the live store. The list endpoint returns deliberately lean
 * summaries; `variants` and `media` are null unless requested via `include[]`.
 *
 * Kept isolated here so the vendor envelope never leaks into CRM domain types —
 * callers consume `src/lib/ecommerce/types.ts` instead.
 */

/** Amounts are integers in the smallest currency unit (paise for INR). */
export interface HostingerPrice {
  amount: number | null;
  sale_amount: number | null;
  currency_code: string;
}

export interface HostingerPriceRange {
  min: number | null;
  max: number | null;
  currency_code: string;
}

export interface HostingerVariantOption {
  name: string;
  value: string;
}

export interface HostingerVariant {
  id: string;
  title: string;
  sku: string | null;
  options?: HostingerVariantOption[];
  prices?: HostingerPrice[];
  /** Meaningful only when manage_inventory is true. */
  inventory_quantity?: number | null;
  manage_inventory?: boolean;
}

export interface HostingerMedia {
  url: string;
  type: string;
  is_thumbnail?: boolean;
}

/** A row from GET /stores/{store_id}/products. */
export interface HostingerProductRow {
  id: string;
  title: string;
  status: string | null;
  thumbnail: string | null;
  /** "physical" | "digital" */
  type: string | null;
  variant_count: number;
  price_range: HostingerPriceRange | null;
  /** null unless include[]=variants */
  variants: HostingerVariant[] | null;
  /** null unless include[]=media */
  media: HostingerMedia[] | null;
}

export interface HostingerListMeta {
  current_page: number;
  per_page: number;
  total: number;
}

export interface HostingerProductListResponse {
  data: HostingerProductRow[];
  meta: HostingerListMeta;
}

/** Statuses the API documents for the `status[]` filter. */
export const HOSTINGER_PRODUCT_STATUSES = [
  "draft",
  "proposed",
  "published",
  "rejected",
  "archived",
] as const;
export type HostingerProductStatus = (typeof HOSTINGER_PRODUCT_STATUSES)[number];
