/**
 * CRM-facing view types for the Hostinger Ecommerce catalog.
 *
 * Shared between the API routes and the Sales Head UI (the same seam as
 * src/lib/admin/types.ts). These are NOT database models — nothing here is
 * persisted. Hostinger remains the source of truth; the CRM stores no
 * ecommerce product data.
 *
 * Deliberately named `Ecommerce*` rather than `Product*`: the CRM already has
 * an unrelated physical EV product/inventory system, and a bare `Product` type
 * in shared scope would invite exactly the conflation this feature must avoid.
 */

export interface EcommercePrice {
  /**
   * Raw vendor amount. SCALE UNVERIFIED — see HostingerPrice.amount. Assumed
   * minor units; `decimalDigits` is carried alongside so the UI can format and
   * still show the raw figure rather than silently asserting a scale.
   */
  amountMinor: number | null;
  saleAmountMinor: number | null;
  currencyCode: string;
  currencySymbol: string;
  decimalDigits: number;
}

export interface EcommerceVariant {
  id: string;
  title: string;
  sku: string | null;
  /** Null when the variant is not inventory-managed — not zero. */
  inventoryQuantity: number | null;
  manageInventory: boolean;
  /** When true, Hostinger will accept orders below zero stock. */
  allowBackorder: boolean;
  trackLowStock: boolean;
  lowStockThreshold: number | null;
  isActive: boolean;
  price: EcommercePrice | null;
  imageUrl: string | null;
}

export interface EcommerceProductSummary {
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  /** e.g. "physical" | "digital" */
  type: string | null;
  thumbnail: string | null;
  slug: string | null;
  variantCount: number;
  /** First variant's SKU. Null when the product has multiple variants. */
  sku: string | null;
  /** Convenience for the list column; null when no variant is managed. */
  totalInventory: number | null;
  /** True when at least one variant allows backorder. */
  anyBackorder: boolean;
  /** Price of the first variant, for the list column. */
  price: EcommercePrice | null;
  updatedAt: string | null;
}

export interface EcommerceProductDetail extends EcommerceProductSummary {
  /** Raw HTML from Hostinger. Must be sanitised before rendering. */
  descriptionHtml: string | null;
  media: { id: string; url: string }[];
  variants: EcommerceVariant[];
  createdAt: string | null;
  purchasable: boolean;
  urlHandle: string | null;
}

export interface EcommerceProductListResult {
  rows: EcommerceProductSummary[];
  total: number;
  offset: number;
  limit: number;
}
