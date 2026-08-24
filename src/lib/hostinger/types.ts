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

/* ---------------------------------------------------------------------------
 * Write request/response shapes (Phase 5)
 * ------------------------------------------------------------------------- */

/** POST /products/physical — creates a PUBLISHED product with one variant. */
export interface HostingerCreatePhysicalRequest {
  /** ≤255. Note the API takes `name` but returns `title`. */
  name: string;
  /** Integer ≥1, smallest currency unit (paise for INR). */
  price: number;
  /** ISO 4217, 3 chars. Omit to use the store's default currency. */
  currency?: string;
  /** ≤5000. Create-only: the API offers no way to read a description back. */
  description?: string;
}

/** POST /products/digital — as physical, plus an optional download link. */
export interface HostingerCreateDigitalRequest extends HostingerCreatePhysicalRequest {
  /** ≤2048. */
  download_url?: string;
}

export interface HostingerCreateResponse {
  product: {
    id: string;
    title: string;
    type: string;
    status: string;
    price: number;
    currency_code: string;
  };
  /** Deep link into the Hostinger dashboard for this product. */
  admin_url: string;
}

/**
 * PATCH /products/{id}. Partial — omitted keys are left untouched (verified).
 *
 * `description` is intentionally absent from the CRM's update path: the API can
 * write it but exposes no way to read it, so an edit form would load blank and
 * overwrite the live value with empty. Create only.
 */
export interface HostingerUpdateProductRequest {
  name?: string;
  status?: "draft" | "published" | "archived";
}

/**
 * PATCH /products/{id}/variants/batch — verified PARTIAL: a prices-only body
 * leaves inventory_quantity untouched, so price edits need no read-modify-write.
 *
 * Two vendor quirks, both verified: the price object here uses `currency`
 * (reads return `currency_code`), and `sale_amount: null` is REJECTED — omit the
 * key entirely rather than nulling it.
 */
export interface HostingerVariantPriceUpdate {
  variant_id: string;
  prices: { amount: number; currency: string; sale_amount?: number }[];
}

export interface HostingerVariantBatchRequest {
  variants: HostingerVariantPriceUpdate[];
}

/**
 * PATCH /products/{id}/variants/batch — inventory only (Phase 6).
 *
 * `prices` is deliberately absent from this type. The docs state prices "replace
 * the variant's existing prices in full", so including them in a stock edit could
 * drop a variant's other-currency prices. A stock change must not touch pricing.
 */
export interface HostingerVariantInventoryUpdate {
  variant_id: string;
  /** Integer ≥ 0. Absolute — the resulting quantity, not a delta. */
  inventory_quantity?: number;
  /** Whether stock is tracked at all. False makes the storefront treat it as unlimited. */
  manage_inventory?: boolean;
}

export interface HostingerVariantInventoryBatchRequest {
  variants: HostingerVariantInventoryUpdate[];
}

/** GET /products/{id}/variants */
export interface HostingerVariantListResponse {
  data: HostingerVariant[];
  meta: HostingerListMeta;
}

/* ---------------------------------------------------------------------------
 * Product media (Phase 8A)
 *
 * Two-step upload: request a signed URL, POST the bytes to it, then attach by
 * `object_name`. A single-call path also exists for an image already reachable
 * at a public URL.
 *
 * NOTE: the documented API has NO delete-image and NO reorder-image endpoint.
 * Media can be added from the CRM but not removed or reordered — the UI must say
 * so rather than offer a control that cannot work.
 * ------------------------------------------------------------------------- */

export interface HostingerImageUploadUrlResponse {
  /** Signed storage endpoint to POST the file to (multipart/form-data). */
  upload_url: string;
  /** Form fields that must accompany the multipart upload, verbatim. */
  fields: Record<string, string>;
  /** Key to hand back to the attach endpoint. */
  object_name: string;
}

export interface HostingerAttachImageRequest {
  /** Publicly reachable raster image. Provide either this OR object_name. */
  image_url?: string;
  /** Key returned by the upload-url step. Provide either this OR image_url. */
  object_name?: string;
  /** True makes it the primary image; omitted means "only if there isn't one yet". */
  is_thumbnail?: boolean;
}

/** Raster formats Hostinger accepts. SVG is explicitly refused. */
export const HOSTINGER_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** Documented ceiling: 15 MB. */
export const HOSTINGER_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Commercial fields on a variant, all carried by the batch endpoint.
 *
 * `prices` REPLACES the variant's existing prices in full, which is why callers
 * must send every currency they want kept, not just the one being changed.
 * `sale_amount` must be an integer when present — null is rejected — so clearing
 * a discount means omitting the key entirely.
 */
export interface HostingerVariantCommercialUpdate {
  variant_id: string;
  /** Batch-supported. */
  title?: string;
  /**
   * NOT accepted by the batch endpoint — it is silently ignored there (verified
   * 2026-08-24). Retained only for the variant-CREATE payload, where SKU is the
   * one and only opportunity to set it.
   */
  sku?: string;
  prices?: { amount: number; currency: string; sale_amount?: number }[];
}

/* ---------------------------------------------------------------------------
 * Variant creation (Phase 8B)
 *
 * This is the ONLY endpoint that accepts `sku`, and the only place a variant's
 * option values can ever be set — both are immutable afterwards (verified: the
 * batch endpoint 400s on `options` and silently ignores `sku`).
 *
 * `options` is STRICTLY required: an omitted key and an empty array both return
 * 422 "The options field is required." A variant cannot exist without at least
 * one option, which is why an option-less product can never carry a SKU.
 * ------------------------------------------------------------------------- */

export interface HostingerOptionValue {
  name: string;
  value: string;
}

export interface HostingerCreateVariantRequest {
  /** 1…10 pairs. Required. Every option the product already has must be given a value. */
  options: HostingerOptionValue[];
  /** Optional — omit and Hostinger titles it from the option values ("M", "M / Red"). */
  title?: string;
  /** Set here or never. */
  sku?: string;
  /** `sale_amount` IS honoured at creation — verified — so no follow-up call is needed. */
  prices?: { amount: number; currency: string; sale_amount?: number }[];
  inventory_quantity?: number;
  manage_inventory?: boolean;
}

/**
 * Fields the variant batch endpoint actually accepts. Established by sending each
 * candidate name individually: everything else returns 400, including six
 * spellings of weight and seven of low-stock. Kept here as the authoritative
 * list so nobody re-adds a field the API will reject or silently drop.
 */
export const HOSTINGER_VARIANT_UPDATABLE_FIELDS = [
  "title",
  "inventory_quantity",
  "manage_inventory",
  "prices",
] as const;
