/**
 * Shared types for the dealer product cart (battery / charger / paraphernalia
 * / pricing).
 *
 * Extracted verbatim from the Step-4 page so the same cart can be mounted on
 * Step 4 (cash leads) and Step 5 (finance leads, after the lender sanctions).
 * No React import here on purpose — this file is type-only and safe to pull
 * into a server route.
 */

export interface BatteryRow {
  id: string;
  serial_number: string;
  model_name: string | null;
  model_type: string | null;
  product_id?: string | null;
  invoice_date: string | null;
  inventory_age_days: number;
  age_badge: "fresh" | "ageing" | "old";
  soc_percent: string | null;
  soc_last_sync_at?: string | null;
  status?: string | null;
  price: number | null;
  voltage_v?: number | null;
  capacity_ah?: number | null;
  warranty_months?: number | null;
  // GST snapshot from inventory.
  gross_amount?: string | number | null;
  gst_percent?: string | number | null;
  gst_amount?: string | number | null;
  net_amount?: string | number | null;
  recommended: boolean;
}

export interface ChargerRow {
  id: string;
  serial_number: string;
  model_name: string | null;
  model_type: string | null;
  product_id?: string | null;
  invoice_date?: string | null;
  inventory_age_days: number;
  age_badge: "fresh" | "ageing" | "old";
  status?: string | null;
  price: number | null;
  warranty_months?: number | null;
  gross_amount?: string | number | null;
  gst_percent?: string | number | null;
  gst_amount?: string | number | null;
  net_amount?: string | number | null;
  recommended: boolean;
}

export interface ParaRow {
  product_id?: string | null;
  asset_type: string;
  model_type: string | null;
  product_name: string | null;
  available_qty: number;
  unit_price: number | null;
  unit_gross?: number | null;
  gst_percent?: string | number | null;
  unit_gst_amount?: number | null;
  unit_net?: number | null;
}

export interface PriorSelection {
  id: string;
  battery_serial: string | null;
  charger_serial: string | null;
  paraphernalia: Record<string, number | string> | null;
  paraphernalia_lines: unknown;
  category: string | null;
  sub_category: string | null;
  battery_price: string | null;
  charger_price: string | null;
  paraphernalia_cost: string | null;
  dealer_margin: string | null;
  final_price: string | null;
  battery_gross: string | null;
  battery_gst_percent: string | null;
  battery_gst_amount: string | null;
  battery_net: string | null;
  charger_gross: string | null;
  charger_gst_percent: string | null;
  charger_gst_amount: string | null;
  charger_net: string | null;
  gross_subtotal: string | null;
  gst_subtotal: string | null;
  net_subtotal: string | null;
  admin_decision: string | null;
  submitted_at: string | null;
  battery_photo_urls?: string[] | null;
  charger_photo_urls?: string[] | null;
  pre_sanction_doc_urls?: { url: string; name: string; type: string; size: number }[] | null;
}

/** A product type that narrows which inventory the cart offers. */
export interface ScopeProduct {
  id: string;
  name: string;
  sku: string;
  asset_type: string;
  voltage_v: number | null;
  capacity_ah: number | null;
  warranty_months?: number | null;
  available_quantity?: number;
}

export type MarginMode = "rupees" | "percent";

export type AgeFilter = "all" | "recommended" | "ageing" | "old";

export interface PriceTriple {
  gross: number;
  gstPct: number;
  gst: number;
  net: number;
}

export interface ParaLine {
  asset_type: string;
  model_type: string | null;
  product_name: string | null;
  product_id: string | null;
  qty: number;
  unit_gross: number;
  gst_percent: number;
  gst_amount: number;
  unit_net: number;
  line_gross: number;
  line_gst: number;
  line_net: number;
}

export interface CartTotals {
  batteryTriple: PriceTriple;
  chargerTriple: PriceTriple;
  /** Legacy aliases — the net of each triple. */
  batteryPrice: number;
  chargerPrice: number;
  paraLines: ParaLine[];
  paraCost: number;
  paraGross: number;
  paraGst: number;
  grossSubtotal: number;
  gstSubtotal: number;
  netSubtotal: number;
  dealerMargin: number;
  finalPrice: number;
}

/**
 * The shape both submit endpoints accept.
 *
 * Every price is optional because an empty cart must submit as SQL NULL, not
 * as zero. A finance lead goes to its lenders with no product attached, and a
 * stored `final_price` of 0 would read as "this asset costs nothing" to the
 * NBFC queue's amount filter, the hand-off email and the profile PDF — all of
 * which already render null as "—".
 */
export interface ProductSelectionPayload {
  batterySerial: string | null;
  chargerSerial: string | null;
  paraphernalia: Record<string, number>;
  paraphernaliaLines: ParaLine[];
  batteryPrice?: number;
  chargerPrice?: number;
  paraphernaliaCost?: number;
  dealerMargin?: number;
  finalPrice?: number;
  batteryGross?: number;
  batteryGstPercent?: number;
  batteryGstAmount?: number;
  batteryNet?: number;
  chargerGross?: number;
  chargerGstPercent?: number;
  chargerGstAmount?: number;
  chargerNet?: number;
  grossSubtotal?: number;
  gstSubtotal?: number;
  netSubtotal?: number;
  batteryPhotoUrls: string[];
  chargerPhotoUrls: string[];
}
