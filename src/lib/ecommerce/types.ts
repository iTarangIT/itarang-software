/**
 * CRM-facing view types for the Hostinger Ecommerce catalog.
 *
 * Shared between the API routes and the Sales Head UI (the same seam as
 * src/lib/admin/types.ts). These are NOT database models — nothing here is
 * persisted. Hostinger remains the source of truth; the CRM stores no ecommerce
 * product data.
 *
 * Deliberately named `Ecommerce*` rather than `Product*`: the CRM already has an
 * unrelated physical EV product/inventory system, and a bare `Product` type in
 * shared scope would invite exactly the conflation this feature must avoid.
 *
 * Fields the documented API cannot supply (description, subtitle, timestamps,
 * slug, purchasable, allow_backorder, low-stock flags, variant is_active) are
 * absent by design rather than optional — see the Phase 4C loss inventory. Their
 * removal is what makes TypeScript flag any call site still expecting them,
 * instead of letting a lost field render as a silently blank cell.
 */

/** Integer amounts in the smallest currency unit (paise for INR). */
export interface EcommercePrice {
  amountMinor: number | null;
  saleAmountMinor: number | null;
  currencyCode: string;
}

/** A product's price span across its variants, as the API reports it. */
export interface EcommercePriceRange {
  minMinor: number | null;
  maxMinor: number | null;
  currencyCode: string;
}

export interface EcommerceVariant {
  id: string;
  title: string;
  sku: string | null;
  /** Null when the variant is not inventory-managed — not zero. */
  inventoryQuantity: number | null;
  manageInventory: boolean;
  price: EcommercePrice | null;
  options: { name: string; value: string }[];
}

export interface EcommerceProductSummary {
  id: string;
  title: string;
  status: string | null;
  /** e.g. "physical" | "digital" */
  type: string | null;
  thumbnail: string | null;
  variantCount: number;
  /** First variant's SKU. Null when the product has multiple variants. */
  sku: string | null;
  /** Sum across inventory-managed variants; null when none is managed. */
  totalInventory: number | null;
  priceRange: EcommercePriceRange | null;
}

export interface EcommerceProductDetail extends EcommerceProductSummary {
  media: { url: string }[];
  variants: EcommerceVariant[];
  /**
   * Deep link into the Hostinger dashboard for this product. Built server-side
   * because the store id lives in server config — exposing it through a
   * NEXT_PUBLIC_ variable just to string a URL together in the browser would
   * leak configuration for no reason.
   */
  adminUrl: string;
}

export interface EcommerceProductListResult {
  rows: EcommerceProductSummary[];
  total: number;
  page: number;
  perPage: number;
}
