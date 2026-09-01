import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  boolean,
  varchar,
  decimal,
  numeric,
  jsonb,
  json,
  uuid,
  index,
  uniqueIndex,
  bigint,
  char,
  date,
  serial,
  bigserial,
  primaryKey,
  unique,
  customType,
  doublePrecision,
} from "drizzle-orm/pg-core";

import { relations, sql } from "drizzle-orm";

// Postgres bytea column backed by Node Buffer. Used for binary blobs like
// the DigiLocker eAadhaar PDF.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// --- FOUNDATION ---

export const users = pgTable("users", {
  id: uuid().primaryKey().notNull(),
  email: text().notNull(),
  name: text().notNull(),
  role: varchar({ length: 50 }).notNull(),
  dealer_id: varchar("dealer_id", { length: 255 }),
  /**
   * E-195 — accounts.id of the scrap vendor this login acts for; NULL for
   * everyone else. Deliberately not dealer_id above: that column is joined
   * against `dealers` by dealer_code app-wide and a scrap vendor has no
   * dealers row, so those joins would return nothing rather than fail.
   */
  vendor_entity_id: varchar("vendor_entity_id", { length: 255 }),
  phone: text(),
  avatar_url: text("avatar_url"),
  is_active: boolean("is_active").default(true).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  password_hash: text("password_hash"),
  must_change_password: boolean("must_change_password").default(false).notNull(),
});

// --- PHASE 0: MVP ---

export const productCategories = pgTable("product_categories", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: text().notNull(),
  slug: text().notNull(),
  is_active: boolean("is_active").default(true).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const products = pgTable(
  "products",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    category_id: uuid("category_id").notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    voltage_v: integer("voltage_v").notNull(),
    capacity_ah: integer("capacity_ah").notNull(),
    sku: text().notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    hsn_code: varchar("hsn_code", { length: 8 }),
    asset_type: varchar("asset_type", { length: 50 }),
    is_serialized: boolean("is_serialized").default(true).notNull(),
    warranty_months: integer("warranty_months").default(0).notNull(),
    status: varchar({ length: 20 }).default('active').notNull(),
    price: integer(),
  },
  (table) => ({
    catSortIdx: index("idx_products_category_sort").on(
      table.category_id,
      table.sort_order,
    ),
    voltCapIdx: index("idx_products_voltage_capacity").on(
      table.voltage_v,
      table.capacity_ah,
    ),
  }),
);

// BRD strict product-master split (battery / charger / paraphernalia).
// Existing `products` continues to power current flows while these tables
// become the authoritative BRD contract surfaces.
export const productMasterBatteries = pgTable(
  "product_master_batteries",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    model_id: varchar("model_id", { length: 50 }).notNull(),
    model_name: varchar("model_name", { length: 100 }).notNull(),
    compatible_categories: jsonb("compatible_categories").default([]).notNull(),
    compatible_sub_categories: jsonb("compatible_sub_categories").default([]).notNull(),
    voltage_v: decimal("voltage_v", { precision: 6, scale: 2 }),
    capacity_ah: decimal("capacity_ah", { precision: 8, scale: 2 }),
    battery_chemistry: varchar("battery_chemistry", { length: 20 }),
    warranty_months: integer("warranty_months").default(0).notNull(),
    iot_compatible: boolean("iot_compatible").default(false).notNull(),
    compatible_charger_models: jsonb("compatible_charger_models").default([]).notNull(),
    // E-242 — what the GST proforma quotation prints per line. Nullable with no
    // backfill: a guessed rate is a wrong number on a tax document, so NULL
    // means "not set yet" and the renderer shows it as unset, never as zero.
    hsn_code: varchar("hsn_code", { length: 8 }),
    gst_rate_pct: numeric("gst_rate_pct", { precision: 5, scale: 2 }),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pmBatteryModelIdUnique: unique("pm_battery_model_id_unique").on(table.model_id),
    pmBatteryStatusIdx: index("pm_battery_status_idx").on(table.status),
  }),
);

export const productMasterChargers = pgTable(
  "product_master_chargers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    model_id: varchar("model_id", { length: 50 }).notNull(),
    model_name: varchar("model_name", { length: 100 }).notNull(),
    output_voltage_v: decimal("output_voltage_v", { precision: 6, scale: 2 }),
    output_current_a: decimal("output_current_a", { precision: 6, scale: 2 }),
    charging_type: varchar("charging_type", { length: 30 }),
    compatible_battery_models: jsonb("compatible_battery_models").default([]).notNull(),
    base_price: numeric("base_price", { precision: 12, scale: 2 }),
    warranty_months: integer("warranty_months").default(0).notNull(),
    // E-242 — see product_master_batteries.
    hsn_code: varchar("hsn_code", { length: 8 }),
    gst_rate_pct: numeric("gst_rate_pct", { precision: 5, scale: 2 }),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pmChargerModelIdUnique: unique("pm_charger_model_id_unique").on(table.model_id),
    pmChargerStatusIdx: index("pm_charger_status_idx").on(table.status),
  }),
);

export const productMasterParaphernalia = pgTable(
  "product_master_paraphernalia",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    item_type_code: varchar("item_type_code", { length: 50 }).notNull(),
    display_label: varchar("display_label", { length: 100 }).notNull(),
    compatible_categories: jsonb("compatible_categories").default([]).notNull(),
    max_qty_per_lead: integer("max_qty_per_lead").default(0).notNull(),
    harness_variant: boolean("harness_variant").default(false).notNull(),
    // E-242 — see product_master_batteries.
    hsn_code: varchar("hsn_code", { length: 8 }),
    gst_rate_pct: numeric("gst_rate_pct", { precision: 5, scale: 2 }),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pmParaItemTypeUnique: unique("pm_para_item_type_unique").on(table.item_type_code),
    pmParaStatusIdx: index("pm_para_status_idx").on(table.status),
  }),
);

// E-226 + E-230 — the OEM reference price book. Append-only: a revision closes
// the row it replaces (effective_to) and inserts a new one, so history survives
// for audit.
//
// E-230 made it DATED. Each open row (effective_to IS NULL) owns a half-open
// window [effective_from, valid_until) and one product's windows never overlap,
// so a product may hold the price in force PLUS any scheduled successors —
// which is how "my next pricing for the next period would be 52,000" is
// represented. The non-overlap is held by setOemPrice() locking the product's
// open rows FOR UPDATE; the partial unique index
// oem_reference_prices_open_from_uniq is the backstop and, being partial, lives
// only in the migration.
//
// product_id is TEXT, not uuid, on purpose: it joins to
// dealer_lead_commercials.product_lines[].product_id, which the picker emits as
// product_master_*.id::text. No FK — the parent is one of three tables chosen
// by asset_type.
export const oemReferencePrices = pgTable(
  "oem_reference_prices",
  {
    price_id: uuid("price_id").primaryKey().defaultRandom(),
    asset_type: varchar("asset_type", { length: 30 }).notNull(),
    product_id: text("product_id").notNull(),
    model_id: varchar("model_id", { length: 100 }),
    product_name: varchar("product_name", { length: 200 }),
    oem_price: numeric("oem_price", { precision: 14, scale: 2 }).notNull(),
    // May be in the future since E-230 — that is a queued successor line.
    effective_from: timestamp("effective_from", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Superseded-at. Bookkeeping, never chosen by the admin.
    effective_to: timestamp("effective_to", { withTimezone: true }),
    // E-230 — the DECLARED expiry, exclusive. NULL means open-ended, which is
    // every pre-E-230 row. Not the same thing as effective_to: a row can expire
    // without ever being superseded, and that is the state the notification
    // exists to catch.
    valid_until: timestamp("valid_until", { withTimezone: true }),
    expiry_notified_at: timestamp("expiry_notified_at", { withTimezone: true }),
    note: text(),
    created_by: text("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    oemPriceProductIdx: index("oem_reference_prices_product_idx").on(
      table.product_id,
      table.effective_from,
    ),
  }),
);

export const oems = pgTable("oems", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  business_entity_name: text("business_entity_name").notNull(),
  gstin: varchar({ length: 15 }).notNull(),
  pan: varchar({ length: 10 }),
  address_line1: text("address_line1"),
  address_line2: text("address_line2"),
  city: text(),
  state: text(),
  pincode: varchar({ length: 6 }),
  bank_name: text("bank_name"),
  bank_account_number: text("bank_account_number").notNull(),
  ifsc_code: varchar("ifsc_code", { length: 11 }).notNull(),
  bank_proof_url: text("bank_proof_url"),
  status: varchar({ length: 20 }).default('active').notNull(),
  onboarding_status: varchar("onboarding_status", { length: 30 }).default('pending').notNull(),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const oemContacts = pgTable("oem_contacts", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  oem_id: varchar("oem_id", { length: 255 }).notNull(),
  name: text().notNull(),
  designation: text(),
  email: text(),
  phone: varchar({ length: 20 }),
  is_primary: boolean("is_primary").default(false),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  contact_role: varchar("contact_role", { length: 50 }),
  contact_name: text("contact_name"),
  contact_phone: varchar("contact_phone", { length: 20 }),
  contact_email: text("contact_email"),
});

export const inventory = pgTable(
  "inventory",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    oem_id: varchar("oem_id", { length: 255 }),
    oem_name: text("oem_name"),
    product_catalog_id: varchar("product_catalog_id", { length: 255 }),
    hsn_code: varchar("hsn_code", { length: 8 }),
    // BRD canonical inventory type.
    inventory_type: varchar("inventory_type", { length: 30 }),
    asset_category: varchar("asset_category", { length: 20 }).notNull(),
    asset_type: varchar("asset_type", { length: 50 }).notNull(),
    sub_category: varchar("sub_category", { length: 100 }),
    model_type: text("model_type").notNull(),
    serial_number: varchar("serial_number", { length: 255 }),
    material_code: varchar("material_code", { length: 100 }),
    is_serialized: boolean("is_serialized").default(true).notNull(),
    warranty_months: integer("warranty_months").default(0).notNull(),
    status: varchar({ length: 30 }).default("available").notNull(),
    batch_number: varchar("batch_number", { length: 100 }),
    received_date: timestamp("received_date", { withTimezone: true }),
    pdi_status: varchar("pdi_status", { length: 20 }).default("pending"),
    pdi_completed_at: timestamp("pdi_completed_at", { withTimezone: true }),
    pdi_by: uuid("pdi_by"),
    dealer_id: varchar("dealer_id", { length: 255 }),
    allocated_to_dealer_at: timestamp("allocated_to_dealer_at", { withTimezone: true }),
    sold_at: timestamp("sold_at", { withTimezone: true }),
    deal_id: varchar("deal_id", { length: 255 }),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    product_id: uuid("product_id"),
    inventory_amount: numeric("inventory_amount", { precision: 12, scale: 2 }),
    gst_percent: numeric("gst_percent", { precision: 5, scale: 2 }),
    gst_amount: numeric("gst_amount", { precision: 12, scale: 2 }),
    final_amount: numeric("final_amount", { precision: 12, scale: 2 }),
    // E-272: Base Value + GST on it. Mirrors final_amount; written by every upload path.
    price_inclusive_gst: numeric("price_inclusive_gst", { precision: 12, scale: 2 }),
    oem_invoice_number: text("oem_invoice_number"),
    oem_invoice_date: timestamp("oem_invoice_date", { withTimezone: true }),
    oem_invoice_url: text("oem_invoice_url"),
    product_manual_url: text("product_manual_url"),
    warranty_document_url: text("warranty_document_url"),
    warehouse_location: text("warehouse_location"),
    manufacturing_date: timestamp("manufacturing_date", { withTimezone: true }),
    expiry_date: timestamp("expiry_date", { withTimezone: true }),
    quantity: integer(),
    iot_imei_no: varchar("iot_imei_no", { length: 255 }),
    iot_enabled: boolean("iot_enabled").default(false).notNull(),
    linked_lead_id: varchar("linked_lead_id", { length: 255 }),
    dispatch_date: timestamp("dispatch_date", { withTimezone: true }),
    soc_percent: numeric("soc_percent", { precision: 5, scale: 2 }),
    soc_last_sync_at: timestamp("soc_last_sync_at", { withTimezone: true }),
    // BRD upload + detail fields.
    voltage_v: decimal("voltage_v", { precision: 6, scale: 2 }),
    capacity_ah: decimal("capacity_ah", { precision: 8, scale: 2 }),
    output_current_a: decimal("output_current_a", { precision: 6, scale: 2 }),
    compatible_models: jsonb("compatible_models"),
    star_rating: integer("star_rating"),
    physical_condition: varchar("physical_condition", { length: 20 }),
    oem_warranty_date: date("oem_warranty_date"),
    oem_warranty_months: integer("oem_warranty_months"),
    oem_warranty_expiry: date("oem_warranty_expiry"),
    oem_warranty_clauses: text("oem_warranty_clauses"),
    upload_event_id: varchar("upload_event_id", { length: 64 }),
  },
  (table) => ({
    inventoryDealerStatusIdx: index("inventory_dealer_status_idx").on(
      table.dealer_id,
      table.status,
    ),
    inventoryInvoiceDateIdx: index("inventory_invoice_date_idx").on(
      table.oem_invoice_date,
    ),
    inventorySerialUnique: unique("inventory_serial_unique").on(table.serial_number),
    inventoryImeiUnique: unique("inventory_imei_unique").on(table.iot_imei_no),
  }),
);

// --- DEALER SALES ---
export const leads = pgTable("leads", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  dealer_id: varchar("dealer_id", { length: 255 }),
  assigned_to: uuid("assigned_to"),
  owner_name: text("owner_name"),
  owner_contact: varchar("owner_contact", { length: 20 }),
  phone: varchar({ length: 20 }),
  mobile: varchar({ length: 20 }),
  permanent_address: text("permanent_address"),
  local_address: text("local_address"),
  vehicle_ownership: varchar("vehicle_ownership", { length: 50 }),
  battery_type: varchar("battery_type", { length: 50 }),
  asset_model: text("asset_model"),
  asset_price: numeric("asset_price", { precision: 12, scale:  2 }),
  family_members: integer("family_members"),
  driving_experience: integer("driving_experience"),
  loan_required: boolean("loan_required").default(false),
  interest_level: varchar("interest_level", { length: 20 }).default('cold'),
  lead_score: integer("lead_score").default(0),
  status: varchar({ length: 30 }).default('new'),
  kyc_status: varchar("kyc_status", { length: 30 }).default('pending'),
  kyc_score: integer("kyc_score").default(0),
  kyc_completed_at: timestamp("kyc_completed_at", { withTimezone: true }),
  payment_method: varchar("payment_method", { length: 20 }),
  consent_status: varchar("consent_status", { length: 20 }).default('pending'),
  has_co_borrower: boolean("has_co_borrower").default(false),
  has_additional_docs_required: boolean("has_additional_docs_required").default(false),
  // E-264 — 'unassigned' | 'assigned'. A customer who self-onboards over
  // WhatsApp has no dealer, but dealer_id can NOT be left NULL: nearly every
  // read path compares it against the caller's dealer code, so a NULL would make
  // the lead invisible to the very queue meant to rescue it. dealer_id therefore
  // points at the house dealer as a holding pen, and ownership is expressed
  // here. Step 4 refuses to start while this is 'unassigned'.
  assignment_status: varchar("assignment_status", { length: 24 })
    .default('assigned')
    .notNull(),
  dealer_assigned_at: timestamp("dealer_assigned_at", { withTimezone: true }),
  dealer_assigned_by: uuid("dealer_assigned_by"),
  interim_step_status: varchar("interim_step_status", { length: 20 }).default('pending'),
  kyc_draft_data: jsonb("kyc_draft_data"),
  step_status: jsonb("step_status"),
  source: varchar({ length: 50 }),
  // E-174 — channel the lead was CREATED through ('whatsapp' for the post-approval
  // WhatsApp dealer console; NULL for web/other). Distinguishes WhatsApp leads,
  // which share lead_source='dealer_referral' with web-dealer leads.
  source_channel: varchar("source_channel", { length: 20 }),
  // E-277 — dealer_salespersons.id of the salesperson who created this lead
  // over WhatsApp. NULL = the dealer themselves (or a non-WhatsApp channel).
  // uploader_id stays the dealer's users.id — salespersons have no login.
  salesperson_id: uuid("salesperson_id"),
  remarks: text(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  lead_source: varchar("lead_source", { length: 50 }).notNull(),
  lead_status: varchar("lead_status", { length: 50 }).default('new').notNull(),
  business_name: text("business_name"),
  owner_email: text("owner_email"),
  state: varchar({ length: 100 }),
  city: varchar({ length: 100 }),
  shop_address: text("shop_address"),
  lead_type: varchar("lead_type", { length: 20 }),
  vehicle_rc: varchar("vehicle_rc", { length: 50 }),
  full_name: text("full_name"),
  father_or_husband_name: text("father_or_husband_name"),
  dob: timestamp({ withTimezone: true }),
  current_address: text("current_address"),
  is_current_same: boolean("is_current_same").default(false).notNull(),
  product_category_id: varchar("product_category_id", { length: 255 }),
  product_type_id: varchar("product_type_id", { length: 255 }),
  // E-116 — primary product's asset kind (battery | charger | paraphernalia);
  // lets the new-lead "Product Details" cascade reload when a lead is edited.
  asset_type: varchar("asset_type", { length: 20 }),
  vehicle_owner_name: text("vehicle_owner_name"),
  vehicle_owner_phone: varchar("vehicle_owner_phone", { length: 20 }),
  auto_filled: boolean("auto_filled").default(false).notNull(),
  ocr_status: varchar("ocr_status", { length: 20 }),
  ocr_error: text("ocr_error"),
  reference_id: varchar("reference_id", { length: 255 }),
  interested_in: jsonb("interested_in"),
  battery_order_expected: integer("battery_order_expected"),
  investment_capacity: numeric("investment_capacity", { precision: 12, scale:  2 }),
  business_type: varchar("business_type", { length: 50 }),
  qualified_by: uuid("qualified_by"),
  qualified_at: timestamp("qualified_at", { withTimezone: true }),
  qualification_notes: text("qualification_notes"),
  converted_deal_id: varchar("converted_deal_id", { length: 255 }),
  converted_at: timestamp("converted_at", { withTimezone: true }),
  total_ai_calls: integer("total_ai_calls").default(0),
  last_ai_call_at: timestamp("last_ai_call_at", { withTimezone: true }),
  last_call_outcome: text("last_call_outcome"),
  ai_priority_score: numeric("ai_priority_score", { precision: 5, scale:  2 }),
  next_call_after: timestamp("next_call_after", { withTimezone: true }),
  do_not_call: boolean("do_not_call").default(false),
  workflow_step: integer("workflow_step").default(1).notNull(),
  primary_product_id: uuid("primary_product_id"),
  uploader_id: uuid("uploader_id").notNull(),
  ai_managed: boolean("ai_managed").default(false),
  ai_owner: text("ai_owner"),
  manual_takeover: boolean("manual_takeover").default(false),
  last_ai_action_at: timestamp("last_ai_action_at", { withTimezone: true }),
  intent_score: integer("intent_score"),
  intent_reason: text("intent_reason"),
  next_call_at: timestamp("next_call_at", { withTimezone: true }),
  call_priority: integer("call_priority").default(0),
  conversation_summary: text("conversation_summary"),
  last_call_status: text("last_call_status"),
  sm_review_status: varchar("sm_review_status", { length: 30 }).default('not_submitted'),
  submitted_to_sm_at: timestamp("submitted_to_sm_at", { withTimezone: true }),
  sm_assigned_to: uuid("sm_assigned_to"),
  consent_link_url: text("consent_link_url"),
  consent_link_sent_at: timestamp("consent_link_sent_at", { withTimezone: true }),
  consent_link_expires_at: timestamp("consent_link_expires_at", { withTimezone: true }),
  consent_delivery_channel: varchar("consent_delivery_channel", { length: 50 }),
  esign_transaction_id: varchar("esign_transaction_id", { length: 255 }),
  esign_certificate_id: varchar("esign_certificate_id", { length: 255 }),
  esign_completed_at: timestamp("esign_completed_at", { withTimezone: true }),
  esign_failed_at: timestamp("esign_failed_at", { withTimezone: true }),
  esign_error_code: varchar("esign_error_code", { length: 100 }),
  esign_error_message: text("esign_error_message"),
  consent_verified_by: uuid("consent_verified_by"),
  consent_verified_at: timestamp("consent_verified_at", { withTimezone: true }),
  consent_verification_notes: text("consent_verification_notes"),
  consent_final: boolean("consent_final").default(false),
  consent_rejection_reason: varchar("consent_rejection_reason", { length: 255 }),
  consent_rejection_notes: text("consent_rejection_notes"),
  consent_rejected_by: uuid("consent_rejected_by"),
  consent_rejected_at: timestamp("consent_rejected_at", { withTimezone: true }),
  consent_attempt_count: integer("consent_attempt_count").default(0),
  google_place_id: varchar("google_place_id", { length: 255 }),
  website: text(),
  google_maps_uri: text("google_maps_uri"),
  google_rating: numeric("google_rating", { precision: 3, scale:  1 }),
  google_ratings_count: integer("google_ratings_count"),
  google_business_status: varchar("google_business_status", { length: 50 }),
  google_business_types: jsonb("google_business_types"),
  raw_source_payload: jsonb("raw_source_payload"),
  scrape_query: text("scrape_query"),
  scrape_batch_id: varchar("scrape_batch_id", { length: 255 }),
  scraped_at: timestamp("scraped_at", { withTimezone: true }),
  phone_quality: varchar("phone_quality", { length: 20 }).default('valid'),
  normalized_phone: varchar("normalized_phone", { length: 20 }),
  intent_band: varchar("intent_band", { length: 20 }),
  intent_scored_at: timestamp("intent_scored_at", { withTimezone: true }),
  intent_details: jsonb("intent_details"),
  coupon_code: varchar("coupon_code", { length: 20 }),
  coupon_status: varchar("coupon_status", { length: 20 }),
  borrower_consent_status: varchar("borrower_consent_status", { length: 30 }).default('awaiting_signature'),
  sold_at: timestamp("sold_at", { withTimezone: true }),
  // E-130 — Addendum V0.1 §3.2, §3.3. Captured at Step 1 for finance leads;
  // resident_status feeds the BRE's Owned/Rented housing-variant match;
  // insurance flags are informational (no BRE gate today). Required at the
  // API layer for finance payment methods; nullable in DB so cash leads and
  // legacy rows stay valid.
  resident_status: varchar("resident_status", { length: 20 }),
  has_health_insurance: boolean("has_health_insurance"),
  has_life_insurance: boolean("has_life_insurance"),
  // E-141 — Addendum V0.2 §12.1. Terminal "Financing Unavailable" state. Set
  // when admin confirms all financing avenues are exhausted. The category-level
  // decline reason is retained even after §12.3 finance-data purge.
  financing_decline_category: varchar("financing_decline_category", { length: 40 }), // 'all_declined' | 'no_match' | 'handoff_unanswered'
  financing_unavailable_at: timestamp("financing_unavailable_at", { withTimezone: true }),
  // E-275 — "Up to how much loan do you want?" asked before the lender list.
  // Products whose loan_amount_max is below this are hidden at Step 4.
  requested_loan_amount: integer("requested_loan_amount"),
  // E-275 — admin Recall / Resubmit. Recalled while
  // recalled_at IS NOT NULL AND (resubmitted_at IS NULL OR resubmitted_at < recalled_at).
  recalled_at: timestamp("recalled_at", { withTimezone: true }),
  recalled_by: uuid("recalled_by"),
  recall_note: text("recall_note"),
  resubmitted_at: timestamp("resubmitted_at", { withTimezone: true }),
});

// E-116 — extra products attached to a lead via the new-lead form's
// "Add Another Product" rows. The primary product stays on leads.primary_product_id;
// this table holds only the additional selections. `category_slug` + `asset_type`
// are stored so the 3-level cascade fully rehydrates in edit mode without probing.
export const leadProducts = pgTable(
  "lead_products",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    product_id: uuid("product_id").notNull(),
    product_category_id: varchar("product_category_id", { length: 255 }),
    category_slug: varchar("category_slug", { length: 16 }),
    asset_type: varchar("asset_type", { length: 20 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Mirrors drizzle/E-116_lead_products.sql — one lookup per lead drives
    // edit-mode rehydration of the extra-product rows.
    leadIdx: index("lead_products_lead_idx").on(table.lead_id),
  }),
);

// export const leads_commented = pgTable(
//   "leads",
//   {
//     id: varchar("id", { length: 255 }).primaryKey(), // LEAD-YYYYMMDD-SEQ
//     lead_source: varchar("lead_source", { length: 50 }).notNull(), // call_center, ground_sales, digital_marketing, database_upload, dealer_referral
//     interest_level: varchar("interest_level", { length: 20 })
//       .default("cold")
//       .notNull(), // cold, warm, hot
//     lead_status: varchar("lead_status", { length: 50 })
//       .default("new")
//       .notNull(), // new, assigned, contacted, qualified, converted, lost
//     dealer_id: varchar("dealer_id", { length: 255 }).references(
//       () => accounts.id,
//     ), // Scoped to dealer org

//     // Dealer Info
//     owner_name: text("owner_name").notNull(),
//     owner_contact: varchar("owner_contact", { length: 20 }).notNull(),
//     business_name: text("business_name"),
//     owner_email: text("owner_email"),

//     // Location
//     state: varchar("state", { length: 100 }), // can be nullable now if not always provided
//     city: varchar("city", { length: 100 }), // can be nullable
//     shop_address: text("shop_address"),

//     // Extended Attributes (Dealer Portal)
//     mobile: varchar("mobile", { length: 20 }),
//     permanent_address: text("permanent_address"),
//     vehicle_ownership: varchar("vehicle_ownership", { length: 50 }),
//     battery_type: varchar("battery_type", { length: 50 }),
//     asset_model: text("asset_model"),
//     asset_price: decimal("asset_price", { precision: 12, scale: 2 }),
//     family_members: integer("family_members"),
//     driving_experience: integer("driving_experience"),
//     lead_type: varchar("lead_type", { length: 20 }), // hot, warm, cold
//     vehicle_rc: varchar("vehicle_rc", { length: 50 }),

//     // V2 Step 1 Mapping (Additive)
//     full_name: text("full_name"),
//     father_or_husband_name: text("father_or_husband_name"),
//     dob: timestamp("dob", { withTimezone: true }),
//     phone: varchar("phone", { length: 20 }),
//     current_address: text("current_address"),
//     is_current_same: boolean("is_current_same").notNull().default(false),
//     product_category_id: varchar("product_category_id", { length: 255 }), // Changed from uuid to match catalog
//     product_type_id: varchar("product_type_id", { length: 255 }), // Added for Step 1 selection
//     vehicle_owner_name: text("vehicle_owner_name"),
//     vehicle_owner_phone: varchar("vehicle_owner_phone", { length: 20 }),
//     auto_filled: boolean("auto_filled").default(false).notNull(),
//     ocr_status: varchar("ocr_status", { length: 20 }), // success, partial, failed
//     ocr_error: text("ocr_error"),
//     reference_id: varchar("reference_id", { length: 255 }).unique(),

//     // Business Details
//     interested_in: jsonb("interested_in"), // Array of product IDs
//     battery_order_expected: integer("battery_order_expected"),
//     investment_capacity: decimal("investment_capacity", {
//       precision: 12,
//       scale: 2,
//     }),
//     business_type: varchar("business_type", { length: 50 }), // retail, wholesale, distributor

//     // Qualification
//     qualified_by: uuid("qualified_by").references(() => users.id),
//     qualified_at: timestamp("qualified_at", { withTimezone: true }),
//     qualification_notes: text("qualification_notes"),

//     // Conversion
//     converted_deal_id: varchar("converted_deal_id", { length: 255 }),
//     converted_at: timestamp("converted_at", { withTimezone: true }),

//     // AI Call tracking
//     total_ai_calls: integer("total_ai_calls").default(0),
//     last_ai_call_at: timestamp("last_ai_call_at", { withTimezone: true }),
//     last_call_outcome: text("last_call_outcome"),
//     ai_priority_score: decimal("ai_priority_score", { precision: 5, scale: 2 }),
//     next_call_after: timestamp("next_call_after", { withTimezone: true }),
//     do_not_call: boolean("do_not_call").default(false),

//     // AI Dialer (Bolna)
//     ai_managed: boolean("ai_managed").default(false),
//     ai_owner: text("ai_owner"),
//     manual_takeover: boolean("manual_takeover").default(false),
//     last_ai_action_at: timestamp("last_ai_action_at", { withTimezone: true }),
//     intent_score: integer("intent_score"),
//     intent_reason: text("intent_reason"),
//     next_call_at: timestamp("next_call_at", { withTimezone: true }),
//     call_priority: integer("call_priority").default(0),
//     conversation_summary: text("conversation_summary"),
//     last_call_status: text("last_call_status"),

//     // V2 Workflow
//     status: varchar("status", { length: 50 }).default("INCOMPLETE").notNull(), // INCOMPLETE, ACTIVE, CONVERTED, ABANDONED
//     workflow_step: integer("workflow_step").default(1).notNull(),
//     primary_product_id: uuid("primary_product_id").references(
//       () => products.id,
//     ),
//     lead_score: integer("lead_score"), // hot=90, warm=60, cold=30

//     // KYC Fields
//     kyc_status: varchar("kyc_status", { length: 30 }).default("not_started"), // not_started, draft, in_progress, completed, failed
//     kyc_score: integer("kyc_score"), // 0-100 calculated score
//     kyc_completed_at: timestamp("kyc_completed_at", { withTimezone: true }),
//     payment_method: varchar("payment_method", { length: 20 }), // upfront, finance
//     consent_status: varchar("consent_status", { length: 30 }).default(
//       "awaiting_signature",
//     ), // awaiting_signature, link_sent, digitally_signed, manual_uploaded, verified
//     has_co_borrower: boolean("has_co_borrower").default(false),
//     has_additional_docs_required: boolean(
//       "has_additional_docs_required",
//     ).default(false),
//     interim_step_status: varchar("interim_step_status", { length: 20 }), // pending, completed
//     kyc_draft_data: jsonb("kyc_draft_data"), // Stores draft KYC form data

//     // SM Workflow
//     sm_review_status: varchar("sm_review_status", { length: 30 }).default(
//       "not_submitted",
//     ), // not_submitted, pending_sm_review, under_review, docs_verified, options_ready, option_booked
//     submitted_to_sm_at: timestamp("submitted_to_sm_at", { withTimezone: true }),
//     sm_assigned_to: uuid("sm_assigned_to").references(() => users.id),

//     // Metadata
//     uploader_id: uuid("uploader_id")
//       .references(() => users.id)
//       .notNull(),
//     created_at: timestamp("created_at", { withTimezone: true })
//       .defaultNow()
//       .notNull(),
//     updated_at: timestamp("updated_at", { withTimezone: true })
//       .defaultNow()
//       .notNull(),
//   },
//   (table) => {
//     return {
//       leadsSourceIdx: index("leads_source_idx").on(table.leadSource),
//       leadsInterestIdx: index("leads_interest_idx").on(table.interestLevel),
//       leadsStatusIdx: index("leads_status_idx").on(table.leadStatus),
//     };
//   },
// );

export const loanDetails = pgTable("loan_details", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  loan_required: boolean("loan_required").default(false),
  loan_amount: numeric("loan_amount", { precision: 12, scale:  2 }),
  interest_rate: numeric("interest_rate", { precision: 5, scale:  2 }),
  tenure_months: integer("tenure_months"),
  processing_fee: numeric("processing_fee", { precision: 10, scale:  2 }),
  emi: numeric({ precision: 10, scale:  2 }),
  down_payment: numeric("down_payment", { precision: 12, scale:  2 }),
  finance_type: varchar("finance_type", { length: 50 }),
  financier: varchar({ length: 100 }),
  asset_type: varchar("asset_type", { length: 50 }),
  loan_type: varchar("loan_type", { length: 50 }),
  vehicle_rc: text("vehicle_rc"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const personalDetails = pgTable("personal_details", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  aadhaar_no: varchar("aadhaar_no", { length: 12 }),
  pan_no: varchar("pan_no", { length: 10 }),
  dob: timestamp({ withTimezone: true }),
  email: text(),
  income: numeric({ precision: 12, scale:  2 }),
  father_husband_name: text("father_husband_name"),
  marital_status: varchar("marital_status", { length: 20 }),
  spouse_name: text("spouse_name"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  finance_type: varchar("finance_type", { length: 50 }),
  financier: varchar({ length: 100 }),
  asset_type: varchar("asset_type", { length: 50 }),
  vehicle_rc: varchar("vehicle_rc", { length: 50 }),
  loan_type: varchar("loan_type", { length: 100 }),
  local_address: text("local_address"),
  dob_confidence: numeric("dob_confidence", { precision: 5, scale:  2 }),
  name_confidence: numeric("name_confidence", { precision: 5, scale:  2 }),
  address_confidence: numeric("address_confidence", { precision: 5, scale:  2 }),
  ocr_processed_at: timestamp("ocr_processed_at", { withTimezone: true }),
  permanent_address: text("permanent_address"),
  bank_account_number: varchar("bank_account_number", { length: 50 }),
  bank_ifsc: varchar("bank_ifsc", { length: 20 }),
  bank_name: varchar("bank_name", { length: 100 }),
  bank_branch: varchar("bank_branch", { length: 100 }),
});

export const documents = pgTable("documents", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  type: varchar({ length: 50 }).notNull(),
  url: text().notNull(),
  uploaded_at: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  document_type: varchar("document_type", { length: 50 }),
  file_url: text("file_url"),
});

export const leadDocuments = pgTable("lead_documents", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  document_type: varchar("document_type", { length: 50 }).notNull(),
  document_url: text("document_url").notNull(),
  status: varchar({ length: 20 }).default('uploaded'),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  dealer_id: varchar("dealer_id", { length: 255 }),
  user_id: uuid("user_id"),
  doc_type: varchar("doc_type", { length: 100 }),
  storage_path: text("storage_path"),
});

export const leadAssignments = pgTable("lead_assignments", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  lead_owner: uuid("lead_owner").notNull(),
  assigned_by: uuid("assigned_by").notNull(),
  assigned_at: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  lead_actor: uuid("lead_actor"),
  actor_assigned_by: uuid("actor_assigned_by"),
  actor_assigned_at: timestamp("actor_assigned_at", { withTimezone: true }),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const assignmentChangeLogs = pgTable("assignment_change_logs", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  old_user_id: uuid("old_user_id"),
  new_user_id: uuid("new_user_id"),
  changed_by: uuid("changed_by"),
  change_type: varchar("change_type", { length: 50 }).notNull(),
  reason: text(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  change_reason: text("change_reason"),
  changed_at: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const deals = pgTable("deals", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  products: jsonb().notNull(),
  line_total: numeric("line_total", { precision: 12, scale:  2 }).notNull(),
  gst_amount: numeric("gst_amount", { precision: 12, scale:  2 }).notNull(),
  transportation_cost: numeric("transportation_cost", { precision: 10, scale:  2 }).default('0').notNull(),
  transportation_gst_percent: integer("transportation_gst_percent").default(18).notNull(),
  total_payable: numeric("total_payable", { precision: 12, scale:  2 }).notNull(),
  payment_term: varchar("payment_term", { length: 20 }).notNull(),
  credit_period_months: integer("credit_period_months"),
  deal_status: varchar("deal_status", { length: 50 }).default('pending_approval_l1').notNull(),
  is_immutable: boolean("is_immutable").default(false).notNull(),
  invoice_number: text("invoice_number"),
  invoice_url: text("invoice_url"),
  invoice_issued_at: timestamp("invoice_issued_at", { withTimezone: true }),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  expired_by: uuid("expired_by"),
  expired_at: timestamp("expired_at", { withTimezone: true }),
  expiry_reason: text("expiry_reason"),
  rejected_by: uuid("rejected_by"),
  rejected_at: timestamp("rejected_at", { withTimezone: true }),
  rejection_reason: text("rejection_reason"),
  created_by: uuid("created_by").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const approvals = pgTable("approvals", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  entity_type: varchar("entity_type", { length: 50 }).notNull(),
  entity_id: varchar("entity_id", { length: 255 }).notNull(),
  level: integer().notNull(),
  approver_role: varchar("approver_role", { length: 50 }).notNull(),
  status: varchar({ length: 20 }).default('pending').notNull(),
  approver_id: uuid("approver_id"),
  approved_at: timestamp("approved_at", { withTimezone: true }),
  notes: text(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  decision_at: timestamp("decision_at", { withTimezone: true }),
  rejection_reason: text("rejection_reason"),
  comments: text(),
});

export const orderDisputes = pgTable("order_disputes", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  order_id: varchar("order_id", { length: 255 }).notNull(),
  dispute_type: varchar("dispute_type", { length: 50 }).notNull(),
  description: text().notNull(),
  status: varchar({ length: 20 }).default('open').notNull(),
  resolution: text(),
  raised_by: uuid("raised_by").notNull(),
  resolved_by: uuid("resolved_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  photos_urls: jsonb("photos_urls"),
  resolution_status: varchar("resolution_status", { length: 50 }).default('open').notNull(),
  resolution_details: text("resolution_details"),
  action_taken: text("action_taken"),
  resolved_at: timestamp("resolved_at"),
  assigned_to: uuid("assigned_to"),
  created_by: uuid("created_by"),
});

export const slas = pgTable("slas", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  entity_type: varchar("entity_type", { length: 50 }).notNull(),
  entity_id: varchar("entity_id", { length: 255 }).notNull(),
  deadline: timestamp({ withTimezone: true }),
  breached: boolean().default(false),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  assigned_to: uuid("assigned_to"),
  status: varchar({ length: 20 }).default('active').notNull(),
  completed_at: timestamp("completed_at"),
  escalated_to: uuid("escalated_to"),
  escalated_at: timestamp("escalated_at"),
  workflow_step: varchar("workflow_step", { length: 100 }),
  sla_deadline: timestamp("sla_deadline"),
});

// --- PDI ---

export const oemInventoryForPDI = pgTable("oem_inventory_for_pdi", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  inventory_id: varchar("inventory_id", { length: 255 }),
  oem_id: varchar("oem_id", { length: 255 }),
  status: varchar({ length: 20 }).default('pending'),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  serial_number: varchar("serial_number", { length: 255 }),
  pdi_status: varchar("pdi_status", { length: 20 }).default('pending').notNull(),
  pdi_record_id: varchar("pdi_record_id", { length: 255 }),
  provision_id: varchar("provision_id", { length: 255 }),
});

export const pdiRecords = pgTable("pdi_records", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  inventory_id: varchar("inventory_id", { length: 255 }),
  performed_by: uuid("performed_by"),
  status: varchar({ length: 20 }).default('pending').notNull(),
  checklist: jsonb(),
  notes: text(),
  completed_at: timestamp("completed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  iot_imei_no: varchar("iot_imei_no", { length: 255 }),
  voltage: numeric({ precision: 5, scale:  2 }),
  soc: integer(),
  capacity_ah: numeric("capacity_ah", { precision: 6, scale:  2 }),
  resistance_mohm: numeric("resistance_mohm", { precision: 6, scale:  2 }),
  temperature_celsius: numeric("temperature_celsius", { precision: 5, scale:  2 }),
  location_address: text("location_address"),
  product_manual_url: text("product_manual_url"),
  warranty_document_url: text("warranty_document_url"),
  pdi_photos: jsonb("pdi_photos"),
  failure_reason: text("failure_reason"),
  inspected_at: timestamp("inspected_at", { withTimezone: true }).defaultNow().notNull(),
  oem_inventory_id: varchar("oem_inventory_id", { length: 255 }),
  provision_id: varchar("provision_id", { length: 255 }),
  service_engineer_id: uuid("service_engineer_id"),
  physical_condition: text("physical_condition"),
  discharging_connector: varchar("discharging_connector", { length: 20 }),
  charging_connector: varchar("charging_connector", { length: 20 }),
  productor_sticker: varchar("productor_sticker", { length: 50 }),
  latitude: numeric({ precision: 10, scale: 8 }),
  longitude: numeric({ precision: 11, scale: 8 }),
  pdi_status: varchar("pdi_status", { length: 20 }),
});

export const auditLogs = pgTable("audit_logs", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  entity_type: varchar("entity_type", { length: 50 }),
  entity_id: varchar("entity_id", { length: 255 }),
  action: varchar({ length: 50 }),
  performed_by: uuid("performed_by"),
  old_data: jsonb("old_data"),
  new_data: jsonb("new_data"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  changes: jsonb(),
  timestamp: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// --- ACCOUNTS ---

export const accounts = pgTable(
  "accounts",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    business_entity_name: text("business_entity_name").notNull(),
    gstin: varchar({ length: 15 }).notNull(),
    pan: varchar({ length: 10 }),
    address_line1: text("address_line1"),
    address_line2: text("address_line2"),
    city: text(),
    state: text(),
    pincode: varchar({ length: 6 }),
    bank_name: text("bank_name"),
    bank_account_number: text("bank_account_number"),
    ifsc_code: varchar("ifsc_code", { length: 11 }),
    bank_proof_url: text("bank_proof_url"),
    // E-193 — RazorpayX fund_account.bank_account.name for a payout; falls
    // back to business_entity_name when null.
    bank_beneficiary_name: text("bank_beneficiary_name"),
    dealer_code: varchar("dealer_code", { length: 50 }),
    contact_name: text("contact_name"),
    contact_email: text("contact_email"),
    contact_phone: varchar("contact_phone", { length: 20 }),
    status: varchar({ length: 20 }).default('active').notNull(),
    onboarding_status: varchar("onboarding_status", { length: 30 }).default('pending').notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // E-192 — GIN trigram, leading-wildcard admin buyback search (M23)
    // against business_entity_name/gstin. `accounts` is not a buyback table
    // and exists on every env — see drizzle/E-192_buyback_scale_indexes.sql.
    businessEntityNameTrgmIdx: index("accounts_business_entity_name_trgm_idx").using(
      "gin",
      t.business_entity_name.op("gin_trgm_ops"),
    ),
    gstinTrgmIdx: index("accounts_gstin_trgm_idx").using("gin", t.gstin.op("gin_trgm_ops")),
  }),
);

// --- PROCUREMENT ---

export const provisions = pgTable("provisions", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  order_id: varchar("order_id", { length: 255 }),
  oem_id: varchar("oem_id", { length: 255 }),
  amount: numeric({ precision: 12, scale:  2 }),
  status: varchar({ length: 20 }).default('pending'),
  notes: text(),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  remarks: text(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  oem_name: text("oem_name"),
  products: jsonb(),
  expected_delivery_date: timestamp("expected_delivery_date", { withTimezone: true }),
});

export const orders = pgTable(
  "orders",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    provision_id: varchar("provision_id", { length: 255 }).notNull(),
    oem_id: varchar("oem_id", { length: 255 }).notNull(),
    account_id: varchar("account_id", { length: 255 }),
    order_items: jsonb("order_items").notNull(),
    total_amount: numeric("total_amount", { precision: 12, scale:  2 }).notNull(),
    payment_term: varchar("payment_term", { length: 20 }).notNull(),
    credit_period_days: integer("credit_period_days"),
    pi_url: text("pi_url"),
    pi_amount: numeric("pi_amount", { precision: 12, scale:  2 }),
    invoice_url: text("invoice_url"),
    grn_id: text("grn_id"),
    grn_date: timestamp("grn_date", { withTimezone: true }),
    payment_status: varchar("payment_status", { length: 20 }).default('unpaid').notNull(),
    payment_amount: numeric("payment_amount", { precision: 12, scale:  2 }).default('0').notNull(),
    payment_mode: varchar("payment_mode", { length: 50 }),
    transaction_id: text("transaction_id"),
    payment_date: timestamp("payment_date", { withTimezone: true }),
    order_status: varchar("order_status", { length: 50 }).default('pi_awaited').notNull(),
    delivery_status: varchar("delivery_status", { length: 20 }).default('pending').notNull(),
    expected_delivery_date: timestamp("expected_delivery_date", { withTimezone: true }),
    actual_delivery_date: timestamp("actual_delivery_date", { withTimezone: true }),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    reorder_tat_days: integer("reorder_tat_days"),
  },
  (table) => {
    return {
      ordersCreatedAtIdx: index("orders_created_at_idx").on(table.created_at),
      ordersPaymentStatusIdx: index("orders_payment_status_idx").on(
        table.payment_status,
      ),
    };
  },
);

export const bolnaCalls = pgTable(
  "bolna_calls",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }),
    bolna_call_id: text("bolna_call_id"),
    agent_id: text("agent_id"),
    status: varchar({ length: 20 }),
    recording_url: text("recording_url"),
    transcript: text(),
    duration_seconds: integer("duration_seconds"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    current_phase: varchar("current_phase", { length: 100 }),
    started_at: timestamp("started_at", { withTimezone: true }),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    transcript_chunk: text("transcript_chunk"),
    chunk_received_at: timestamp("chunk_received_at", { withTimezone: true }),
    full_transcript: text("full_transcript"),
    transcript_fetched_at: timestamp("transcript_fetched_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      bolnaCallIdIdx: index("bolna_calls_bolna_call_id_idx").on(
        table.bolna_call_id,
      ),
      leadIdIdx: index("bolna_calls_lead_id_idx").on(table.lead_id),
      statusIdx: index("bolna_calls_status_idx").on(table.status),
      startedAtIdx: index("bolna_calls_started_at_idx").on(table.started_at),
    };
  },
);

export const aiCallLogs = pgTable(
  "ai_call_logs",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }),
    provider: varchar({ length: 50 }),
    status: varchar({ length: 20 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    started_at: timestamp("started_at", { withTimezone: true }),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    model_used: varchar("model_used", { length: 50 }),
    intent_score: integer("intent_score"),
    intent_reason: text("intent_reason"),
    next_action: varchar("next_action", { length: 50 }),
    agent_id: varchar("agent_id", { length: 255 }),
    phone_number: varchar("phone_number", { length: 20 }),
    transcript: text(),
    summary: text(),
    recording_url: text("recording_url"),
    call_duration: integer("call_duration"),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // UNIQUE, and it has been since 0000_eager_black_panther.sql:43 — this
    // declaration was simply missing, which is drift, not a change. Nothing is
    // added to the database by writing it here; the constraint
    // `ai_call_logs_call_id_unique` already exists on the live instance.
    //
    // It matters because Drizzle will not offer `onConflictDoUpdate` without a
    // declared conflict target. Lacking one, the finalize path hand-rolled a
    // SELECT-then-INSERT whose 23505 was swallowed — so a redelivered webhook
    // lost its write instead of merging it. Declaring the truth is what makes
    // the real upsert expressible.
    call_id: varchar("call_id", { length: 255 }).notNull().unique(),
    // E-110: per-call cost capture from provider APIs. All integer INR paise
    // (E-125) — providers are normalized to INR at fetch time, so the display
    // layer applies no FX conversion.
    total_cost_cents: integer("total_cost_cents"),
    llm_cost_cents: integer("llm_cost_cents"),
    tts_cost_cents: integer("tts_cost_cents"),
    stt_cost_cents: integer("stt_cost_cents"),
    telephony_cost_cents: integer("telephony_cost_cents"),
    platform_cost_cents: integer("platform_cost_cents"),
    cost_currency: varchar("cost_currency", { length: 3 }).default("INR"),
    cost_source: varchar("cost_source", { length: 20 }),
    cost_fetched_at: timestamp("cost_fetched_at", { withTimezone: true }),
    // E-156: auditable intent scoring. `scoring_version` stamps which weight
    // table produced `intent_score`; `signals` and `score_breakdown` persist the
    // raw extracted signals and the truthful per-point breakdown for audit.
    scoring_version: varchar("scoring_version", { length: 20 }),
    signals: jsonb("signals"),
    score_breakdown: jsonb("score_breakdown"),
    // E-168: intent-qualification band model (docs/intent_docs/intent_score.pdf).
    // `band` is the computed qualification band (Qualified|Warm|Cold|Disqualified;
    // null for a dropped_empty call). `call_status` is complete|dropped_partial|
    // dropped_empty. `info_signals_count` (0–5) is the disclosed-facts count that
    // both qualifies (≥3) and orders the Qualified inside-sales queue.
    band: varchar("band", { length: 20 }),
    call_status: varchar("call_status", { length: 20 }),
    info_signals_count: integer("info_signals_count"),
    // E-168 ends here. --- E-250 below ---
    // Which PROMPT produced `signals`. scoring_version already records which BAND
    // RULE ran; this is its extraction-side counterpart, so an audit can tell
    // whether a shift came from a new rule or from new teaching.
    extraction_version: varchar("extraction_version", { length: 40 }),
    // Hash of the active calibration examples at extraction time. Once that set
    // lives in the DB and can change without a deploy, EXTRACTION_VERSION alone
    // no longer identifies the prompt — two calls can share a version and have
    // been scored by different examples.
    calibration_set_hash: varchar("calibration_set_hash", { length: 64 }),
    // The band a human reviewer says this call really was. Deliberately SEPARATE
    // from `band`, which stays the AI's answer forever: overwriting it would let
    // the eval harness replay the human's own correction as the AI's output and
    // report perfect agreement on every corrected call.
    human_band: varchar("human_band", { length: 20 }),
    human_reviewed_by: uuid("human_reviewed_by"),
    human_reviewed_at: timestamp("human_reviewed_at", { withTimezone: true }),
    // E-267 — `transcript_turns jsonb` is DELIBERATELY ABSENT from this object,
    // the same rule E-250/E-242/E-224/E-236 follow. Drizzle names every column
    // of a mirrored table in its generated SQL, so declaring it here would make
    // all 21 aiCallLogs call sites — including three bare `db.insert()` on the
    // call-finalize path — hard-fail with `column "transcript_turns" does not
    // exist` on any database where E-267 has not been applied. Since there is
    // no auto-runner and the per-environment ticks drift, that would trade one
    // dark metric for the entire AI call-logging pipeline. It is written
    // instead by a guarded raw UPDATE in elevenlabs/finalizeCall.ts, which
    // confines an unapplied E-267 to the feature that needs it.
  },
  (table) => {
    return {
      aiCallLogsLeadIdIdx: index("ai_call_logs_lead_id_idx").on(table.lead_id),
      aiCallLogsCallIdIdx: index("ai_call_logs_call_id_idx").on(table.call_id),
      aiCallLogsStartedAtIdx: index("ai_call_logs_started_at_idx").on(table.started_at),
    };
  },
);

// =============================================================================
// E-159 — Intent-score human feedback (the "this score is wrong" correction)
// A reviewer can correct an AI intent score from the transcript drawer. Every
// correction snapshots what the AI produced (original_intent_score +
// original_signals + scoring_version) and records the human's ground truth:
//   - corrected_status   — always set (quick mode): qualified|warm|cold|disqualified
//   - corrected_score     — optional explicit number
//   - corrected_signals   — optional per-signal fixes (deep mode), shaped like
//                           ai_call_logs.signals (IntentSignals)
// These rows ARE the benchmark/golden set: the eval harness (scripts/intent)
// replays them to measure label accuracy + locate where extraction over-reads,
// and the calibration / weight-tuning levers learn from them. Append-only — a
// re-correction of the same call inserts a new row (latest by created_at wins).
// =============================================================================
export const intentScoreFeedback = pgTable(
  "intent_score_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // ai_call_logs.call_id of the corrected call (drawer's bolnaCallId).
    call_id: varchar("call_id", { length: 255 }).notNull(),
    lead_id: varchar("lead_id", { length: 255 }),
    // Scoring version that produced the original score (audit trail).
    scoring_version: varchar("scoring_version", { length: 20 }),
    original_intent_score: integer("original_intent_score"),
    original_signals: jsonb("original_signals"),
    // Human ground-truth label — always present (quick mode).
    corrected_status: varchar("corrected_status", { length: 20 }).notNull(),
    // Optional explicit number the reviewer believes is right.
    corrected_score: integer("corrected_score"),
    // Optional per-signal corrections (deep mode), shaped like IntentSignals.
    corrected_signals: jsonb("corrected_signals"),
    reviewer_note: text("reviewer_note"),
    reviewed_by: uuid("reviewed_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // --- E-250 ---
    // The AI's BAND at correction time. E-159 snapshotted original_intent_score
    // but not the band, so "did the human agree" could only be reconstructed by
    // re-deriving it from the score — which breaks the moment BAND_LEAD_SCORE
    // changes.
    ai_band: varchar("ai_band", { length: 20 }),
    // The reviewer's role AT REVIEW TIME. Stored rather than joined because roles
    // change: an ASM promoted to sales_head would otherwise retroactively rewrite
    // the provenance of every correction they ever made.
    reviewer_role: varchar("reviewer_role", { length: 50 }),
    // 'correction' carries a real human label and is eligible for the golden set.
    // 'note' is prose with no parseable band (the Google Sheet import). Every
    // consumer filters to 'correction' so notes never fabricate ground truth.
    review_kind: varchar("review_kind", { length: 20 }).default("correction").notNull(),
    // 'app' | 'sheet_import'
    source: varchar("source", { length: 20 }).default("app").notNull(),
    // Idempotency key for imported rows: 'sheet:<call_id>:<reviewer>'. NULL for
    // app corrections. ⚠ ON CONFLICT against its PARTIAL unique index must repeat
    // the `WHERE external_key IS NOT NULL` predicate or Postgres won't match it.
    external_key: text("external_key"),
    // lead_call_recordings.id when the reviewer attached audio instead of typing.
    recording_id: uuid("recording_id"),
    // Did the human land on the same band as the AI. Stored so the disagreement
    // queue is an index scan, not a case-expression over every row.
    agreed: boolean("agreed"),
    // Was this written THROUGH to dealer_leads, or recorded as training only.
    // False for imported Sheet history — replaying months-old commentary onto
    // live leads would rewrite the pipeline from an archive.
    applied_to_lead: boolean("applied_to_lead").default(false).notNull(),
    applied_at: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => ({
    callIdIdx: index("intent_score_feedback_call_id_idx").on(table.call_id),
    leadIdIdx: index("intent_score_feedback_lead_id_idx").on(table.lead_id),
    createdAtIdx: index("intent_score_feedback_created_at_idx").on(
      table.created_at,
    ),
  }),
);

// =============================================================================
// E-250 — Attached call recordings.
//
// One audio file a reviewer attached to a dealer lead, plus its transcription
// job and the signals/band derived from it. THIS TABLE IS ITS OWN QUEUE: one
// recording is one transcription job, one-to-one, so a separate job table (the
// shape E-241 needed for the scraper) would be a join with no cardinality
// behind it. Drained by startRecordingTranscriptionTicker() in
// src/instrumentation-node.ts, which claims with FOR UPDATE SKIP LOCKED.
//
// Attaching audio does NOT move the lead. The recording gets its own band; a
// human still has to accept it by submitting a correction.
// =============================================================================
export const leadCallRecordings = pgTable(
  "lead_call_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // dealer_leads.id — soft FK, varchar to match that table's text id (same
    // shape ai_call_logs.lead_id uses).
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    // ai_call_logs.call_id when this audio belongs to an existing AI call. NULL
    // for a human follow-up the dialer never made.
    call_id: varchar("call_id", { length: 255 }),
    // human_call     — a follow-up the user recorded: transcribe and score it
    //                  through the SAME analyzeTranscript() the dialer uses.
    // ai_reanalysis  — the provider transcript was garbled; re-transcribe the
    //                  stored audio rather than trusting its text.
    // evidence       — stored and playable as proof behind a correction, never
    //                  transcribed (goes straight to status 'skipped').
    purpose: varchar("purpose", { length: 20 }).default("human_call").notNull(),

    // Key under the 'call-recordings' LOGICAL bucket (a key prefix in the one
    // physical AWS_S3_BUCKET — see src/lib/storage/s3.ts). Served back through
    // /api/files/call-recordings/<key>, already an allowed AND auth-required
    // bucket, so no new serving route was needed.
    s3_key: text("s3_key").notNull(),
    content_type: varchar("content_type", { length: 100 }),
    // Capped at 25 MB on upload — not arbitrary: OpenAI's transcription endpoint
    // rejects anything larger, so a bigger file could be stored but never
    // transcribed. ~50 minutes at 64 kbps m4a.
    size_bytes: bigint("size_bytes", { mode: "number" }),
    duration_sec: integer("duration_sec"),
    original_filename: text("original_filename"),

    // ── Transcription lifecycle (the queue) ──
    // pending | running | done | failed | skipped. No enum — the vocabulary lives
    // in src/lib/ai/transcription/ and is enforced by zod at the write path.
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    // ⚠ Always SET from now() + an interval IN SQL, never from a JS Date: pm2
    // clock drift, and a JS Date in a raw drizzle sql`` template throws
    // ERR_INVALID_ARG_TYPE at runtime.
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    error: text("error"),

    // ── What came back ──
    transcript: text("transcript"),
    // Timestamped segments when the model returns them. NULL under the default
    // gpt-4o-transcribe (text only); populated when INTENT_TRANSCRIBE_MODEL is
    // whisper-1, which supports verbose_json.
    transcript_segments: jsonb("transcript_segments"),
    language: varchar("language", { length: 20 }),
    transcribe_model: varchar("transcribe_model", { length: 50 }),

    // ── What the scoring engine made of it ──
    signals: jsonb("signals"),
    score_breakdown: jsonb("score_breakdown"),
    band: varchar("band", { length: 20 }),
    intent_score: integer("intent_score"),
    info_signals_count: integer("info_signals_count"),
    call_summary: text("call_summary"),
    scoring_version: varchar("scoring_version", { length: 20 }),
    extraction_version: varchar("extraction_version", { length: 40 }),

    uploaded_by: uuid("uploaded_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    transcribed_at: timestamp("transcribed_at", { withTimezone: true }),
  },
  (table) => ({
    claimIdx: index("lead_call_recordings_claim_idx").on(table.next_attempt_at),
    leadIdx: index("lead_call_recordings_lead_idx").on(
      table.lead_id,
      table.created_at,
    ),
    callIdx: index("lead_call_recordings_call_idx").on(table.call_id),
  }),
);

// =============================================================================
// E-250 — DB-driven calibration examples.
//
// Admin-promoted few-shot examples injected into the extraction prompt AT
// RUNTIME (src/lib/ai/analysis/calibrationStore.ts). This replaces the
// hand-authored array in calibrationExamples.ts as the source of NEW teaching —
// that array stays as the built-in SEED, and the loader falls back to it
// whenever this table is empty or unreachable, so a DB problem degrades the
// prompt to today's behaviour rather than sending an example-less prompt.
// =============================================================================
export const intentCalibrationExamples = pgTable(
  "intent_calibration_examples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Shown TO THE MODEL as the example's heading — part of the prompt, not an
    // internal note. This is the sentence that actually does the teaching.
    why: text("why").notNull(),
    transcript: text("transcript").notNull(),
    // The CORRECT QualificationSignals for this transcript, shaped like
    // ai_call_logs.signals.
    signals: jsonb("signals").notNull(),
    // Only active rows enter the prompt. Deactivating is the instant undo for a
    // bad example — effective on the next cache expiry, no deploy. That is the
    // whole reason this set moved out of TypeScript.
    active: boolean("active").default(true).notNull(),
    // Prompt order, ascending. Few-shot examples are read in sequence and the
    // last ones carry the most weight, so the curator controls which rule the
    // model sees last.
    sort_order: integer("sort_order").default(100).notNull(),
    source_feedback_id: uuid("source_feedback_id"),
    source_call_id: varchar("source_call_id", { length: 255 }),
    extraction_version: varchar("extraction_version", { length: 20 }),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    activeIdx: index("intent_calibration_examples_active_idx").on(
      table.sort_order,
      table.created_at,
    ),
  }),
);

// --- AI CALLS ---

export const callSessions = pgTable("call_sessions", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }),
  initiated_by: uuid("initiated_by"),
  status: varchar({ length: 20 }).default('initiated'),
  provider: varchar({ length: 50 }),
  provider_session_id: text("provider_session_id"),
  started_at: timestamp("started_at", { withTimezone: true }),
  ended_at: timestamp("ended_at", { withTimezone: true }),
  duration_seconds: integer("duration_seconds"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  session_id: text("session_id"),
});

export const callRecords = pgTable("call_records", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }),
  session_id: varchar("session_id", { length: 255 }),
  recording_url: text("recording_url"),
  transcript: text(),
  summary: text(),
  sentiment: varchar({ length: 20 }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  bolna_call_id: varchar("bolna_call_id", { length: 255 }),
  status: text().default('queued'),
  duration_seconds: integer("duration_seconds"),
  ended_at: timestamp("ended_at", { withTimezone: true }),
});

export const conversationMessages = pgTable("conversation_messages", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  call_record_id: varchar("call_record_id", { length: 255 }).notNull(),
  role: text().notNull(),
  message: text().notNull(),
  timestamp: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// --- RELATIONS ---

export const productCategoriesRelations = relations(
  productCategories,
  ({ many }) => ({
    products: many(products),
  }),
);

export const productsRelations = relations(products, ({ one, many }) => ({
  category: one(productCategories, {
    fields: [products.category_id],
    references: [productCategories.id],
  }),
  inventories: many(inventory),
}));

export const usersRelations = relations(users, ({ many }) => ({
  oemsCreated: many(oems, { relationName: "oem_creator" }),
  inventoryCreated: many(inventory, { relationName: "inventory_creator" }),
  leadsUploaded: many(dealerLeads, { relationName: "lead_uploader" }),
  assignmentsReceived: many(leadAssignments, {
    relationName: "assigned_to_user",
  }),
  assignmentsGiven: many(leadAssignments, { relationName: "assigned_by_user" }),
  dealsCreated: many(deals, { relationName: "deal_creator" }),
  approvalsHandled: many(approvals, { relationName: "approver_user" }),
  slasAssigned: many(slas, { relationName: "sla_assigned" }),
  slasEscalatedTo: many(slas, { relationName: "sla_escalated" }),
  leadsQualified: many(dealerLeads, { relationName: "qualified_by_user" }),
  pdiInspections: many(pdiRecords, { relationName: "pdi_service_engineer" }),
  campaigns: many(campaigns),
  loanApplications: many(loanApplications),
}));

export const oemsRelations = relations(oems, ({ one, many }) => ({
  creator: one(users, {
    fields: [oems.created_by],
    references: [users.id],
    relationName: "oem_creator",
  }),
  contacts: many(oemContacts),
}));

export const oemContactsRelations = relations(oemContacts, ({ one }) => ({
  oem: one(oems, { fields: [oemContacts.oem_id], references: [oems.id] }),
}));

export const inventoryRelations = relations(inventory, ({ one }) => ({
  product: one(products, {
    fields: [inventory.product_id],
    references: [products.id],
  }),
  creator: one(users, {
    fields: [inventory.created_by],
    references: [users.id],
    relationName: "inventory_creator",
  }),
}));

// export const leadsRelations = relations(leads, ({ one, many }) => ({
//   uploader: one(users, {
//     fields: [leads.uploader_id],
//     references: [users.id],
//     relationName: "lead_uploader",
//   }),
//   qualifiedBy: one(users, {
//     fields: [leads.qualified_by],
//     references: [users.id],
//     relationName: "qualified_by_user",
//   }),
//   assignments: many(leadAssignments),
//   deals: many(deals),
//   bolnaCalls: many(bolnaCalls),
//   aiCallLogs: many(aiCallLogs),
//   loanApplications: many(loanApplications),
//   kycDocuments: many(kycDocuments),
//   kycVerifications: many(kycVerifications),
//   consentRecords: many(consentRecords),
//   coBorrowers: many(coBorrowers),
//   deployedAssets: many(deployedAssets),
//   loanFiles: many(loanFiles),
// }));

export const leadAssignmentsRelations = relations(
  leadAssignments,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [leadAssignments.lead_id],
      references: [dealerLeads.id],
    }),
    owner: one(users, {
      fields: [leadAssignments.lead_owner],
      references: [users.id],
      relationName: "assigned_to_user",
    }),
    assigner: one(users, {
      fields: [leadAssignments.assigned_by],
      references: [users.id],
      relationName: "assigned_by_user",
    }),
    actor: one(users, {
      fields: [leadAssignments.lead_actor],
      references: [users.id],
      relationName: "lead_actor_user",
    }),
    actorAssigner: one(users, {
      fields: [leadAssignments.actor_assigned_by],
      references: [users.id],
      relationName: "actor_assigned_by_user",
    }),
  }),
);

export const dealsRelations = relations(deals, ({ one, many }) => ({
  lead: one(dealerLeads, {
    fields: [deals.lead_id],
    references: [dealerLeads.id],
  }),
  creator: one(users, {
    fields: [deals.created_by],
    references: [users.id],
    relationName: "deal_creator",
  }),
  approvals: many(approvals),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  approver: one(users, {
    fields: [approvals.approver_id],
    references: [users.id],
    relationName: "approver_user",
  }),
}));

export const slasRelations = relations(slas, ({ one }) => ({
  assignedUser: one(users, {
    fields: [slas.assigned_to],
    references: [users.id],
    relationName: "sla_assigned",
  }),
  escalatedUser: one(users, {
    fields: [slas.escalated_to],
    references: [users.id],
    relationName: "sla_escalated",
  }),
}));

export const provisionsRelations = relations(provisions, ({ one, many }) => ({
  oem: one(oems, { fields: [provisions.oem_id], references: [oems.id] }),
  creator: one(users, {
    fields: [provisions.created_by],
    references: [users.id],
  }),
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one }) => ({
  provision: one(provisions, {
    fields: [orders.provision_id],
    references: [provisions.id],
  }),
  oem: one(oems, { fields: [orders.oem_id], references: [oems.id] }),
  creator: one(users, { fields: [orders.created_by], references: [users.id] }),
  account: one(accounts, {
    fields: [orders.account_id],
    references: [accounts.id],
  }),
}));

export const oemInventoryForPDIRelations = relations(
  oemInventoryForPDI,
  ({ one }) => ({
    inventory: one(inventory, {
      fields: [oemInventoryForPDI.inventory_id],
      references: [inventory.id],
    }),
    oem: one(oems, {
      fields: [oemInventoryForPDI.oem_id],
      references: [oems.id],
    }),
    pdiRecord: one(pdiRecords, {
      fields: [oemInventoryForPDI.pdi_record_id],
      references: [pdiRecords.id],
    }),
  }),
);

// NOTE: pdiRecords.oem_inventory_id / serviceEngineerId columns don't exist in the
// live DB. Relation commented out until those columns are added.
export const pdiRecordsRelations = relations(pdiRecords, ({ one }) => ({}));

export const assignmentChangeLogsRelations = relations(
  assignmentChangeLogs,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [assignmentChangeLogs.lead_id],
      references: [dealerLeads.id],
    }),
    oldUser: one(users, {
      fields: [assignmentChangeLogs.old_user_id],
      references: [users.id],
    }),
    newUser: one(users, {
      fields: [assignmentChangeLogs.new_user_id],
      references: [users.id],
    }),
    changedBy: one(users, {
      fields: [assignmentChangeLogs.changed_by],
      references: [users.id],
    }),
  }),
);

export const orderDisputesRelations = relations(orderDisputes, ({ one }) => ({
  order: one(orders, {
    fields: [orderDisputes.order_id],
    references: [orders.id],
  }),
  resolvedBy: one(users, {
    fields: [orderDisputes.resolved_by],
    references: [users.id],
  }),
  // NOTE: orderDisputes.created_by column doesn't exist in live DB; relation omitted.
}));

export const accountsRelations = relations(accounts, ({ many }) => ({
  orders: many(orders),
}));

export const bolnaCallsRelations = relations(bolnaCalls, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [bolnaCalls.lead_id],
    references: [dealerLeads.id],
  }),
}));

export const aiCallLogsRelations = relations(aiCallLogs, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [aiCallLogs.lead_id],
    references: [dealerLeads.id],
  }),
}));
export const callSessionsRelations = relations(callSessions, ({ many }) => ({
  records: many(callRecords),
}));

export const callRecordsRelations = relations(callRecords, ({ one, many }) => ({
  session: one(callSessions, {
    fields: [callRecords.session_id],
    references: [callSessions.session_id],
  }),
  lead: one(dealerLeads, {
    fields: [callRecords.lead_id],
    references: [dealerLeads.id],
  }),
  messages: many(conversationMessages),
}));

export const conversationMessagesRelations = relations(
  conversationMessages,
  ({ one }) => ({
    record: one(callRecords, {
      fields: [conversationMessages.call_record_id],
      references: [callRecords.id],
    }),
  }),
);

// --- DEALER ADDITIONS (SOP Refinements) ---

export const campaigns = pgTable("campaigns", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  name: text().notNull(),
  type: varchar({ length: 20 }).notNull(),
  message_content: text("message_content"),
  audience_filter: jsonb("audience_filter"),
  total_audience: integer("total_audience"),
  status: varchar({ length: 20 }).default('draft').notNull(),
  sent_count: integer("sent_count").default(0),
  delivered_count: integer("delivered_count").default(0),
  failed_count: integer("failed_count").default(0),
  scheduled_at: timestamp("scheduled_at", { withTimezone: true }),
  sent_at: timestamp("sent_at", { withTimezone: true }),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  cost: numeric({ precision: 10, scale:  2 }),
  started_at: timestamp("started_at", { withTimezone: true }),
});

// For "Process Loan" workflow tracking
export const loanApplications = pgTable("loan_applications", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  dealer_id: varchar("dealer_id", { length: 255 }),
  applicant_name: text("applicant_name"),
  loan_amount: numeric("loan_amount", { precision: 12, scale:  2 }),
  interest_rate: numeric("interest_rate", { precision: 5, scale:  2 }),
  tenure_months: integer("tenure_months"),
  emi_amount: numeric("emi_amount", { precision: 10, scale:  2 }),
  down_payment: numeric("down_payment", { precision: 12, scale:  2 }),
  facilitation_fee: numeric("facilitation_fee", { precision: 10, scale:  2 }),
  facilitation_fee_status: varchar("facilitation_fee_status", { length: 20 }).default('pending'),
  documents_uploaded: boolean("documents_uploaded").default(false),
  status: varchar({ length: 30 }).default('draft'),
  nbfc_name: text("nbfc_name"),
  nbfc_ref_id: text("nbfc_ref_id"),
  submitted_at: timestamp("submitted_at", { withTimezone: true }),
  approved_at: timestamp("approved_at", { withTimezone: true }),
  disbursed_at: timestamp("disbursed_at", { withTimezone: true }),
  rejection_reason: text("rejection_reason"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  company_validation_status: varchar("company_validation_status", { length: 20 }).default('pending').notNull(),
  application_status: varchar("application_status", { length: 20 }).default('new').notNull(),
  facilitation_fee_amount: numeric("facilitation_fee_amount", { precision: 10, scale:  2 }),
  created_by: uuid("created_by"),
});

// --- KYC MODULE ---

export const kycDocuments = pgTable(
  "kyc_documents",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    doc_type: varchar("doc_type", { length: 50 }).notNull(),
    file_url: text("file_url"),
    verification_status: varchar("verification_status", { length: 30 }).default('pending'),
    ocr_data: jsonb("ocr_data"),
    api_response: jsonb("api_response"),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
    verified_at: timestamp("verified_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    file_name: text("file_name"),
    file_size: integer("file_size"),
    failed_reason: text("failed_reason"),
    file_type: varchar("file_type", { length: 50 }),
    doc_status: varchar("doc_status", { length: 30 }).default('not_uploaded'),
    rejection_reason: text("rejection_reason"),
    uploaded_by: uuid("uploaded_by"),
    verified_by: uuid("verified_by"),
    doc_for: varchar("doc_for", { length: 20 }).default('customer').notNull(),
    // E-091 — DPDPA retention: when a KYC document is purged after the 7y
    // RBI/IT-Act retention window, we keep the row (so foreign keys to lead
    // remain intact) but null all PII columns and flip `purged` to true.
    purged: boolean("purged").default(false).notNull(),
    purged_at: timestamp("purged_at", { withTimezone: true }),
  },
  (table) => {
    return {
      kycDocsLeadIdx: index("kyc_documents_lead_id_idx").on(table.lead_id),
      kycDocsTypeIdx: index("kyc_documents_doc_type_idx").on(table.doc_type),
    };
  },
);

export const kycVerifications = pgTable(
  "kyc_verifications",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    verification_type: varchar("verification_type", { length: 50 }).notNull(),
    status: varchar({ length: 30 }).default('pending'),
    api_provider: varchar("api_provider", { length: 50 }),
    api_request: jsonb("api_request"),
    api_response: jsonb("api_response"),
    failed_reason: text("failed_reason"),
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    match_score: numeric("match_score", { precision: 5, scale:  2 }),
    retry_count: integer("retry_count").default(0),
    admin_action: varchar("admin_action", { length: 30 }),
    admin_action_by: uuid("admin_action_by"),
    admin_action_at: timestamp("admin_action_at", { withTimezone: true }),
    admin_action_notes: text("admin_action_notes"),
    // E-246 — 'admin' (a human clicked Accept/Reject) | 'system' (the KYC
    // auto-approval SLA sweep accepted it WITHOUT calling the provider).
    // admin_action_by is NULL for a system action, but NULL is also what
    // legacy rows carry, so this is the only reliable discriminator.
    admin_action_source: varchar("admin_action_source", { length: 16 }).default('admin'),
    verification_for: varchar("verification_for", { length: 20 }).default('customer').notNull(),
    applicant: varchar({ length: 20 }).default('primary').notNull(),
  },
  (table) => {
    return {
      kycVerLeadIdx: index("kyc_verifications_lead_id_idx").on(table.lead_id),
      kycVerTypeIdx: index("kyc_verifications_type_idx").on(
        table.verification_type,
      ),
    };
  },
);

// --- DIGILOCKER TRANSACTIONS ---

export const digilockerTransactions = pgTable(
  "digilocker_transactions",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    verification_id: varchar("verification_id", { length: 255 }),
    reference_id: varchar("reference_id", { length: 255 }),
    decentro_txn_id: varchar("decentro_txn_id", { length: 255 }),
    session_id: varchar("session_id", { length: 255 }),
    status: varchar({ length: 50 }).default('initiated').notNull(),
    customer_phone: varchar("customer_phone", { length: 20 }),
    customer_email: varchar("customer_email", { length: 255 }),
    digilocker_url: text("digilocker_url"),
    short_url: text("short_url"),
    notification_channel: varchar("notification_channel", { length: 20 }).default('sms'),
    link_sent_at: timestamp("link_sent_at", { withTimezone: true }),
    link_opened_at: timestamp("link_opened_at", { withTimezone: true }),
    customer_authorized_at: timestamp("customer_authorized_at", { withTimezone: true }),
    digilocker_raw_response: jsonb("digilocker_raw_response"),
    aadhaar_extracted_data: jsonb("aadhaar_extracted_data"),
    cross_match_result: jsonb("cross_match_result"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    sms_message_id: varchar("sms_message_id", { length: 255 }),
    sms_delivered_at: timestamp("sms_delivered_at", { withTimezone: true }),
    sms_failed_reason: text("sms_failed_reason"),
    sms_attempts: integer("sms_attempts").default(0).notNull(),
    aadhaar_pdf: bytea("aadhaar_pdf"),
  },
  (table) => ({
    digilockerLeadIdx: index("digilocker_transactions_lead_idx").on(
      table.lead_id,
    ),
    digilockerTxnIdx: index("digilocker_transactions_txn_idx").on(
      table.decentro_txn_id,
    ),
    digilockerStatusIdx: index("digilocker_transactions_status_idx").on(
      table.status,
    ),
  }),
);

// --- KYC DATA AUDIT (BRD Section 8) ---

export const kycDataAudit = pgTable(
  "kyc_data_audit",
  {
    id: serial().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }),
    field_name: varchar("field_name", { length: 50 }),
    field_value: varchar("field_value", { length: 500 }),
    data_source: varchar("data_source", { length: 20 }),
    entered_by: uuid("entered_by"),
    entered_at: timestamp("entered_at", { withTimezone: true }).defaultNow(),
    reason: text(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    kycDataAuditLeadIdx: index("kyc_data_audit_lead_idx").on(table.lead_id),
  }),
);

export const consentRecords = pgTable("consent_records", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  consent_type: varchar("consent_type", { length: 30 }).notNull(),
  channel: varchar({ length: 20 }),
  consent_token: text("consent_token"),
  consent_link_url: text("consent_link_url"),
  consent_status: varchar("consent_status", { length: 20 }).default('awaiting_signature'),
  signed_at: timestamp("signed_at", { withTimezone: true }),
  generated_pdf_url: text("generated_pdf_url"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  consent_for: varchar("consent_for", { length: 20 }).default('primary').notNull(),
  consent_link_sent_at: timestamp("consent_link_sent_at", { withTimezone: true }),
  signed_consent_url: text("signed_consent_url"),
  verified_by: uuid("verified_by"),
  verified_at: timestamp("verified_at", { withTimezone: true }),
  // E-246 — 'admin' (KYC review panel) | 'system' (auto-verified by the sweep).
  verification_source: varchar("verification_source", { length: 16 }).default('admin'),
  // E-247 — the consent auto-verify deadline, STAMPED when the consent enters a
  // signed-but-unverified state. NULL = never auto-verify, which is what stops
  // enabling the feature from reaching back over old consents. Do not backfill.
  // NOTE the sweep's partial index (consent_records_auto_verify_due_idx) is
  // migration-only; drizzle's index builder has no WHERE clause.
  auto_verify_due_at: timestamp("auto_verify_due_at", { withTimezone: true }),
  consent_link_expires_at: timestamp("consent_link_expires_at", { withTimezone: true }),
  consent_delivery_channel: varchar("consent_delivery_channel", { length: 20 }),
  sign_method: varchar("sign_method", { length: 30 }),
  esign_transaction_id: varchar("esign_transaction_id", { length: 255 }),
  esign_certificate_id: varchar("esign_certificate_id", { length: 255 }),
  esign_provider: varchar("esign_provider", { length: 50 }),
  esign_error_code: varchar("esign_error_code", { length: 50 }),
  esign_error_message: text("esign_error_message"),
  signer_aadhaar_masked: varchar("signer_aadhaar_masked", { length: 20 }),
  // Digio's name-match score (0-100) comparing the Aadhaar-holder name to the
  // registered signer name — a secondary signal surfaced to admins (E-176).
  signer_name_match_score: integer("signer_name_match_score"),
  rejected_by: uuid("rejected_by"),
  rejected_at: timestamp("rejected_at", { withTimezone: true }),
  rejection_reason: varchar("rejection_reason", { length: 255 }),
  reviewer_notes: text("reviewer_notes"),
  consent_attempt_count: integer("consent_attempt_count").default(0),
  esign_retry_count: integer("esign_retry_count").default(0),
  admin_viewed_by: uuid("admin_viewed_by"),
  admin_viewed_at: timestamp("admin_viewed_at", { withTimezone: true }),
  // E-180: OTP-based consent audit pointers (the OTP session itself lives in
  // consent_otp_verifications). Set when a consent is captured via OTP.
  otp_verification_id: uuid("otp_verification_id"),
  otp_verified_at: timestamp("otp_verified_at", { withTimezone: true }),
  // E-206: which NBFC tenant captured this consent (Acquire "run consent yourself"
  // flow). NULL ⇒ iTarang/dealer-captured. The NBFC's DPDP card filters to its own
  // tenant so it never sees iTarang's customer/co-borrower consent.
  initiated_by_tenant_id: uuid("initiated_by_tenant_id"),
});

// E-180: OTP sessions for OTP-based customer consent (replaces Digio Aadhaar
// e-sign). Matched by (lead_id, consent_for); mirrors calc_otp_verifications.
export const consentOtpVerifications = pgTable(
  "consent_otp_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    consentFor: varchar("consent_for", { length: 20 }).default('primary').notNull(), // 'primary' | 'co_borrower'
    consentRecordId: varchar("consent_record_id", { length: 255 }),
    requestedBy: uuid("requested_by"),
    phone: text("phone").notNull(), // normalized digits: 91XXXXXXXXXX
    deliveryChannel: varchar("delivery_channel", { length: 20 }), // 'sms' | 'whatsapp'
    otpHash: text("otp_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sendCount: integer("send_count").default(1).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    deliveryStatus: text("delivery_status"), // 'sent' | 'dev_hardcoded' | 'failed'
  },
  (t) => ({
    lookupIdx: index("consent_otp_verif_lookup_idx").on(t.leadId, t.consentFor, t.createdAt),
  }),
);

export const couponCodes = pgTable("coupon_codes", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  code: varchar({ length: 50 }).notNull(),
  dealer_id: varchar("dealer_id", { length: 255 }),
  is_used: boolean("is_used").default(false),
  used_by_lead_id: varchar("used_by_lead_id", { length: 255 }),
  used_at: timestamp("used_at", { withTimezone: true }),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar({ length: 20 }).default('available').notNull(),
  credits_available: integer("credits_available").default(1),
  used_by: uuid("used_by"),
  validated_at: timestamp("validated_at", { withTimezone: true }),
  discount_type: varchar("discount_type", { length: 20 }).default('flat'),
  discount_value: numeric("discount_value", { precision: 10, scale:  2 }).default('0'),
  max_discount_cap: numeric("max_discount_cap", { precision: 10, scale:  2 }),
  min_amount: numeric("min_amount", { precision: 10, scale:  2 }),
  batch_id: varchar("batch_id", { length: 255 }),
  reserved_at: timestamp("reserved_at", { withTimezone: true }),
  reserved_by: uuid("reserved_by"),
  reserved_for_lead_id: varchar("reserved_for_lead_id", { length: 255 }),
});

// --- COUPON BATCHES ---

export const couponBatches = pgTable(
  "coupon_batches",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    dealer_id: varchar("dealer_id", { length: 255 }).notNull(),
    prefix: varchar({ length: 20 }).notNull(),
    coupon_value: numeric("coupon_value", { precision: 10, scale:  2 }).default('0').notNull(),
    total_quantity: integer("total_quantity").notNull(),
    expiry_date: timestamp("expiry_date", { withTimezone: true }),
    status: varchar({ length: 20 }).default('active').notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    batchDealerIdx: index("coupon_batches_dealer_idx").on(table.dealer_id),
    batchStatusIdx: index("coupon_batches_status_idx").on(table.status),
  }),
);

// --- COUPON AUDIT LOG ---

export const couponAuditLog = pgTable(
  "coupon_audit_log",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    coupon_id: varchar("coupon_id", { length: 255 }).notNull(),
    action: varchar({ length: 20 }).notNull(),
    old_status: varchar("old_status", { length: 20 }),
    new_status: varchar("new_status", { length: 20 }),
    lead_id: varchar("lead_id", { length: 255 }),
    performed_by: uuid("performed_by"),
    ip_address: varchar("ip_address", { length: 45 }),
    notes: text(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    auditCouponIdx: index("coupon_audit_log_coupon_idx").on(
      table.coupon_id,
      table.created_at,
    ),
    auditActionIdx: index("coupon_audit_log_action_idx").on(table.action),
  }),
);

// --- FACILITATION PAYMENTS ---

export const facilitationPayments = pgTable(
  "facilitation_payments",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    payment_method: varchar("payment_method", { length: 30 }),
    facilitation_fee_base_amount: numeric("facilitation_fee_base_amount", { precision: 10, scale:  2 }).default('1500.00').notNull(),
    coupon_code: varchar("coupon_code", { length: 50 }),
    coupon_id: varchar("coupon_id", { length: 255 }),
    coupon_discount_type: varchar("coupon_discount_type", { length: 20 }),
    coupon_discount_value: numeric("coupon_discount_value", { precision: 10, scale:  2 }),
    coupon_discount_amount: numeric("coupon_discount_amount", { precision: 10, scale:  2 }).default('0'),
    facilitation_fee_final_amount: numeric("facilitation_fee_final_amount", { precision: 10, scale:  2 }).notNull(),
    razorpay_qr_id: varchar("razorpay_qr_id", { length: 255 }),
    razorpay_qr_status: varchar("razorpay_qr_status", { length: 30 }),
    razorpay_qr_image_url: text("razorpay_qr_image_url"),
    razorpay_qr_short_url: text("razorpay_qr_short_url"),
    razorpay_qr_expires_at: timestamp("razorpay_qr_expires_at", { withTimezone: true }),
    razorpay_payment_id: varchar("razorpay_payment_id", { length: 255 }),
    razorpay_order_id: varchar("razorpay_order_id", { length: 255 }),
    razorpay_payment_status: varchar("razorpay_payment_status", { length: 30 }),
    utr_number_manual: varchar("utr_number_manual", { length: 100 }),
    payment_screenshot_url: text("payment_screenshot_url"),
    facilitation_fee_status: varchar("facilitation_fee_status", { length: 30 }).default('UNPAID').notNull(),
    payment_paid_at: timestamp("payment_paid_at", { withTimezone: true }),
    payment_verified_at: timestamp("payment_verified_at", { withTimezone: true }),
    payment_verification_source: varchar("payment_verification_source", { length: 30 }),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fpLeadIdx: index("facilitation_payments_lead_id_idx").on(table.lead_id),
    fpStatusIdx: index("facilitation_payments_status_idx").on(
      table.facilitation_fee_status,
    ),
    fpQrIdx: index("facilitation_payments_rzp_qr_idx").on(table.razorpay_qr_id),
  }),
);

export const facilitationPaymentsRelations = relations(
  facilitationPayments,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [facilitationPayments.lead_id],
      references: [dealerLeads.id],
    }),
    creator: one(users, {
      fields: [facilitationPayments.created_by],
      references: [users.id],
    }),
  }),
);

// --- CO-BORROWER MODULE ---

export const coBorrowers = pgTable(
  "co_borrowers",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    full_name: text("full_name"),
    phone: varchar({ length: 20 }),
    aadhaar_no: varchar("aadhaar_no", { length: 12 }),
    pan_no: varchar("pan_no", { length: 10 }),
    dob: date(),
    relationship: varchar({ length: 50 }),
    income: numeric({ precision: 12, scale:  2 }),
    address: text(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    father_or_husband_name: text("father_or_husband_name"),
    permanent_address: text("permanent_address"),
    current_address: text("current_address"),
    is_current_same: boolean("is_current_same").default(false),
    auto_filled: boolean("auto_filled").default(false),
    kyc_status: varchar("kyc_status", { length: 30 }).default('not_started'),
    consent_status: varchar("consent_status", { length: 30 }).default('awaiting_signature'),
    verification_submitted_at: timestamp("verification_submitted_at", { withTimezone: true }),
  },
  (table) => {
    return {
      coBorrowerLeadIdx: index("co_borrowers_lead_id_idx").on(table.lead_id),
    };
  },
);

export const coBorrowerDocuments = pgTable("co_borrower_documents", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  co_borrower_id: varchar("co_borrower_id", { length: 255 }),
  document_type: varchar("document_type", { length: 50 }).notNull(),
  document_url: text("document_url"),
  status: varchar({ length: 30 }).default('pending'),
  ocr_data: jsonb("ocr_data"),
  uploaded_at: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  file_name: text("file_name"),
  file_size: integer("file_size"),
  verification_status: varchar("verification_status", { length: 30 }).default('pending'),
});

export const otherDocumentRequests = pgTable("other_document_requests", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  requested_by: uuid("requested_by"),
  doc_label: text("doc_label").notNull(),
  description: text(),
  file_url: text("file_url"),
  upload_status: varchar("upload_status", { length: 20 }).default('pending'),
  uploaded_at: timestamp("uploaded_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  upload_token: varchar("upload_token", { length: 255 }),
  token_expires_at: timestamp("token_expires_at", { withTimezone: true }),
  doc_for: varchar("doc_for", { length: 20 }).default('primary').notNull(),
  doc_key: varchar("doc_key", { length: 100 }).default('other').notNull(),
  is_required: boolean("is_required").default(true),
  rejection_reason: text("rejection_reason"),
  reviewed_by: uuid("reviewed_by"),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
  // E-246 — 'admin' | 'system' (KYC auto-approval SLA sweep).
  review_source: varchar("review_source", { length: 16 }).default('admin'),
  document_name: text("document_name"),
  document_url: text("document_url"),
  status: varchar({ length: 20 }).default('pending'),
  // E-200 — when set, this row is a child of an nbfc_doc_requests wrapper
  // (NBFC-originated). NULL for the ordinary admin→dealer request flow.
  nbfc_request_id: varchar("nbfc_request_id", { length: 255 }),
  // E-200 — origin of the request: 'admin' (default, existing flow) | 'nbfc'.
  source: varchar("source", { length: 16 }).default('admin'),
});

// E-200 — NBFC-originated request thread on the Acquire workspace. One wrapper
// row → many otherDocumentRequests children (which carry the files); a
// request_type='message' row (admin → NBFC direct, Change 3) has zero children.
// `status` is the 7-hop cycle NBFC→Admin→Dealer→Customer→Dealer→Admin→NBFC,
// derived from child min-state at hops 4–6 and stored denormalised.
export const nbfcDocRequests = pgTable(
  "nbfc_doc_requests",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(), // 'NBFCREQ-YYYYMMDD-SSSS'
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    assignment_id: uuid("assignment_id").notNull(), // nbfc_lead_assignments.id
    nbfc_id: integer("nbfc_id").notNull(), // nbfc.id (serial int)
    tenant_id: uuid("tenant_id").notNull(), // nbfc_tenants.id (session scope)
    // 'correction' | 'additional_docs' | 'step4_extra_items' | 'message'
    request_type: varchar("request_type", { length: 24 }).notNull(),
    doc_for: varchar("doc_for", { length: 20 }).default('primary').notNull(),
    target_doc_key: varchar("target_doc_key", { length: 120 }),
    nbfc_comments: text("nbfc_comments"),
    admin_notes: text("admin_notes"),
    // E-210 — documents the ADMIN uploaded with this request/message and sent
    // straight to the NBFC (list of { url, name, type, size }).
    attachments: jsonb("attachments").default(sql`'[]'::jsonb`),
    // E-210 — the NBFC verdict (nbfc_document_verifications.id) this admin reply
    // answers; NULL for a free-standing admin→NBFC message.
    verdict_id: integer("verdict_id"),
    // nbfc_raised → admin_review → forwarded_to_dealer → with_customer →
    // dealer_review → admin_review_upload → pushed_to_nbfc | closed | rejected.
    status: varchar({ length: 32 }).default('nbfc_raised').notNull(),
    // E-240 — TRUE when the NBFC sent this straight to the dealer, skipping the
    // admin forward gate. Such a wrapper has NO otherDocumentRequests children
    // (the files ride on nbfcDocRequestMessages.attachments), so
    // recomputeWrapperStatus() early-returns on it. The admin still sees the
    // thread and is still notified on both legs.
    dealer_direct: boolean("dealer_direct").default(false).notNull(),
    // E-257 — the NBFC request SLA clock. Deadline of the CURRENT leg (status
    // 'nbfc_raised' → auto-forward to dealer; 'admin_review_upload' → auto-push
    // to NBFC). Stamped on entering the leg, NULLed by any admin action or by
    // the sweep's claim. NULL = no clock. Never backfill.
    sla_due_at: timestamp("sla_due_at", { withTimezone: true }),
    // E-257 — 'admin' | 'system': who forwarded / pushed. Default 'admin'.
    forward_source: varchar("forward_source", { length: 16 }).default('admin'),
    push_source: varchar("push_source", { length: 16 }).default('admin'),
    auto_forwarded_at: timestamp("auto_forwarded_at", { withTimezone: true }),
    auto_pushed_at: timestamp("auto_pushed_at", { withTimezone: true }),
    // E-257 — last sweep error; the request stays with the admin, no retry.
    sla_failure: text("sla_failure"),
    // E-257 — structured items the NBFC asked for ([{doc_label, reason,
    // is_required}]) so an auto-forward does not have to parse nbfc_comments.
    requested_items: jsonb("requested_items").default(sql`'[]'::jsonb`),
    item_count: integer("item_count").default(0).notNull(), // ≤10 for step4_extra_items
    raised_by: uuid("raised_by").notNull(), // NBFC actor
    reviewed_by: uuid("reviewed_by"), // admin who forwarded / pushed
    // Email "act from mail" (Change 5) — sha256-hashed token + expiry.
    act_token_hash: varchar("act_token_hash", { length: 64 }),
    act_token_expires_at: timestamp("act_token_expires_at", { withTimezone: true }),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    leadStatusIdx: index("nbfc_doc_requests_lead_status_idx").on(
      table.lead_id,
      table.status,
    ),
    assignmentIdx: index("nbfc_doc_requests_assignment_idx").on(
      table.assignment_id,
    ),
    nbfcStatusIdx: index("nbfc_doc_requests_nbfc_status_idx").on(
      table.nbfc_id,
      table.status,
    ),
    verdictIdx: index("nbfc_doc_requests_verdict_idx").on(table.verdict_id),
  }),
);

// E-240 — append-only NBFC ⇄ Dealer conversation hanging off an nbfcDocRequests
// wrapper (one row per thing one party said, with any files attached). Exists
// because the wrapper holds exactly one `nbfc_comments` and one `admin_notes`,
// so a dealer reply — or a second round from either side — has nowhere to live
// without overwriting the question it answers. Same shape as E-238's
// nbfcOfferNegotiations.
export const nbfcDocRequestMessages = pgTable(
  "nbfc_doc_request_messages",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(), // 'NBFCMSG-YYYYMMDD-SSSS'
    request_id: varchar("request_id", { length: 255 }).notNull(), // nbfc_doc_requests.id
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    // 'nbfc' | 'dealer' | 'admin' — no CHECK, per the nbfc_* family convention.
    party: varchar({ length: 16 }).notNull(),
    author_user_id: uuid("author_user_id"),
    message: text("message"),
    // [{ url, name, type, size }]. A dealer reply's files are ALSO appended to
    // product_selections.pre_sanction_doc_urls, but THIS copy is canonical —
    // that bucket is capped at 10 and the cap must never block a reply.
    attachments: jsonb("attachments").default(sql`'[]'::jsonb`),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    requestCreatedIdx: index("nbfc_doc_request_messages_request_created_idx").on(
      table.request_id,
      table.created_at,
    ),
    leadIdx: index("nbfc_doc_request_messages_lead_idx").on(table.lead_id),
  }),
);

// E-201 — per-NBFC KYC verdict on each customer/co-borrower document, kept
// separate from the admin's own verification. One row per (assignment_id,
// doc_for, doc_key); upsert. Feeds the admin "NBFC KYC Verification" card.
export const nbfcDocumentVerifications = pgTable(
  "nbfc_document_verifications",
  {
    id: serial().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    assignment_id: uuid("assignment_id").notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    doc_for: varchar("doc_for", { length: 20 }).default('primary').notNull(),
    doc_key: varchar("doc_key", { length: 120 }).notNull(),
    // 'pending' | 'verified' | 'queried' | 'rejected'
    verdict: varchar({ length: 16 }).default('pending').notNull(),
    notes: text("notes"),
    // E-207 — supporting documents the NBFC attached to a verdict/rejection/
    // correction (list of { url, name, type, size }). Viewable by the admin.
    attachments: jsonb("attachments").default(sql`'[]'::jsonb`),
    verified_by: uuid("verified_by").notNull(),
    verified_at: timestamp("verified_at", { withTimezone: true }),
    // E-209 — admin "Forward to dealer" on a queried/rejected verdict. Stamps
    // the forward and links the correction wrapper (nbfc_doc_requests) it spawned.
    forwarded_at: timestamp("forwarded_at", { withTimezone: true }),
    forwarded_request_id: varchar("forwarded_request_id", { length: 255 }),
    forwarded_by: uuid("forwarded_by"),
    // E-257 — when the SLA sweep may auto-forward this queried/rejected verdict
    // to the dealer. NULL = no clock. Never backfill.
    sla_due_at: timestamp("sla_due_at", { withTimezone: true }),
    // E-257 — 'admin' | 'system': who forwarded it. Default 'admin'.
    forward_source: varchar("forward_source", { length: 16 }).default('admin'),
    sla_failure: text("sla_failure"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniqueDoc: uniqueIndex("nbfc_document_verifications_unique").on(
      table.assignment_id,
      table.doc_for,
      table.doc_key,
    ),
    leadIdx: index("nbfc_document_verifications_lead_idx").on(table.lead_id),
    nbfcIdx: index("nbfc_document_verifications_nbfc_idx").on(table.nbfc_id),
  }),
);

export const coBorrowerRequests = pgTable(
  "co_borrower_requests",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    attempt_number: integer("attempt_number").default(1).notNull(),
    reason: text(),
    status: varchar({ length: 30 }).default('open').notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    coBorrowerRequestsLeadIdx: index("co_borrower_requests_lead_id_idx").on(
      table.lead_id,
    ),
  }),
);

// E-264 — hashed, purpose-scoped magic links handed to a customer over WhatsApp
// so they can finish a step on a mobile web page without a login.
//
// This is a third token system on purpose, because neither existing one fits:
// nbfc_doc_requests.act_token_hash hashes correctly but its consumer page still
// wants an admin browser session, and other_document_requests.upload_token has
// the right no-session semantics but stores the secret in PLAINTEXT across three
// duplicated generators. This takes the hashing from the first and the audience
// from the second. The upload_token surface is deliberately left untouched.
export const leadActionTokens = pgTable(
  "lead_action_tokens",
  {
    id: uuid().primaryKey().defaultRandom().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    /** co_borrower | step4 | offers | step5 — vocabulary owned by action-token.ts */
    purpose: varchar({ length: 32 }).notNull(),
    /** sha256(raw). The raw token exists only in the WhatsApp message. */
    token_hash: varchar("token_hash", { length: 64 }).notNull(),
    audience: varchar({ length: 16 }).default('customer').notNull(),
    /** The number it was issued to — audit only; forwarding a link is normal. */
    wa_phone: varchar("wa_phone", { length: 20 }),
    ref_id: varchar("ref_id", { length: 255 }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Nullable: step4/offers links are legitimately re-openable in their window. */
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    leadActionTokensHashUnique: uniqueIndex("lead_action_tokens_hash_unique").on(
      table.token_hash,
    ),
    leadActionTokensLeadPurposeIdx: index(
      "lead_action_tokens_lead_purpose_idx",
    ).on(table.lead_id, table.purpose, table.expires_at),
  }),
);

// --- LOAN OFFERS (SM → Dealer) ---

export const loanOffers = pgTable(
  "loan_offers",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    financier_name: text("financier_name").notNull(),
    loan_amount: numeric("loan_amount", { precision: 12, scale:  2 }).notNull(),
    interest_rate: numeric("interest_rate", { precision: 5, scale:  2 }).notNull(),
    tenure_months: integer("tenure_months").notNull(),
    emi: numeric({ precision: 10, scale:  2 }).notNull(),
    processing_fee: numeric("processing_fee", { precision: 10, scale:  2 }),
    notes: text(),
    status: varchar({ length: 20 }).default('pending').notNull(),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    loanOffersLeadIdx: index("loan_offers_lead_id_idx").on(table.lead_id),
  }),
);

export const loanOffersRelations = relations(loanOffers, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [loanOffers.lead_id],
    references: [dealerLeads.id],
  }),
  creator: one(users, {
    fields: [loanOffers.created_by],
    references: [users.id],
  }),
}));

// --- ADMIN KYC REVIEW ---

export const adminKycReviews = pgTable("admin_kyc_reviews", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  review_for: varchar("review_for", { length: 20 }).default('primary').notNull(),
  document_id: varchar("document_id", { length: 255 }),
  document_type: varchar("document_type", { length: 50 }),
  outcome: varchar({ length: 20 }).notNull(),
  rejection_reason: text("rejection_reason"),
  additional_doc_requested: text("additional_doc_requested"),
  reviewer_id: uuid("reviewer_id").notNull(),
  reviewer_notes: text("reviewer_notes"),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true }).defaultNow().notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const adminVerificationQueue = pgTable(
  "admin_verification_queue",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    queue_type: varchar("queue_type", { length: 50 }).default('kyc_verification').notNull(),
    lead_id: text("lead_id").notNull(),
    priority: varchar({ length: 20 }).default('normal').notNull(),
    assigned_to: uuid("assigned_to"),
    submitted_by: uuid("submitted_by"),
    status: varchar({ length: 50 }).default('pending_itarang_verification').notNull(),
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // E-246 — the KYC auto-approval SLA clock. `sla_due_at` is stamped at
    // dealer submit as submitted_at + the configured window; NULL means never
    // auto-approve (every pre-E-246 row, and anything submitted while the
    // feature is off). `auto_approved_at` is the idempotency guard — a row is
    // claimed at most once, whatever the outcome.
    // NOTE the sweep's partial index (admin_verification_queue_sla_due_idx) is
    // migration-only; drizzle's index builder has no WHERE clause.
    sla_due_at: timestamp("sla_due_at", { withTimezone: true }),
    auto_approved_at: timestamp("auto_approved_at", { withTimezone: true }),
    auto_approval_result: varchar("auto_approval_result", { length: 24 }),
    // E-248 — per-card windows. `sla_card_due_at` is the snapshot of each
    // card's own deadline taken at submit ({aadhaar: ISO, …}); `sla_next_due_at`
    // is the earliest deadline still to act on, which the sweep selects by and
    // advances as cards mature. Both NULL on pre-E-248 rows, which fall back to
    // `sla_due_at` — never backfill either.
    sla_card_due_at: jsonb("sla_card_due_at"),
    sla_next_due_at: timestamp("sla_next_due_at", { withTimezone: true }),
  },
  (table) => ({
    adminVerificationQueueLeadIdx: index(
      "admin_verification_queue_lead_idx",
    ).on(table.lead_id),
    adminVerificationQueueStatusIdx: index(
      "admin_verification_queue_status_idx",
    ).on(table.status),
    adminVerificationQueueAssignedIdx: index(
      "admin_verification_queue_assigned_idx",
    ).on(table.assigned_to),
    adminVerificationQueueCreatedIdx: index(
      "admin_verification_queue_created_idx",
    ).on(table.created_at),
  }),
);

export const kycVerificationMetadata = pgTable(
  "kyc_verification_metadata",
  {
    lead_id: varchar("lead_id", { length: 255 }).primaryKey().notNull(),
    submission_timestamp: timestamp("submission_timestamp", { withTimezone: true }),
    case_type: varchar("case_type", { length: 20 }),
    coupon_code: varchar("coupon_code", { length: 100 }),
    coupon_status: varchar("coupon_status", { length: 30 }).default('reserved'),
    documents_count: integer("documents_count"),
    consent_verified: boolean("consent_verified").default(false),
    dealer_edits_locked: boolean("dealer_edits_locked").default(false),
    verification_started_at: timestamp("verification_started_at", { withTimezone: true }),
    first_api_execution_at: timestamp("first_api_execution_at", { withTimezone: true }),
    first_api_type: varchar("first_api_type", { length: 50 }),
    final_decision: varchar("final_decision", { length: 20 }),
    final_decision_at: timestamp("final_decision_at", { withTimezone: true }),
    final_decision_by: uuid("final_decision_by"),
    final_decision_notes: text("final_decision_notes"),
    // E-246 — 'admin' | 'system' (KYC auto-approval SLA sweep).
    final_decision_source: varchar("final_decision_source", { length: 16 }).default('admin'),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    kycVerificationMetadataCouponIdx: index(
      "kyc_verification_metadata_coupon_idx",
    ).on(table.coupon_code),
    kycVerificationMetadataStatusIdx: index(
      "kyc_verification_metadata_coupon_status_idx",
    ).on(table.coupon_status),
  }),
);

// --- DEPLOYED ASSETS MODULE ---

export const deployedAssets = pgTable(
  "deployed_assets",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    inventory_id: varchar("inventory_id", { length: 255 }).notNull(),
    lead_id: varchar("lead_id", { length: 255 }),
    deal_id: varchar("deal_id", { length: 255 }),
    dealer_id: varchar("dealer_id", { length: 255 }),
    customer_name: text("customer_name"),
    customer_phone: varchar("customer_phone", { length: 20 }),
    serial_number: varchar("serial_number", { length: 255 }),
    asset_category: varchar("asset_category", { length: 20 }),
    asset_type: varchar("asset_type", { length: 50 }),
    model_type: text("model_type"),
    deployment_date: timestamp("deployment_date", { withTimezone: true }).notNull(),
    deployment_location: text("deployment_location"),
    latitude: numeric({ precision: 10, scale:  8 }),
    longitude: numeric({ precision: 11, scale:  8 }),
    qr_code_url: text("qr_code_url"),
    qr_code_data: text("qr_code_data"),
    payment_type: varchar("payment_type", { length: 20 }),
    payment_status: varchar("payment_status", { length: 20 }).default('pending'),
    battery_health_percent: numeric("battery_health_percent", { precision: 5, scale:  2 }),
    last_voltage: numeric("last_voltage", { precision: 5, scale:  2 }),
    last_soc: integer("last_soc"),
    last_telemetry_at: timestamp("last_telemetry_at", { withTimezone: true }),
    telemetry_data: jsonb("telemetry_data"),
    total_cycles: integer("total_cycles"),
    warranty_start_date: timestamp("warranty_start_date", { withTimezone: true }),
    warranty_end_date: timestamp("warranty_end_date", { withTimezone: true }),
    // E-268 — the duration applied at dispatch, so a reader never has to
    // re-derive it from the two dates (and get month arithmetic wrong).
    warranty_months: integer("warranty_months"),
    warranty_status: varchar("warranty_status", { length: 20 }).default('active'),
    status: varchar({ length: 20 }).default('active').notNull(),
    last_maintenance_at: timestamp("last_maintenance_at", { withTimezone: true }),
    next_maintenance_due: timestamp("next_maintenance_due", { withTimezone: true }),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      deployedAssetsDealerIdx: index("deployed_assets_dealer_id_idx").on(
        table.dealer_id,
      ),
      deployedAssetsStatusIdx: index("deployed_assets_status_idx").on(
        table.status,
      ),
    };
  },
);

export const deploymentHistory = pgTable("deployment_history", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  deployed_asset_id: varchar("deployed_asset_id", { length: 255 }).notNull(),
  action: varchar({ length: 50 }).notNull(),
  description: text(),
  performed_by: uuid("performed_by").notNull(),
  metadata: jsonb(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- SERVICE MANAGEMENT MODULE ---

export const serviceTickets = pgTable(
  "service_tickets",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    deployed_asset_id: varchar("deployed_asset_id", { length: 255 }),
    dealer_id: varchar("dealer_id", { length: 255 }).notNull(),
    customer_name: text("customer_name"),
    customer_phone: varchar("customer_phone", { length: 20 }),
    issue_type: varchar("issue_type", { length: 50 }).notNull(),
    issue_description: text("issue_description").notNull(),
    priority: varchar({ length: 20 }).default('medium').notNull(),
    photos_urls: jsonb("photos_urls"),
    assigned_to: uuid("assigned_to"),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),
    status: varchar({ length: 30 }).default('open').notNull(),
    resolution_type: varchar("resolution_type", { length: 50 }),
    resolution_notes: text("resolution_notes"),
    resolved_by: uuid("resolved_by"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    sla_deadline: timestamp("sla_deadline", { withTimezone: true }),
    sla_breached: boolean("sla_breached").default(false),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      serviceTicketsDealerIdx: index("service_tickets_dealer_id_idx").on(
        table.dealer_id,
      ),
      serviceTicketsStatusIdx: index("service_tickets_status_idx").on(
        table.status,
      ),
      serviceTicketsAssetIdx: index("service_tickets_asset_id_idx").on(
        table.deployed_asset_id,
      ),
    };
  },
);

// --- LOAN MANAGEMENT MODULE (Full lifecycle) ---

export const loanFiles = pgTable(
  "loan_files",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    loan_application_id: varchar("loan_application_id", { length: 255 }),
    dealer_id: varchar("dealer_id", { length: 255 }),
    borrower_name: text("borrower_name").notNull(),
    co_borrower_name: text("co_borrower_name"),
    loan_amount: numeric("loan_amount", { precision: 12, scale:  2 }).notNull(),
    interest_rate: numeric("interest_rate", { precision: 5, scale:  2 }),
    tenure_months: integer("tenure_months"),
    emi_amount: numeric("emi_amount", { precision: 10, scale:  2 }),
    down_payment: numeric("down_payment", { precision: 12, scale:  2 }),
    processing_fee: numeric("processing_fee", { precision: 10, scale:  2 }),
    disbursal_status: varchar("disbursal_status", { length: 30 }).default('pending').notNull(),
    disbursed_amount: numeric("disbursed_amount", { precision: 12, scale:  2 }),
    disbursed_at: timestamp("disbursed_at", { withTimezone: true }),
    disbursal_reference: text("disbursal_reference"),
    total_paid: numeric("total_paid", { precision: 12, scale:  2 }).default('0'),
    total_outstanding: numeric("total_outstanding", { precision: 12, scale:  2 }),
    next_emi_date: timestamp("next_emi_date", { withTimezone: true }),
    emi_schedule: jsonb("emi_schedule"),
    overdue_amount: numeric("overdue_amount", { precision: 12, scale:  2 }).default('0'),
    overdue_days: integer("overdue_days").default(0),
    loan_status: varchar("loan_status", { length: 30 }).default('active').notNull(),
    closure_date: timestamp("closure_date", { withTimezone: true }),
    closure_type: varchar("closure_type", { length: 20 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      loanFilesDealerIdx: index("loan_files_dealer_id_idx").on(table.dealer_id),
      loanFilesStatusIdx: index("loan_files_loan_status_idx").on(
        table.loan_status,
      ),
    };
  },
);

export const loanPayments = pgTable("loan_payments", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  loan_file_id: varchar("loan_file_id", { length: 255 }).notNull(),
  payment_type: varchar("payment_type", { length: 20 }).notNull(),
  amount: numeric({ precision: 12, scale:  2 }).notNull(),
  payment_mode: varchar("payment_mode", { length: 30 }),
  transaction_id: text("transaction_id"),
  payment_date: timestamp("payment_date", { withTimezone: true }).notNull(),
  emi_month: integer("emi_month"),
  status: varchar({ length: 20 }).default('completed').notNull(),
  receipt_url: text("receipt_url"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- DEALER PROFILE ---

export const dealerSubscriptions = pgTable("dealer_subscriptions", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  dealer_id: varchar("dealer_id", { length: 255 }).notNull(),
  plan_name: varchar("plan_name", { length: 50 }).notNull(),
  status: varchar({ length: 20 }).default('active').notNull(),
  started_at: timestamp("started_at", { withTimezone: true }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  features: jsonb(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- CAMPAIGN SEGMENTS ---

export const campaignSegments = pgTable("campaign_segments", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  dealer_id: varchar("dealer_id", { length: 255 }),
  name: text().notNull(),
  description: text(),
  segment_type: varchar("segment_type", { length: 20 }).default('custom').notNull(),
  rules: jsonb(),
  logic: varchar({ length: 10 }).default('and'),
  estimated_count: integer("estimated_count"),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  is_prebuilt: boolean("is_prebuilt").default(false),
  estimated_audience: integer("estimated_audience"),
  filter_criteria: jsonb("filter_criteria"),
});

// --- RELATIONS FOR NEW TABLES ---

export const campaignsRelations = relations(campaigns, ({ one }) => ({
  creator: one(users, {
    fields: [campaigns.created_by],
    references: [users.id],
  }),
}));

export const loanApplicationsRelations = relations(
  loanApplications,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [loanApplications.lead_id],
      references: [dealerLeads.id],
    }),
    creator: one(users, {
      fields: [loanApplications.created_by],
      references: [users.id],
    }),
  }),
);

export const kycDocumentsRelations = relations(kycDocuments, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [kycDocuments.lead_id],
    references: [dealerLeads.id],
  }),
}));

export const kycVerificationsRelations = relations(
  kycVerifications,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [kycVerifications.lead_id],
      references: [dealerLeads.id],
    }),
  }),
);

export const consentRecordsRelations = relations(consentRecords, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [consentRecords.lead_id],
    references: [dealerLeads.id],
  }),
  verifier: one(users, {
    fields: [consentRecords.verified_by],
    references: [users.id],
  }),
}));

export const coBorrowersRelations = relations(coBorrowers, ({ one, many }) => ({
  lead: one(dealerLeads, {
    fields: [coBorrowers.lead_id],
    references: [dealerLeads.id],
  }),
  documents: many(coBorrowerDocuments),
}));

export const coBorrowerDocumentsRelations = relations(
  coBorrowerDocuments,
  ({ one }) => ({
    coBorrower: one(coBorrowers, {
      fields: [coBorrowerDocuments.co_borrower_id],
      references: [coBorrowers.id],
    }),
    lead: one(dealerLeads, {
      fields: [coBorrowerDocuments.lead_id],
      references: [dealerLeads.id],
    }),
  }),
);

export const deployedAssetsRelations = relations(
  deployedAssets,
  ({ one, many }) => ({
    inventory: one(inventory, {
      fields: [deployedAssets.inventory_id],
      references: [inventory.id],
    }),
    lead: one(dealerLeads, {
      fields: [deployedAssets.lead_id],
      references: [dealerLeads.id],
    }),
    deal: one(deals, {
      fields: [deployedAssets.deal_id],
      references: [deals.id],
    }),
    dealer: one(accounts, {
      fields: [deployedAssets.dealer_id],
      references: [accounts.id],
    }),
    creator: one(users, {
      fields: [deployedAssets.created_by],
      references: [users.id],
    }),
    history: many(deploymentHistory),
    serviceTickets: many(serviceTickets),
  }),
);

export const deploymentHistoryRelations = relations(
  deploymentHistory,
  ({ one }) => ({
    asset: one(deployedAssets, {
      fields: [deploymentHistory.deployed_asset_id],
      references: [deployedAssets.id],
    }),
    performer: one(users, {
      fields: [deploymentHistory.performed_by],
      references: [users.id],
    }),
  }),
);

export const serviceTicketsRelations = relations(serviceTickets, ({ one }) => ({
  asset: one(deployedAssets, {
    fields: [serviceTickets.deployed_asset_id],
    references: [deployedAssets.id],
  }),
  dealer: one(accounts, {
    fields: [serviceTickets.dealer_id],
    references: [accounts.id],
  }),
  assignee: one(users, {
    fields: [serviceTickets.assigned_to],
    references: [users.id],
  }),
  resolver: one(users, {
    fields: [serviceTickets.resolved_by],
    references: [users.id],
  }),
  creator: one(users, {
    fields: [serviceTickets.created_by],
    references: [users.id],
  }),
}));

export const loanFilesRelations = relations(loanFiles, ({ one, many }) => ({
  lead: one(dealerLeads, {
    fields: [loanFiles.lead_id],
    references: [dealerLeads.id],
  }),
  loanApplication: one(loanApplications, {
    fields: [loanFiles.loan_application_id],
    references: [loanApplications.id],
  }),
  dealer: one(accounts, {
    fields: [loanFiles.dealer_id],
    references: [accounts.id],
  }),
  payments: many(loanPayments),
}));

export const loanPaymentsRelations = relations(loanPayments, ({ one }) => ({
  loanFile: one(loanFiles, {
    fields: [loanPayments.loan_file_id],
    references: [loanFiles.id],
  }),
}));

export const campaignSegmentsRelations = relations(
  campaignSegments,
  ({ one }) => ({
    dealer: one(accounts, {
      fields: [campaignSegments.dealer_id],
      references: [accounts.id],
    }),
    creator: one(users, {
      fields: [campaignSegments.created_by],
      references: [users.id],
    }),
  }),
);

// --- INTELLICAR TELEMETRY (ORM definitions for existing tables) ---

export const deviceBatteryMap = pgTable("device_battery_map", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  device_id: varchar("device_id", { length: 100 }).notNull(),
  battery_serial: varchar("battery_serial", { length: 100 }),
  vehicle_number: varchar("vehicle_number", { length: 50 }),
  vehicle_type: varchar("vehicle_type", { length: 50 }),
  customer_name: text("customer_name"),
  customer_phone: varchar("customer_phone", { length: 20 }),
  dealer_id: varchar("dealer_id", { length: 255 }),
  // E-184 — deployment location for the Intellicar Fleet Overview State/City filters.
  state: text("state"),
  city: text("city"),
  // E-190 — logical FK to battery_spec_models.model_name; the pack model deployed here.
  battery_model: varchar("battery_model", { length: 100 }),
  status: varchar({ length: 20 }).default('active'),
  installed_at: timestamp("installed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// E-190 — per-model battery spec catalog for Intellicar electrical analytics.
// One row per pack model; device_battery_map.battery_model maps deployments to it.
// NULL threshold columns mean "no manufacturer limit recorded" and fall through to
// the fleet-wide app_settings/env/default resolution (src/lib/telemetry/thresholds.ts).
export const batterySpecModels = pgTable("battery_spec_models", {
  model_name: varchar("model_name", { length: 100 }).primaryKey().notNull(),
  rated_voltage_v: numeric("rated_voltage_v", { precision: 6, scale: 2 }),
  rated_capacity_ah: numeric("rated_capacity_ah", { precision: 7, scale: 2 }),
  under_voltage_v: numeric("under_voltage_v", { precision: 6, scale: 2 }),
  over_voltage_v: numeric("over_voltage_v", { precision: 6, scale: 2 }),
  over_current_a: numeric("over_current_a", { precision: 6, scale: 2 }),
  over_temperature_c: numeric("over_temperature_c", { precision: 5, scale: 2 }),
  // E-201 — normal km-per-Ah efficiency band for the mileage charts. Spec-only per model
  // (no app_settings/env rung, like rated_capacity_ah); NULL = no band line drawn.
  min_mileage_km_per_ah: numeric("min_mileage_km_per_ah", { precision: 6, scale: 3 }),
  max_mileage_km_per_ah: numeric("max_mileage_km_per_ah", { precision: 6, scale: 3 }),
  notes: text(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const batteryAlerts = pgTable("battery_alerts", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  device_id: varchar("device_id", { length: 100 }).notNull(),
  alert_type: varchar("alert_type", { length: 50 }).notNull(),
  severity: varchar({ length: 20 }).notNull(),
  message: text(),
  value: numeric({ precision: 10, scale:  2 }),
  threshold: numeric({ precision: 10, scale:  2 }),
  acknowledged: boolean().default(false),
  acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledged_by: text("acknowledged_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// --- IOT DEVICE REGISTRY (E-045) ---
//
// Canonical IoT device-state table. Owned by E-045 (device registration on
// inventory upload) and consumed by E-046/E-047/E-048/E-049/E-050/E-051
// (telemetry ingestion, query APIs, immobilisation gating, etc.).
//
// Reuse-vs-new rationale (per E-045 audit):
//   - inventory.soc_percent / inventory.soc_last_sync_at hold per-asset SOC
//     snapshots; this table holds the live device-side cache (last_seen,
//     soc/soh/voltage/temperature/cycles, GPS, BMS) keyed off the IoT device
//     itself (serial_number/imei_id), not the inventory unit.
//   - device_battery_map links a device to a deployed battery once it ships;
//     iot_devices is created earlier (at inventory upload) so the registry
//     exists before deployment.
//   - dealer_id is intentionally a logical FK (varchar) matching the dealer-id
//     pattern used across after_sales_records / coupon_batches / dealer_leads.
export const iotDevices = pgTable("iot_devices", {
  id: serial().primaryKey(),
  device_id: varchar("device_id", { length: 50 }).notNull().unique(),
  serial_number: varchar("serial_number", { length: 50 }).notNull().unique(),
  imei_id: varchar("imei_id", { length: 20 }).notNull().unique(),
  dealer_id: varchar("dealer_id", { length: 50 }).notNull(),
  model: varchar({ length: 100 }).notNull(),
  category: varchar({ length: 50 }).notNull(),
  device_status: varchar("device_status", { length: 20 }).notNull().default('registered'),
  last_seen: timestamp("last_seen", { withTimezone: true }),
  soc_percent: integer("soc_percent"),
  soh_percent: integer("soh_percent"),
  voltage_v: numeric("voltage_v", { precision: 6, scale: 2 }),
  temperature_c: numeric("temperature_c", { precision: 5, scale: 2 }),
  charge_cycles: integer("charge_cycles"),
  gps_lat: numeric("gps_lat", { precision: 10, scale: 7 }),
  gps_lng: numeric("gps_lng", { precision: 10, scale: 7 }),
  gps_updated_at: timestamp("gps_updated_at", { withTimezone: true }),
  bms_status: varchar("bms_status", { length: 50 }),
  first_usage_at: timestamp("first_usage_at", { withTimezone: true }),
  registered_at: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- APP SETTINGS ---

export const appSettings = pgTable("app_settings", {
  key: text().primaryKey().notNull(),
  value: jsonb().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// --- WHATSAPP TRANSLATIONS (E-269) ---
// Gemini translation cache for outbound bot copy. See src/lib/whatsapp/translate.ts.
// Optional at runtime: every access is guarded, so an unapplied DB degrades to
// the in-process cache.

export const whatsappTranslations = pgTable(
  "whatsapp_translations",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    source_hash: varchar("source_hash", { length: 64 }).notNull(),
    language: varchar("language", { length: 16 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    source_text: text("source_text").notNull(),
    translated_text: text("translated_text").notNull(),
    model: varchar("model", { length: 64 }),
    hit_count: integer("hit_count").default(0).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("whatsapp_translations_hash_lang_uidx").on(t.source_hash, t.language),
  ],
);

// --- DEALER LEAD SCRAPER MODULE ---

export const scraperRuns = pgTable(
  "scraper_runs",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    triggered_by: uuid("triggered_by").notNull(),
    status: varchar({ length: 20 }).default('running').notNull(),
    started_at: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    search_queries: jsonb("search_queries"),
    total_found: integer("total_found").default(0),
    new_leads_saved: integer("new_leads_saved").default(0),
    duplicates_skipped: integer("duplicates_skipped").default(0),
    error_message: text("error_message"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    cleaned_leads: integer("cleaned_leads"),
    duration_ms: integer("duration_ms"),
    total_chunks: integer("total_chunks").default(0),
    completed_chunks: integer("completed_chunks").default(0),
  },
  (table) => ({
    scraperRunsStatusIdx: index("scraper_runs_status_idx").on(table.status),
    scraperRunsTriggeredByIdx: index("scraper_runs_triggered_by_idx").on(
      table.triggered_by,
    ),
  }),
);

export const scrapedDealerLeads = pgTable(
  "scraped_dealer_leads",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    scraper_run_id: varchar("scraper_run_id", { length: 255 }).notNull(),
    dealer_name: text("dealer_name").notNull(),
    phone: varchar({ length: 20 }),
    location_city: varchar("location_city", { length: 100 }),
    location_state: varchar("location_state", { length: 100 }),
    source_url: text("source_url"),
    raw_data: jsonb("raw_data"),
    assigned_to: uuid("assigned_to"),
    assigned_by: uuid("assigned_by"),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),
    exploration_status: varchar("exploration_status", { length: 30 }).default('unassigned').notNull(),
    exploration_notes: text("exploration_notes"),
    explored_at: timestamp("explored_at", { withTimezone: true }),
    converted_lead_id: varchar("converted_lead_id", { length: 255 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    email: text(),
    gst_number: text("gst_number"),
    business_type: text("business_type"),
    products_sold: text("products_sold"),
    website: text(),
    quality_score: integer("quality_score").default(1),
    phone_valid: boolean("phone_valid").default(false),
  },
  (table) => ({
    sdlPhoneIdx: index("sdl_phone_idx").on(table.phone),
    sdlNameCityIdx: index("sdl_name_city_idx").on(
      table.dealer_name,
      table.location_city,
    ),
    sdlSourceUrlIdx: index("sdl_source_url_idx").on(table.source_url),
    sdlRunIdx: index("sdl_run_idx").on(table.scraper_run_id),
    sdlAssignedToIdx: index("sdl_assigned_to_idx").on(table.assigned_to),
    sdlStatusIdx: index("sdl_status_idx").on(table.exploration_status),
  }),
);

export const scraperDedupLogs = pgTable(
  "scraper_dedup_logs",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    scraper_run_id: varchar("scraper_run_id", { length: 255 }).notNull(),
    raw_dealer_name: text("raw_dealer_name"),
    raw_phone: varchar("raw_phone", { length: 20 }),
    raw_location: text("raw_location"),
    raw_source_url: text("raw_source_url"),
    skip_reason: varchar("skip_reason", { length: 50 }).notNull(),
    matched_lead_id: varchar("matched_lead_id", { length: 255 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    ddupRunIdx: index("ddup_run_idx").on(table.scraper_run_id),
  }),
);

export const scraperSearchQueries = pgTable(
  "scraper_search_queries",
  {
    id: text().primaryKey().notNull(),
    query_text: text("query_text").notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    created_by: text("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sqActiveIdx: index("sq_active_idx").on(table.is_active),
  }),
);

export const scraperSearchQueriesRelations = relations(
  scraperSearchQueries,
  ({ one }) => ({
    createdBy: one(users, {
      fields: [scraperSearchQueries.created_by],
      references: [users.id],
    }),
  }),
);

export const scraperSchedules = pgTable("scraper_schedules", {
  id: text().primaryKey().notNull(),
  frequency: text().default('weekly').notNull(),
  day_of_week: integer("day_of_week").default(1),
  time_of_day: text("time_of_day").default('04:00'),
  is_active: boolean("is_active").default(true).notNull(),
  last_run_at: timestamp("last_run_at", { withTimezone: true }),
  created_by: text("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scraperSchedulesRelations = relations(
  scraperSchedules,
  ({ one }) => ({
    createdBy: one(users, {
      fields: [scraperSchedules.created_by],
      references: [users.id],
    }),
  }),
);

// Relations for scraper tables
export const scraperRunsRelations = relations(scraperRuns, ({ one, many }) => ({
  triggeredBy: one(users, {
    fields: [scraperRuns.triggered_by],
    references: [users.id],
  }),
  leads: many(scrapedDealerLeads),
  dedupLogs: many(scraperDedupLogs),
}));

export const scrapedDealerLeadsRelations = relations(
  scrapedDealerLeads,
  ({ one }) => ({
    scraperRun: one(scraperRuns, {
      fields: [scrapedDealerLeads.scraper_run_id],
      references: [scraperRuns.id],
    }),
    assignedTo: one(users, {
      fields: [scrapedDealerLeads.assigned_to],
      references: [users.id],
    }),
    assignedBy: one(users, {
      fields: [scrapedDealerLeads.assigned_by],
      references: [users.id],
    }),
    convertedLead: one(dealerLeads, {
      fields: [scrapedDealerLeads.converted_lead_id],
      references: [dealerLeads.id],
    }),
  }),
);

export const scraperDedupLogsRelations = relations(
  scraperDedupLogs,
  ({ one }) => ({
    scraperRun: one(scraperRuns, {
      fields: [scraperDedupLogs.scraper_run_id],
      references: [scraperRuns.id],
    }),
  }),
);

export const dealerOnboardingApplications = pgTable(
  "dealer_onboarding_applications",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    dealer_user_id: uuid("dealer_user_id"),
    company_name: text("company_name").notNull(),
    company_type: text("company_type"),
    // E-202 — dealer business type: 'new' | 'scrap' | 'both'. Selected in
    // onboarding Step 1. Distinct from company_type (legal structure).
    dealer_type: varchar("dealer_type", { length: 16 }),
    gst_number: text("gst_number"),
    pan_number: text("pan_number"),
    cin_number: text("cin_number"),
    finance_enabled: boolean("finance_enabled").default(false),
    onboarding_status: varchar("onboarding_status", { length: 30 }).default('draft').notNull(),
    review_status: varchar("review_status", { length: 30 }).default('pending'),
    // Last wizard step a draft was left on, so a resumed onboarding reopens
    // where the user stopped instead of restarting at step 1 (E-164).
    draft_step: integer("draft_step").default(1),
    submitted_at: timestamp("submitted_at"),
    approved_at: timestamp("approved_at"),
    rejected_at: timestamp("rejected_at"),
    rejection_reason: text("rejection_reason"),
    admin_notes: text("admin_notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
    owner_name: text("owner_name"),
    owner_phone: text("owner_phone"),
    owner_email: text("owner_email"),
    bank_name: text("bank_name"),
    account_number: text("account_number"),
    beneficiary_name: text("beneficiary_name"),
    ifsc_code: text("ifsc_code"),
    correction_remarks: text("correction_remarks"),
    rejection_remarks: text("rejection_remarks"),
    dealer_account_status: varchar("dealer_account_status", { length: 30 }).default('inactive'),
    dealer_code: text("dealer_code"),
    correction_requested_at: timestamp("correction_requested_at"),
    revalidated_at: timestamp("revalidated_at"),
    last_action_by: uuid("last_action_by"),
    last_action_at: timestamp("last_action_at"),
    approved_by: uuid("approved_by"),
    rejected_by: uuid("rejected_by"),
    correction_count: integer("correction_count").default(0).notNull(),
    is_locked: boolean("is_locked").default(false).notNull(),
    business_address_new: jsonb("business_address_new").default({}),
    city: varchar({ length: 100 }),
    state: varchar({ length: 100 }),
    pincode: varchar({ length: 20 }),
    contact_name: text("contact_name"),
    contact_phone: varchar("contact_phone", { length: 20 }),
    contact_email: varchar("contact_email", { length: 150 }),
    agreement_id: uuid("agreement_id"),
    registered_address: jsonb("registered_address").default({}),
    business_address: text("business_address"),
    request_id: text("request_id"),
    provider_document_id: text("provider_document_id"),
    provider_signing_url: text("provider_signing_url"),
    signed_at: timestamp("signed_at"),
    last_action_timestamp: timestamp("last_action_timestamp"),
    stamp_status: varchar("stamp_status", { length: 50 }),
    completion_status: varchar("completion_status", { length: 50 }),
    agreement_audit_trail_url: text("agreement_audit_trail_url"),
    sales_manager_name: text("sales_manager_name"),
    sales_manager_email: text("sales_manager_email"),
    sales_manager_mobile: text("sales_manager_mobile"),
    itarang_signatory_1_name: text("itarang_signatory_1_name"),
    itarang_signatory_1_email: text("itarang_signatory_1_email"),
    itarang_signatory_1_mobile: text("itarang_signatory_1_mobile"),
    itarang_signatory_2_name: text("itarang_signatory_2_name"),
    itarang_signatory_2_email: text("itarang_signatory_2_email"),
    itarang_signatory_2_mobile: text("itarang_signatory_2_mobile"),
    agreement_last_initiated_at: timestamp("agreement_last_initiated_at"),
    agreement_expired_at: timestamp("agreement_expired_at"),
    agreement_failed_at: timestamp("agreement_failed_at"),
    agreement_failure_reason: text("agreement_failure_reason"),
    agreement_completed_at: timestamp("agreement_completed_at"),
    signed_agreement_storage_path: text("signed_agreement_storage_path"),
    audit_trail_storage_path: text("audit_trail_storage_path"),
    agreement_status: varchar("agreement_status", { length: 50 }).default('not_generated'),
    // E-225 — HOW the agreement is executed, orthogonal to agreement_status
    // (which says WHETHER it is done). 'esign' = Digio, new-battery dealers;
    // 'manual' = admin uploads a signed scan, scrap / new+scrap dealers.
    // agreement_ref is the reference on the paper — never a Digio document id,
    // that stays provider_document_id (cf. E-223 scrap_vendors.agreement_ref).
    agreement_mode: varchar("agreement_mode", { length: 16 }),
    agreement_ref: text("agreement_ref"),
    agreement_signed_on: date("agreement_signed_on"),
    provider_raw_response: jsonb("provider_raw_response"),
    signed_agreement_url: text("signed_agreement_url"),
    audit_trail_url: text("audit_trail_url"),
    owner_landline: varchar("owner_landline", { length: 20 }),
    agreement_language: varchar("agreement_language", { length: 30 }).default('english').notNull(),
    is_branch_dealer: boolean("is_branch_dealer").default(false).notNull(),
    stamp_certificate_ids: jsonb("stamp_certificate_ids").default([]),
    // ---- Part 0 BRD §0.13 Point A — Conversion → Onboarding (E-127).
    originating_dealer_lead_id: text("originating_dealer_lead_id"),
    sponsoring_asm_id: text("sponsoring_asm_id"),
    owner_id: text("owner_id"),
    field_verification_status: jsonb("field_verification_status").default({}),
    source_ai_session_id: text("source_ai_session_id"),
    source_ai_intent_score: integer("source_ai_intent_score"),
    source_ai_recording_url: text("source_ai_recording_url"),
    payment_intent_note: text("payment_intent_note"),
    communication_language: varchar("communication_language", { length: 40 }),
    business_segments: jsonb("business_segments").default([]),
    proposed_deal_value: numeric("proposed_deal_value", { precision: 14, scale: 2 }),
    proposed_credit_terms: text("proposed_credit_terms"),
    proposed_delivery_terms: text("proposed_delivery_terms"),
    proposed_warranty_terms: text("proposed_warranty_terms"),
    proposed_terms_notes: text("proposed_terms_notes"),
    payment_method: varchar("payment_method", { length: 20 }),
    deal_notes: text("deal_notes"),
    quote_document_url: text("quote_document_url"),
    // ---- E-167 WhatsApp onboarding ----
    // source distinguishes web-wizard drafts from WhatsApp-bot-collected ones so
    // the Sales Admin review list can badge/filter them; everything else is
    // shared. verification_warnings / extraction_summary surface what the bot
    // read + checked so no failed check passes silently (design §8, §16).
    source: varchar("source", { length: 16 }).default('web').notNull(),
    wa_phone: varchar("wa_phone", { length: 20 }),
    wa_session_id: uuid("wa_session_id"),
    verification_warnings: jsonb("verification_warnings").default([]).notNull(),
    extraction_summary: jsonb("extraction_summary").default({}).notNull(),
    dealer_confirmed_at: timestamp("dealer_confirmed_at"),
    // ---- E-175 owner Aadhaar (for dealer-agreement signer verification) ----
    // The owner's Aadhaar number, extracted from the Aadhaar uploaded during
    // onboarding. At dealer-agreement signing (Aadhaar eSign) the signer's
    // masked Aadhaar from Digio is matched against this so the agreement can't be
    // signed with a different person's Aadhaar. Mirrors the customer-consent gate.
    owner_aadhaar_no: varchar("owner_aadhaar_no", { length: 12 }),
    owner_aadhaar_verified: boolean("owner_aadhaar_verified").default(false).notNull(),
    // ---- E-216 internal WhatsApp onboarding operator ----
    // The internal team member who created this file over WhatsApp. Deliberately
    // NOT dealer_user_id: the approve route overwrites that column with the
    // DEALER's Supabase auth id, which destroys creator attribution.
    onboarding_operator_id: uuid("onboarding_operator_id"),
    // 'self' | 'operator' | 'operator_handoff' — which channel currently owns the
    // file. 'self' reproduces every pre-E-216 row.
    onboarding_channel: varchar("onboarding_channel", { length: 24 })
      .default('self')
      .notNull(),
    // The OPERATOR's per-dealer file session. wa_session_id above keeps its
    // existing meaning (the DEALER's own session); after a handoff both are set.
    wa_operator_session_id: uuid("wa_operator_session_id"),
    operator_invited_at: timestamp("operator_invited_at", { withTimezone: true }),
    operator_handoff_at: timestamp("operator_handoff_at", { withTimezone: true }),
  },
);

export const dealerAgreementSigners = pgTable(
  "dealer_agreement_signers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    application_id: uuid("application_id").notNull(),
    provider_document_id: text("provider_document_id"),
    request_id: text("request_id"),
    signer_role: varchar("signer_role", { length: 50 }).notNull(),
    signer_name: text("signer_name").notNull(),
    signer_email: text("signer_email"),
    signer_mobile: text("signer_mobile"),
    signing_method: varchar("signing_method", { length: 50 }),
    provider_signer_identifier: text("provider_signer_identifier"),
    provider_signing_url: text("provider_signing_url"),
    signer_status: varchar("signer_status", { length: 50 }).default('pending').notNull(),
    signed_at: timestamp("signed_at"),
    last_event_at: timestamp("last_event_at"),
    provider_raw_response: jsonb("provider_raw_response").default({}),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    appIdx: index("dealer_agreement_signers_application_id_idx").on(
      table.application_id,
    ),
    docIdx: index("dealer_agreement_signers_provider_document_id_idx").on(
      table.provider_document_id,
    ),
    statusIdx: index("dealer_agreement_signers_signer_status_idx").on(
      table.signer_status,
    ),
  }),
);

export const dealerAgreementEvents = pgTable(
  "dealer_agreement_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    application_id: uuid("application_id").notNull(),
    provider_document_id: text("provider_document_id"),
    request_id: text("request_id"),
    event_type: varchar("event_type", { length: 100 }).notNull(),
    signer_role: varchar("signer_role", { length: 50 }),
    event_status: varchar("event_status", { length: 50 }),
    event_payload: jsonb("event_payload").default({}),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    appIdx: index("dealer_agreement_events_application_id_idx").on(
      table.application_id,
    ),
    docIdx: index("dealer_agreement_events_provider_document_id_idx").on(
      table.provider_document_id,
    ),
    createdIdx: index("dealer_agreement_events_created_at_idx").on(
      table.created_at,
    ),
  }),
);

export const dealerOnboardingDocuments = pgTable(
  "dealer_onboarding_documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    application_id: uuid("application_id").notNull(),
    document_type: varchar("document_type", { length: 100 }).notNull(),
    bucket_name: text("bucket_name").notNull(),
    storage_path: text("storage_path").notNull(),
    file_name: text("file_name").notNull(),
    file_url: text("file_url"),
    mime_type: varchar("mime_type", { length: 100 }),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    file_size: bigint("file_size", { mode: "number" }),
    uploaded_by: uuid("uploaded_by"),
    uploaded_at: timestamp("uploaded_at").defaultNow().notNull(),
    doc_status: varchar("doc_status", { length: 30 }).default('uploaded').notNull(),
    verification_status: varchar("verification_status", { length: 30 }).default('pending'),
    verified_at: timestamp("verified_at"),
    verified_by: uuid("verified_by"),
    rejection_reason: text("rejection_reason"),
    extracted_data: jsonb("extracted_data").default({}),
    api_verification_results: jsonb("api_verification_results").default({}),
    metadata: jsonb().default({}),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
    admin_comment: text("admin_comment"),
    // ---- E-167 WhatsApp onboarding (per-doc extraction/verification provenance) ----
    source: varchar("source", { length: 16 }).default('web').notNull(),
    extraction_engine: varchar("extraction_engine", { length: 24 }),
    extraction_confidence: numeric("extraction_confidence"),
    verification_provider: varchar("verification_provider", { length: 24 }),
  },
  (table) => ({
    applicationIdIdx: index("dealer_onboarding_documents_application_id_idx").on(
      table.application_id,
    ),
  }),
);

// ── E-216 internal WhatsApp onboarding operators ────────────────────────────
// Admin-managed allowlist of internal team members who may onboard MANY dealers
// from their own WhatsApp number. Identity is the phone alone — user_id is an
// optional attribution link, NOT the key, so a team member with no CRM login
// still works. Deliberately not users.role: resolveKnownContact() already
// matches users.phone for a cosmetic greeting, and making that load-bearing
// would silently promote every staff member with a mobile on file.
export const whatsappOperators = pgTable(
  "whatsapp_operators",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // E.164 WITHOUT '+', exactly as Meta delivers it ('919876543210').
    wa_phone: varchar("wa_phone", { length: 20 }).notNull(),
    display_name: text("display_name").notNull(),
    user_id: uuid("user_id"),
    email: varchar("email", { length: 150 }),
    is_active: boolean("is_active").default(true).notNull(),
    deactivated_at: timestamp("deactivated_at", { withTimezone: true }),
    deactivated_by: uuid("deactivated_by"),
    created_by: uuid("created_by"),
    notes: text("notes"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    waPhoneKey: uniqueIndex("whatsapp_operators_wa_phone_key").on(table.wa_phone),
    activeIdx: index("whatsapp_operators_active_idx").on(table.wa_phone),
  }),
);

// ── E-277 dealer sales team on WhatsApp ─────────────────────────────────────
// Dealer-managed allowlist of salespersons who onboard customers from their own
// WhatsApp numbers on the dealer's behalf. Mirror image of whatsapp_operators
// (E-214: one iTarang number → many dealers; here: many numbers → one dealer).
// Identity is the phone alone; salespersons have NO users row / login. One
// ACTIVE row per phone globally (partial unique in E-277); deactivation flips
// is_active so leads.salesperson_id history and re-adding both survive.
export const dealerSalespersons = pgTable(
  "dealer_salespersons",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // = dealers.dealer_id / leads.dealer_id (loose varchar ref, as elsewhere).
    dealer_code: varchar("dealer_code", { length: 255 }).notNull(),
    // E.164 WITHOUT '+', exactly as Meta delivers it ('919876543210').
    wa_phone: varchar("wa_phone", { length: 20 }).notNull(),
    display_name: text("display_name").notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    added_by: uuid("added_by"),
    // 'whatsapp' | 'portal' | 'admin'
    added_via: varchar("added_via", { length: 16 })
      .default("whatsapp")
      .notNull(),
    deactivated_at: timestamp("deactivated_at", { withTimezone: true }),
    deactivated_by: uuid("deactivated_by"),
    notes: text("notes"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    dealerIdx: index("dealer_salespersons_dealer_idx").on(
      table.dealer_code,
      table.created_at,
    ),
  }),
);

// ── E-279 extra MAIN-dealer WhatsApp numbers ────────────────────────────────
// Admin-managed allowlist of ADDITIONAL numbers that resolve to a dealership's
// full main-dealer console (ActiveDealer without an actor tag) — the full-scope
// sibling of dealer_salespersons. Resolution rides resolveWhatsAppDealer()'s
// third lookup step (gate 12 fallback); leads created from these numbers are
// ordinary main-dealer leads (salesperson_id NULL). One ACTIVE row per phone
// globally (partial unique in E-279, SQL-only like E-277's); deactivation flips
// is_active, never deletes.
export const dealerExtraNumbers = pgTable(
  "dealer_extra_numbers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // = dealers.dealer_id / leads.dealer_id (loose varchar ref, as elsewhere).
    dealer_code: varchar("dealer_code", { length: 255 }).notNull(),
    // E.164 WITHOUT '+', exactly as Meta delivers it ('919876543210').
    wa_phone: varchar("wa_phone", { length: 20 }).notNull(),
    display_name: text("display_name").notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    added_by: uuid("added_by"),
    added_via: varchar("added_via", { length: 16 }).default("admin").notNull(),
    deactivated_at: timestamp("deactivated_at", { withTimezone: true }),
    deactivated_by: uuid("deactivated_by"),
    notes: text("notes"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    dealerIdx: index("dealer_extra_numbers_dealer_idx").on(
      table.dealer_code,
      table.created_at,
    ),
  }),
);

// ── E-278 per-lead action/step audit trail (WhatsApp console) ───────────────
// Append-only event stream: who (dealer / salesperson / customer) took a lead
// to which DC_* step, written from the runConsoleTurn choke point plus the
// created/submitted/button-tap write points (src/lib/whatsapp/lead-events.ts).
// Serves the dealer's "History" timeline, and the newest journey to_state is
// the lead's last-known position for the "Team Leads" takeover — which is what
// makes a salesperson's session-local parked position visible to the dealer.
// All code paths swallow errors, so an unapplied environment records nothing
// but breaks nothing.
export const leadFlowEvents = pgTable(
  "lead_flow_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // = leads.id (loose varchar ref, as leads.dealer_id references dealers).
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    // = leads.dealer_id, denormalised so listings need no join.
    dealer_code: varchar("dealer_code", { length: 255 }).notNull(),
    // 'dealer' | 'salesperson' | 'customer' | 'system' (code-owned).
    actor_kind: varchar("actor_kind", { length: 16 }).notNull(),
    // dealer_salespersons.id when actor_kind='salesperson'.
    salesperson_id: uuid("salesperson_id"),
    // Display-name snapshot; survives the salesperson's later removal.
    actor_label: text("actor_label"),
    from_state: varchar("from_state", { length: 32 }),
    to_state: varchar("to_state", { length: 32 }),
    // 'created' | 'submitted' | 'state' | 'takeover' | 'action:<key>'.
    action: varchar("action", { length: 32 }).default("state").notNull(),
    note: text("note"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    leadIdx: index("lead_flow_events_lead_idx").on(
      table.lead_id,
      table.created_at,
    ),
    dealerIdx: index("lead_flow_events_dealer_idx").on(
      table.dealer_code,
      table.created_at,
    ),
  }),
);

// ── E-167 WhatsApp dealer-onboarding chatbot ────────────────────────────────
// One row per dealer conversation. Persists the conversation state machine so a
// dropped chat resumes exactly where it left off (design §4). State values are
// code-owned (src/lib/whatsapp/orchestrator.ts), not DB-constrained.
export const whatsappOnboardingSessions = pgTable(
  "whatsapp_onboarding_sessions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    wa_phone: varchar("wa_phone", { length: 20 }).notNull(),
    wa_contact_name: text("wa_contact_name"),
    provider: varchar("provider", { length: 16 }).default('meta').notNull(),
    provider_conversation_id: text("provider_conversation_id"),
    application_id: uuid("application_id"),
    current_state: varchar("current_state", { length: 32 })
      .default('GREETING')
      .notNull(),
    expected_document_type: varchar("expected_document_type", { length: 64 }),
    detected_company_type: varchar("detected_company_type", { length: 48 }),
    language: varchar("language", { length: 12 }).default('en').notNull(),
    context: jsonb("context").default({}).notNull(),
    reminder_count: integer("reminder_count").default(0).notNull(),
    last_inbound_at: timestamp("last_inbound_at", { withTimezone: true }),
    last_outbound_at: timestamp("last_outbound_at", { withTimezone: true }),
    last_reminder_at: timestamp("last_reminder_at", { withTimezone: true }),
    session_status: varchar("session_status", { length: 24 })
      .default('active')
      .notNull(),
    // ---- E-216 operator sessions ----
    // 'dealer'        — every pre-E-216 row, and every self-onboarding dealer
    // 'operator_hub'  — one per operator number; holds the OP_* menu state
    // 'operator_file' — one per dealer file an operator has open. Carries the
    //                   OPERATOR's wa_phone (so replies reach them) while
    //                   application_id points at a dealer's file, which is what
    //                   lets the unmodified onboarding handlers run per dealer.
    session_kind: varchar("session_kind", { length: 16 })
      .default('dealer')
      .notNull(),
    operator_id: uuid("operator_id"),
    parent_session_id: uuid("parent_session_id"),
    // E-277 — dealer_salespersons.id when session_kind='salesperson'. Mirrors
    // operator_id for E-214 hubs: a dealer's salesperson runs the lead console
    // from their own number, scoped to leads they created.
    salesperson_id: uuid("salesperson_id"),
    // E-264 — the interactive prompt we could not send because Meta's 24-hour
    // service window was shut. A template cannot carry a list or more than three
    // buttons, so out-of-window we send a generic template nudge and stash the
    // real prompt here; the customer's next inbound re-opens the window and the
    // orchestrator replays it verbatim. Sending the template does NOT re-open
    // the window — only their reply does.
    pending_prompt: jsonb("pending_prompt"),
    pending_prompt_at: timestamp("pending_prompt_at", { withTimezone: true }),
    // E-264 — unanswered template nudges since the last inbound. Meta scores the
    // business down for these, so they are capped. Reset on inbound.
    window_nudges_sent: integer("window_nudges_sent").default(0).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    waPhoneIdx: index("whatsapp_onboarding_sessions_wa_phone_idx").on(
      table.wa_phone,
    ),
    statusInboundIdx: index(
      "whatsapp_onboarding_sessions_status_inbound_idx",
    ).on(table.session_status, table.last_inbound_at),
    applicationIdIdx: index(
      "whatsapp_onboarding_sessions_application_id_idx",
    ).on(table.application_id),
    phoneKindIdx: index("whatsapp_onboarding_sessions_phone_kind_idx").on(
      table.wa_phone,
      table.session_kind,
    ),
    operatorIdx: index("whatsapp_onboarding_sessions_operator_idx").on(
      table.operator_id,
    ),
  }),
);

// Append-only inbound/outbound log: audit trail, idempotency
// (provider_message_id UNIQUE — duplicate webhook deliveries are no-ops), and
// delivery-status tracking.
export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    session_id: uuid("session_id"),
    provider_message_id: text("provider_message_id"),
    direction: varchar("direction", { length: 12 }).notNull(),
    message_type: varchar("message_type", { length: 24 }).notNull(),
    text_body: text("text_body"),
    media_provider_id: text("media_provider_id"),
    storage_path: text("storage_path"),
    template_name: text("template_name"),
    delivery_status: varchar("delivery_status", { length: 16 }),
    raw_payload: jsonb("raw_payload"),
    // E-170: dealer self-service (post-approval) sessions. session_id FKs to the
    // onboarding sessions table; this nullable column links dealer-mode messages.
    dealer_session_id: uuid("dealer_session_id"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    providerMessageIdUnique: uniqueIndex(
      "whatsapp_messages_provider_message_id_unique",
    ).on(table.provider_message_id),
    sessionIdIdx: index("whatsapp_messages_session_id_idx").on(
      table.session_id,
    ),
    dealerSessionIdIdx: index("whatsapp_messages_dealer_session_id_idx").on(
      table.dealer_session_id,
    ),
  }),
);

// E-170 — one row per APPROVED dealer's WhatsApp self-service conversation
// (create leads, customer KYC, inventory, financing). Separate from
// whatsapp_onboarding_sessions (E-167): onboarding is dealer-FIRST and ends at
// approval; this picks up AFTER approval. Keyed by wa_phone. current_state /
// session_status are code-owned (src/lib/whatsapp/dealer-orchestrator.ts) — no
// migration needed to add a state.
export const whatsappDealerSessions = pgTable(
  "whatsapp_dealer_sessions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    wa_phone: varchar("wa_phone", { length: 20 }).notNull(),
    dealer_code: varchar("dealer_code", { length: 50 }).notNull(),
    dealer_user_id: uuid("dealer_user_id"),
    current_state: varchar("current_state", { length: 32 })
      .default("MENU")
      .notNull(),
    active_lead_id: varchar("active_lead_id", { length: 255 }),
    context: jsonb("context").default({}).notNull(),
    session_status: varchar("session_status", { length: 24 })
      .default("active")
      .notNull(),
    last_inbound_at: timestamp("last_inbound_at", { withTimezone: true }),
    last_outbound_at: timestamp("last_outbound_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    waPhoneIdx: index("whatsapp_dealer_sessions_wa_phone_idx").on(
      table.wa_phone,
    ),
    dealerCodeIdx: index("whatsapp_dealer_sessions_dealer_code_idx").on(
      table.dealer_code,
    ),
  }),
);

export const scrapeRuns = pgTable("scraper_runs", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  triggered_by: uuid("triggered_by").notNull(),
  status: varchar({ length: 20 }).default('running').notNull(),
  started_at: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completed_at: timestamp("completed_at", { withTimezone: true }),
  search_queries: jsonb("search_queries"),
  total_found: integer("total_found").default(0),
  new_leads_saved: integer("new_leads_saved").default(0),
  duplicates_skipped: integer("duplicates_skipped").default(0),
  error_message: text("error_message"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  cleaned_leads: integer("cleaned_leads"),
  duration_ms: integer("duration_ms"),
  total_chunks: integer("total_chunks").default(0),
  completed_chunks: integer("completed_chunks").default(0),
  // Counts of how many scraper_leads actually got promoted into dealer_leads
  // (i.e., became dialable). new_leads_saved counts rows added to the
  // scraper_leads audit table; new_leads_promoted is the subset that survived
  // the toTenDigits phone validation AND the dealer_leads.phone UNIQUE
  // constraint dedup. The gap between these two numbers is what surfaces in
  // the run-progress UI as "X duplicates skipped".
  new_leads_promoted: integer("new_leads_promoted").default(0),
  new_leads_skipped_duplicate: integer("new_leads_skipped_duplicate").default(0),
  new_leads_skipped_invalid_phone: integer(
    "new_leads_skipped_invalid_phone",
  ).default(0),
  // ⚠ `last_progress_at` WAS DECLARED HERE AND HAS BEEN REMOVED. Do not add it
  // back without first writing the migration that creates it.
  //
  // It was added for a liveness heartbeat — executeChunk() would bump it and
  // reapStuckRuns() would reap on silence rather than on total run age, so a
  // legitimately long multi-query run isn't force-failed at minute 11. That is
  // still a good idea, but NONE of it was built: no code writes the column, no
  // code reads it, reapStuckRuns() still compares `started_at`, and the E-227
  // migration the old comment here credited does not exist in drizzle/.
  //
  // So the column existed in exactly one place — this object — and drizzle
  // names EVERY column of a table object in its INSERT. The result was that
  // starting any scrape died with
  //   column "last_progress_at" of relation "scraper_runs" does not exist
  // on every database, because no database has ever had it. Same failure mode
  // E-224 / E-226 / E-236 each call out at length: a column that is not
  // guaranteed present must not be named on the drizzle object.
  //
  // To build the heartbeat: write the migration (column + a partial
  // idx_scraper_runs_running WHERE status = 'running'), apply it everywhere,
  // THEN add the column back here — or write it by raw sql`` and leave this
  // object alone, which is what the three migrations above chose.
});

export const scraperRunChunks = pgTable(
  "scraper_run_chunks",
  {
    id: text().primaryKey().notNull(),
    run_id: text("run_id").notNull(),
    combination_query: text("combination_query").notNull(),
    status: text().default('pending').notNull(),
    leads_count: integer("leads_count").default(0),
    error_message: text("error_message"),
    created_at: timestamp("created_at").defaultNow(),
    completed_at: timestamp("completed_at"),
    // E-227 — the two components of combination_query, stored at fan-out time.
    // combination_query may itself contain " in ", so it can't be parsed back
    // apart reliably. NULL on chunks created before E-227.
    query_text: text("query_text"),
    city: text(),
  },
  (t) => ({
    // E-227 — the progress poll runs WHERE run_id = ? GROUP BY status every few
    // seconds against ~1,500 rows per run; this table had no index at all.
    runIdIdx: index("idx_scraper_run_chunks_run_id").on(t.run_id),
    // Serves the chunk-drain ticker's claim query. Partial (WHERE status =
    // 'pending') in the migration — Drizzle's builder can't express that, so
    // E-227 is the source of truth for the WHERE clause.
    pendingIdx: index("idx_scraper_run_chunks_pending").on(
      t.status,
      t.created_at,
    ),
  }),
);

// E-241 — the scraper batch job queue. One row = one (query, city) pair waiting
// to become a scraper_runs row. The dispatcher ticker
// (startScraperQueueTicker in src/instrumentation-node.ts →
// jobQueue.dispatchOnce()) claims the oldest eligible row, creates an ordinary
// scraper_runs row for it, and calls the existing startChunkedRun().
//
// Safe to mirror in full — unlike the scrapeRuns landmine above, this table is
// brand new, so there is no pre-existing statement an extra column could break.
// On a database without E-241 the /api/scraper/batch routes 500 loudly and the
// single-query scraper keeps working; that is the whole reason the queue is its
// own relation rather than seven more columns on scraper_runs.
export const scraperJobQueue = pgTable(
  "scraper_job_queue",
  {
    id: text().primaryKey().notNull(),
    // Groups the rows of one submission. A LABEL for the UI only — there is no
    // batch entity and nothing rolls up through it.
    batch_id: text("batch_id").notNull(),
    // Position within the batch, 0-based. Dispatch orders by
    // (created_at, seq) — created_at FIRST: a whole submission is inserted in
    // one statement and shares created_at exactly, so that reads as "oldest
    // batch first, then the operator's own row order" and batches drain FIFO.
    // seq alone cannot express order (shared timestamp), and seq FIRST would
    // round-robin across batches because seq restarts at 0 for each one.
    seq: integer().default(0).notNull(),
    query_text: text("query_text").notNull(),
    // NULL = no city list supplied, so generateCitiesForQuery() picks them,
    // i.e. exactly the pre-E-241 single-query behaviour.
    city: text(),
    max_results: integer("max_results"),
    // false (the default, and the UI default) = use query_text literally, one
    // chunk per job. true = expand into ~15 Gemini variations first.
    expand_with_ai: boolean("expand_with_ai").default(false).notNull(),
    // queued | running | done | failed | cancelled. No CHECK, no pgEnum — the
    // vocabulary lives in src/lib/scraper/jobQueue.ts and is enforced by zod at
    // the write path, per this table family's convention.
    status: varchar({ length: 16 }).default('queued').notNull(),
    // Soft FK to scraper_runs.id — no DB-level constraint on purpose.
    run_id: varchar("run_id", { length: 255 }),
    attempts: integer().default(0).notNull(),
    last_error: text("last_error"),
    // now | once | daily. See E-241's header — 'daily' is the whole of the
    // recurring model and needs no pause/resume state: queued rows just sit
    // here while the window is shut.
    schedule_mode: varchar("schedule_mode", { length: 16 })
      .default('now')
      .notNull(),
    run_after: timestamp("run_after", { withTimezone: true }),
    // 'HH:MM' IST. Same shape as dialer_campaigns.window_start (E-228) and
    // assignment_config.working_hours_start (E-120). window_end < window_start
    // is legal and means an overnight window; the reader handles the wrap.
    window_start: varchar("window_start", { length: 5 }),
    window_end: varchar("window_end", { length: 5 }),
    // ["mon","tue",…]; NULL = every day. Same vocabulary as
    // assignment_config.working_days and dialer_campaigns.window_days.
    window_days: jsonb("window_days"),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dispatched_at: timestamp("dispatched_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    // Copied off scraper_runs.new_leads_promoted by reconcileFinishedJobs() so
    // batch totals need no join.
    leads_promoted: integer("leads_promoted").default(0).notNull(),
  },
  (t) => ({
    // Serves dispatchOnce()'s claim. PARTIAL (WHERE status = 'queued') in the
    // migration — Drizzle's index builder has no WHERE syntax, so E-241 is the
    // source of truth for the predicate.
    claimIdx: index("idx_scraper_job_queue_claim").on(t.created_at, t.seq),
    batchIdx: index("idx_scraper_job_queue_batch").on(t.batch_id, t.seq),
    // Also PARTIAL in the migration (WHERE run_id IS NOT NULL) — same caveat.
    runIdx: index("idx_scraper_job_queue_run").on(t.run_id),
  }),
);

export const scraperLeads = pgTable("scraper_leads", {
  id: text().primaryKey().notNull(),
  name: text(),
  phone: text(),
  email: text(),
  website: text(),
  city: text(),
  address: text(),
  source: text(),
  status: text(),
  created_at: timestamp("created_at").defaultNow(),
});

export const scraperRaw = pgTable("scraper_raw", {
  id: text().primaryKey().notNull(),
  run_id: text("run_id"),
  raw_data: text("raw_data"),
  created_at: timestamp("created_at").defaultNow(),
});

export const dealerLeads = pgTable("dealer_leads", {
  id: text().primaryKey().notNull(),
  dealer_name: text("dealer_name"),
  // UNIQUE so promoteLeadsToDealerLeads' onConflictDoNothing has something
  // to conflict on. The constraint already exists in the DB (migration
  // 0002_cute_devos.sql); mirror it here so future `db:push` runs preserve it.
  phone: text().unique("dealer_leads_phone_unique"),
  // E-242 adds `contact_email` and `gstin` to this table and they are
  // DELIBERATELY ABSENT HERE, exactly as E-224's and E-236's columns are.
  //
  // Drizzle names every column of a table object in a bare
  // `db.select().from(dealerLeads)`, and there are ~20 of those across the
  // leads list, the AI dialer, the CEO overview and the dashboards. Listing a
  // column here therefore hard-fails all of them at PARSE time on any database
  // without the migration — the whole leads screen goes down to add an email
  // field. The quotation code reads both columns by name in raw `sql``
  // projections instead (quoteDraft.ts, the send route), so an unapplied E-242
  // costs the quotation feature and nothing else.
  language: text(),
  follow_up_history: jsonb("follow_up_history").default([]),
  current_status: text("current_status"),
  total_attempts: integer("total_attempts").default(0),
  final_intent_score: integer("final_intent_score").default(0),
  created_at: timestamp("created_at").defaultNow(),
  location: text(),
  // Structured region hierarchy — see drizzle/E-106. `location` stays for
  // legacy callers (free-form city string); state/city/area/pincode power
  // the region selector and the /api/ai-dialer/preview hot path. Indexes
  // on (state, city) and a partial index on (state, city, current_status)
  // WHERE phone IS NOT NULL live in the migration, not here.
  state: text(),
  city: text(),
  area: text(),
  pincode: text(),
  country: text().default("IN"),
  timezone: text(),
  memory: jsonb(),
  next_call_at: timestamp("next_call_at"),
  shop_name: text("shop_name"),
  overall_summary: text("overall_summary"),
  assigned_to: text("assigned_to"),
  approved_by: text("approved_by"),
  rejected_by: text("rejected_by"),
  dealer_id: text("dealer_id"),
  provider: text("provider").default("bolna"),
  // Lead-acquisition source (E-126). ai_dialer_lead / manual_upload_lead /
  // reference / trade_show / other. Drives BRD §0.11 Report 5.
  source: varchar("source", { length: 40 }),
  // ---- Part 0 BRD additions (E-112). See drizzle/E-112_dealer_leads_part0_columns.sql.
  // Lifecycle / status (BRD §0.7)
  lead_status: varchar("lead_status", { length: 50 }),
  ai_recall_status: varchar("ai_recall_status", { length: 30 }),
  lost_reason: varchar("lost_reason", { length: 100 }),
  lost_reason_notes: text("lost_reason_notes"),
  previous_lost_reason: varchar("previous_lost_reason", { length: 100 }),
  onboarding_dropout_reason: varchar("onboarding_dropout_reason", { length: 50 }),
  onboarding_dropout_notes: text("onboarding_dropout_notes"),
  interest_level: varchar("interest_level", { length: 20 }),
  // E-168: intent-qualification band model. `intent_band` is the latest call's
  // band, `call_status` its complete|dropped_partial|dropped_empty status, and
  // `info_signals_count` (0–5) the disclosed-facts count used to order the
  // Qualified inside-sales queue (more facts disclosed = higher priority).
  intent_band: varchar("intent_band", { length: 20 }),
  call_status: varchar("call_status", { length: 20 }),
  info_signals_count: integer("info_signals_count"),
  // E-250 adds `intent_band_source`, `intent_overridden_by` and
  // `intent_overridden_at` to this table, and they are DELIBERATELY ABSENT
  // HERE — same reason as E-242's and E-224's columns above.
  //
  // The human override writes THROUGH to intent_band / final_intent_score
  // (that is the whole design: every existing reader picks up the corrected
  // value with no change). These three columns only record PROVENANCE, and are
  // read by one panel and one API route. Listing them here would hard-fail
  // every bare `db.select().from(dealerLeads)` at parse time on any database
  // without E-250 applied — taking the leads screen, the AI dialer and the CEO
  // overview down to add a label. Written and read via raw `sql` projections in
  // src/lib/leads/intentOverride.ts instead, so an unapplied E-250 costs the
  // intent-review feature and nothing else.
  preliminary_payment_intent: text("preliminary_payment_intent"),
  pre_transfer_status: varchar("pre_transfer_status", { length: 50 }),
  brochure_sent_at: timestamp("brochure_sent_at", { withTimezone: true }),
  // Ownership / attribution (BRD §0.3) — text matches dealer_leads.id type
  originator_id: text("originator_id"),
  current_owner_id: text("current_owner_id"),
  closing_owner_id: text("closing_owner_id"),
  closing_role: varchar("closing_role", { length: 50 }),
  ai_session_id: text("ai_session_id"),
  asm_id: text("asm_id"),
  assigned_at: timestamp("assigned_at", { withTimezone: true }),
  closed_at: timestamp("closed_at", { withTimezone: true }),
  last_touchpoint_at: timestamp("last_touchpoint_at", { withTimezone: true }),
  next_follow_up_at: timestamp("next_follow_up_at", { withTimezone: true }),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  // Escalation (BRD §0.6)
  escalation_status: varchar("escalation_status", { length: 30 }),
  escalation_count: integer("escalation_count").default(0),
  last_escalation_id: uuid("last_escalation_id"),
  // Cross-table links (BRD §0.4, §0.11)
  upload_batch_id: uuid("upload_batch_id"),
  dealer_onboarding_application_id: uuid("dealer_onboarding_application_id"),
  // Business profile (BRD §0.4)
  segments: jsonb("segments").default([]),
  address_history: jsonb("address_history").default([]),
  address_notes: text("address_notes"),
  // Soft delete (BRD §0.13)
  is_active: boolean("is_active").default(true),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
  // E-224 adds two more columns here — `neodove_synced_at` and
  // `neodove_sync_status` — that are DELIBERATELY NOT MIRRORED in this object.
  //
  // The usual rule is to mirror every migration here so types match the DB.
  // These two are the exception, because of how this table is read: ~20 call
  // sites do a bare `db.select().from(dealerLeads)` (the /leads list, the edit
  // page, both call schedulers, the CEO and role dashboards, the DigiLocker
  // callback, sales-insight, the converted-leads download). Drizzle expands a
  // bare select into an explicit column list, so naming a column here makes
  // EVERY one of those queries hard-fail with "column does not exist" until the
  // migration is hand-applied — and this repo has no migration runner, applies
  // by hand per environment, and has a documented history of migrations
  // silently not landing (the E-145 drift). Mirroring them traded a
  // write-only convenience column for a whole-app outage on any environment
  // that hadn't run E-224 yet. That is exactly what happened on database-1.
  //
  // They are written exclusively through raw `sql` UPDATEs in
  // src/lib/neodove/* and the NeoDove routes, all of which are unreachable
  // unless NEODOVE_ENABLED is set — so the coupling stays contained to the
  // feature that needs it. Same treatment as `duplicate_merge_requests`, which
  // is likewise absent here and written via raw SQL.
  //
  // If a future change needs to READ them through Drizzle, add them here AND
  // make E-224 a hard prerequisite in the deploy notes.
});

// Org-wide saved region groups for the AI dialer modal. `regions` is a
// JSONB array of { state, cities[] } — empty cities = "all cities in this
// state, resolved at query time". Created by E-106 migration.
export const regionGroups = pgTable("region_groups", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  description: text(),
  regions: jsonb().notNull().default([]),
  created_by: text("created_by"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

// Canonical location reference tables, created by E-108. Replace the
// hardcoded CITY_ALIASES / CITY_TO_STATE maps in scraper-enrichment.ts
// with DB-backed lookups consumed by src/lib/locations/normalize.ts. Source
// of truth is the migration; this TS mirror exists for type checking only.
export const states = pgTable("states", {
  code: text().primaryKey().notNull(),
  name: text().notNull().unique(),
  country: text().notNull().default("IN"),
  is_ut: boolean("is_ut").notNull().default(false),
  created_at: timestamp("created_at").defaultNow(),
});

export const cities = pgTable(
  "cities",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    state_code: text("state_code")
      .notNull()
      .references(() => states.code),
    lat: doublePrecision(),
    lng: doublePrecision(),
    // 'seed' for migration-seeded rows, 'google_places' for rows
    // auto-grown at promote time when Google addressComponents yields
    // a new city in a known state.
    source: text().default("seed"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (t) => ({
    uq_name_state: unique("cities_name_state_unique").on(t.name, t.state_code),
  }),
);

export const cityAliases = pgTable("city_aliases", {
  alias_lower: text("alias_lower").primaryKey().notNull(),
  city_id: text("city_id")
    .notNull()
    .references(() => cities.id),
  created_at: timestamp("created_at").defaultNow(),
});

// E-109 — persisted AI dialer campaigns. region_filter is the RegionSelection
// JSON emitted by DialerStartModal, stored verbatim so a historical campaign's
// scope is reproducible. Counters (calls_made / completed_leads / failed_leads)
// are bumped by the webhook handler as each call ends; status flips to
// 'completed' when the queue exhausts or 'stopped' when the user hits Stop.
export const dialerCampaigns = pgTable(
  "dialer_campaigns",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    triggered_by: uuid("triggered_by"),
    provider: text().notNull(),
    category: text(),
    region_filter: jsonb("region_filter"),
    status: text().notNull().default("running"),
    total_leads: integer("total_leads").notNull().default(0),
    calls_made: integer("calls_made").notNull().default(0),
    completed_leads: integer("completed_leads").notNull().default(0),
    failed_leads: integer("failed_leads").notNull().default(0),
    started_at: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    stopped_by: uuid("stopped_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // E-254 — execution type. Decides what happens when the window CLOSES:
    //   "now"       unscheduled, dial continuously (default, pre-E-228 behaviour)
    //   "single"    dial today's window once, then status="paused" until a human
    //   "recurring" dial every window_days day, auto-resuming, until the queue empties
    // Short-circuits the window predicate, so a "now" row ignores the columns below.
    schedule_mode: varchar("schedule_mode", { length: 16 })
      .notNull()
      .default("now"),
    // E-228 — per-campaign calling window. NULL on all three means UNSCHEDULED:
    // the campaign dials continuously, exactly as it did before E-228. Defaults
    // are pre-filled in the UI from assignment_config (E-120), not stored here.
    window_start: varchar("window_start", { length: 5 }), // "HH:MM" IST
    window_end: varchar("window_end", { length: 5 }), // "HH:MM" IST
    window_days: jsonb("window_days"), // ["mon","tue",…]
    // E-228 — pause/resume bookkeeping. status flips to 'scheduled' when the
    // window closes; the resume ticker claims on resume_after <= now().
    paused_at: timestamp("paused_at", { withTimezone: true }),
    resume_after: timestamp("resume_after", { withTimezone: true }),
    // E-228 — real activity timestamp. The stall watchdog measures inactivity
    // from COALESCE(last_advanced_at, started_at); without it, a campaign
    // resumed the morning after an overnight pause carries yesterday's
    // started_at and is force-stopped before placing its first call.
    last_advanced_at: timestamp("last_advanced_at", { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index("idx_dialer_campaigns_status").on(t.status),
    triggeredByStartedIdx: index(
      "idx_dialer_campaigns_triggered_by_started",
    ).on(t.triggered_by, t.started_at),
    startedAtIdx: index("idx_dialer_campaigns_started_at").on(t.started_at),
    // E-228 — the resume ticker's only predicate. Partial in the migration
    // (WHERE status = 'scheduled'); Drizzle's builder can't express that, so the
    // migration file is the source of truth for the WHERE clause.
    resumeIdx: index("idx_dialer_campaigns_resume").on(t.resume_after),
  }),
);

// E-109 — one row per (campaign, lead). lead_id is a soft FK to
// dealer_leads.id (no DB-level FK; see migration comment). The webhook
// handler resolves an active row for a lead via the partial index
// idx_dialer_campaign_leads_active when the Redis session is stale.
export const dialerCampaignLeads = pgTable(
  "dialer_campaign_leads",
  {
    id: text().primaryKey().notNull(),
    campaign_id: text("campaign_id")
      .notNull()
      .references(() => dialerCampaigns.id, { onDelete: "cascade" }),
    lead_id: text("lead_id").notNull(),
    queue_position: integer("queue_position").notNull(),
    status: text().notNull().default("pending"),
    bolna_call_id: text("bolna_call_id"),
    call_outcome: text("call_outcome"),
    intent_score: integer("intent_score"),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    campaignStatusIdx: index("idx_dialer_campaign_leads_campaign_status").on(
      t.campaign_id,
      t.status,
    ),
    campaignPositionIdx: index(
      "idx_dialer_campaign_leads_campaign_position",
    ).on(t.campaign_id, t.queue_position),
    leadStatusIdx: index("idx_dialer_campaign_leads_lead_status").on(
      t.lead_id,
      t.status,
    ),
  }),
);

export const scraperLeadsDuplicates = pgTable("scraper_leads_duplicates", {
  id: text().primaryKey().notNull(),
  original_lead_id: text("original_lead_id"),
  name: text(),
  phone: text(),
  email: text(),
  website: text(),
  city: text(),
  address: text(),
  source: text(),
  status: text(),
  created_at: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// --- NOTIFICATIONS ---

export const notifications = pgTable(
  "notifications",
  {
    id: text().primaryKey().notNull(),
    // The recipient LOGIN. Every row the notification hub writes sets this —
    // /api/notifications is scoped by user_id, so a row without it is invisible
    // in the bell. (That is exactly why dealer notifications, which used to set
    // only dealer_id, never appeared.) See src/lib/notifications/emit.ts.
    user_id: uuid("user_id"),
    dealer_id: varchar("dealer_id", { length: 255 }),
    lead_id: varchar("lead_id", { length: 100 }),
    // `<domain>.<event>` — src/lib/notifications/catalog.ts. varchar(50): a
    // longer type string fails the INSERT with 22001.
    type: varchar({ length: 50 }).notNull(),
    title: text().notNull(),
    message: text().notNull(),
    // Carries the deep link (`href`), the provenance pair (`from`/`to`/`stage`)
    // and any inline `actions` the bell renders as buttons. Deliberately jsonb
    // rather than columns — see the E-211 header.
    data: jsonb(),
    read: boolean().default(false),
    read_at: timestamp("read_at", { withTimezone: true }),
    // E-200 — soft archive/delete for the buyback notification centre. NULL =
    // active / not deleted, so no backfill was needed. Both apply CRM-wide.
    archived_at: timestamp("archived_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  // E-211 — the four access paths the CRM-wide bell runs on every page load.
  (table) => ({
    userCreatedIdx: index("notifications_user_created_idx").on(table.user_id, table.created_at),
    leadIdx: index("notifications_lead_idx").on(table.lead_id, table.created_at),
    // The two partial indexes (user_unread, legacy_dealer) are created by the
    // migration; drizzle's builder has no partial-index syntax, so they are
    // intentionally absent here. The migration file is the source of truth.
  }),
);

// -----------------------------------------------------------------------------
// E-231 — per-dashboard control of which notification types reach the bell
// -----------------------------------------------------------------------------
// NO ROW = ENABLED. The table holds only decisions a human actually made, so a
// newly-added notification type is on everywhere the moment it exists and an
// unapplied migration is indistinguishable from today's behaviour. The reader
// (src/lib/notifications/access.ts) loads ONLY the enabled=false rows and fails
// open on any error — see the E-231 file for why that is not negotiable.
//
// `dashboard` is LOWER(users.role). The CHECK enforcing lowercase lives in the
// migration; drizzle's builder has no CHECK syntax, so it is intentionally
// absent here and the migration is the source of truth.
// -----------------------------------------------------------------------------

export const notificationAccess = pgTable(
  "notification_access",
  {
    dashboard: varchar({ length: 50 }).notNull(),
    notification_type: varchar("notification_type", { length: 50 }).notNull(),
    enabled: boolean().notNull().default(true),
    // users.id AS TEXT — matches assignment_config.updated_by on the same
    // settings screen, which joins u.id::text.
    updated_by: text("updated_by"),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.dashboard, table.notification_type] }),
  }),
);

export const scraperCityQueue = pgTable("scraper_city_queue", {
  id: text().primaryKey().notNull(),
  base_query: text("base_query").notNull(),
  state: text().notNull(),
  city: text().notNull(),
  full_query: text("full_query").notNull(),
  status: text().default('pending'),
  leads_found: integer("leads_found").default(0),
  new_leads: integer("new_leads").default(0),
  duplicates: integer().default(0),
  scraped_at: timestamp("scraped_at"),
  created_at: timestamp("created_at").defaultNow(),
});

// --- STEP 4: PRODUCT SELECTION (BRD V2 Part E) ---

export const productSelections = pgTable("product_selections", {
  id: varchar("id", { length: 255 }).primaryKey(), // PS-YYYYMMDD-NNN
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => leads.id, { onDelete: "cascade" })
    .notNull(),

  // Selected inventory
  battery_serial: varchar("battery_serial", { length: 255 }),
  charger_serial: varchar("charger_serial", { length: 255 }),
  paraphernalia: jsonb("paraphernalia"), // { digital_soc: 2, volt_soc: 0, harness: "type_b", accessories: [...] }

  // Classification (may differ from Step 1 if dealer changed category)
  category: varchar("category", { length: 100 }),
  // model_number — battery model identifier (e.g. '51.2V-105AH'). Renamed from
  // sub_category per Sync Audit G-05 (E-103); width widened to 100 to allow
  // INV models like 'Power Cube 1.4+'.
  model_number: varchar("model_number", { length: 100 }),

  // Pricing (snapshot at submission time)
  battery_price: decimal("battery_price", { precision: 12, scale: 2 }),
  charger_price: decimal("charger_price", { precision: 12, scale: 2 }),
  paraphernalia_cost: decimal("paraphernalia_cost", { precision: 12, scale: 2 }),
  dealer_margin: decimal("dealer_margin", { precision: 12, scale: 2 }),
  // E-273: GST on the dealer margin (18%). final_price = net_subtotal + dealer_margin + dealer_margin_gst_amount.
  // NULL on rows written before E-273 (= 0; their final_price stays what the customer approved).
  dealer_margin_gst_percent: decimal("dealer_margin_gst_percent", { precision: 5, scale: 2 }),
  dealer_margin_gst_amount: decimal("dealer_margin_gst_amount", { precision: 12, scale: 2 }),
  final_price: decimal("final_price", { precision: 12, scale: 2 }),

  // GST snapshot — per-line gross / GST / net captured at submission so the
  // admin product panel renders exactly what the dealer saw, even if pricing
  // changes later in inventory/products.
  battery_gross: decimal("battery_gross", { precision: 12, scale: 2 }),
  battery_gst_percent: decimal("battery_gst_percent", { precision: 5, scale: 2 }),
  battery_gst_amount: decimal("battery_gst_amount", { precision: 12, scale: 2 }),
  battery_net: decimal("battery_net", { precision: 12, scale: 2 }),
  charger_gross: decimal("charger_gross", { precision: 12, scale: 2 }),
  charger_gst_percent: decimal("charger_gst_percent", { precision: 5, scale: 2 }),
  charger_gst_amount: decimal("charger_gst_amount", { precision: 12, scale: 2 }),
  charger_net: decimal("charger_net", { precision: 12, scale: 2 }),
  // Per-line paraphernalia: [{ asset_type, model_type, product_name, qty,
  //   unit_gross, gst_percent, gst_amount, line_gross, line_net }]
  paraphernalia_lines: jsonb("paraphernalia_lines"),
  gross_subtotal: decimal("gross_subtotal", { precision: 12, scale: 2 }),
  gst_subtotal: decimal("gst_subtotal", { precision: 12, scale: 2 }),
  net_subtotal: decimal("net_subtotal", { precision: 12, scale: 2 }),

  // Lifecycle
  payment_mode: varchar("payment_mode", { length: 20 }), // cash, finance
  // DEPRECATED by Addendum V0.1 §5.1 (E-130). Admin no longer acts on product
  // selection. Column kept until the new flow ships and is proven; a follow-up
  // migration removes it after Phase 5 is live.
  admin_decision: varchar("admin_decision", { length: 30 }).default("pending"),
  submitted_by: uuid("submitted_by"),
  submitted_at: timestamp("submitted_at", { withTimezone: true }).defaultNow(),

  // E-130 — Addendum V0.1 §5.1, §5.3. Battery/charger photos are dealer-captured
  // at premises during Product Selection Sections B/C. selected_nbfcs holds the
  // 1 or 2 NBFCs the customer picked at the new Section G; customer_disclosure_ack
  // is the mandatory checkbox confirming the customer was told each NBFC verifies
  // independently. All four are populated by the Phase 2 UI.
  battery_photo_urls: jsonb("battery_photo_urls"),
  charger_photo_urls: jsonb("charger_photo_urls"),
  selected_nbfcs: jsonb("selected_nbfcs"),
  customer_disclosure_ack: boolean("customer_disclosure_ack"),
  // E-208 — optional Step-4 pre-sanction document bucket (≤10 items, all formats:
  // image/video/zip/pdf; a combined PDF counts as one). Array of
  // { url, name, type, size }. Viewable by the NBFC (Acquire dossier) + admin.
  pre_sanction_doc_urls: jsonb("pre_sanction_doc_urls").default(sql`'[]'::jsonb`),
  // E-275 — off-platform lender ("Bajaj Finance") chosen when no partner
  // serves the customer. selected_nbfcs is [] and no assignment is created.
  external_lender: varchar("external_lender", { length: 64 }),

  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- STEP 4: LOAN SANCTION (Admin-created, distinct from loanOffers) ---

export const loanSanctions = pgTable("loan_sanctions", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  product_selection_id: varchar("product_selection_id", { length: 255 }),
  loan_amount: numeric("loan_amount", { precision: 12, scale:  2 }),
  down_payment: numeric("down_payment", { precision: 12, scale:  2 }),
  file_charge: numeric("file_charge", { precision: 12, scale:  2 }),
  subvention: numeric({ precision: 12, scale:  2 }),
  disbursement_amount: numeric("disbursement_amount", { precision: 12, scale:  2 }),
  emi: numeric({ precision: 12, scale:  2 }),
  tenure_months: integer("tenure_months"),
  roi: numeric({ precision: 5, scale:  2 }),
  loan_approved_by: text("loan_approved_by"),
  loan_file_number: varchar("loan_file_number", { length: 100 }),
  status: varchar({ length: 30 }).default('sanctioned').notNull(),
  rejection_reason: text("rejection_reason"),
  sanctioned_by: uuid("sanctioned_by"),
  // E-130 — Addendum §10/10 reconcile. `sanctioned_by` previously implied an
  // admin user; under the addendum NBFC users sanction too. Discriminator
  // resolves which user table the uuid points at. NULL on legacy rows = admin.
  sanctioned_by_type: varchar("sanctioned_by_type", { length: 20 }),
  sanctioned_at: timestamp("sanctioned_at", { withTimezone: true }).defaultNow(),
  dealer_approved: boolean("dealer_approved").default(false),
  dealer_approved_at: timestamp("dealer_approved_at", { withTimezone: true }),
  dealer_approved_by: uuid("dealer_approved_by"),
  // E-026 prereq (G-03): tenant scoping + lifecycle markers required by BRD §6.1.3.
  nbfc_id: uuid("nbfc_id"),
  disbursed_at: timestamp("disbursed_at", { withTimezone: true }),
  closed_at: timestamp("closed_at", { withTimezone: true }),
  // E-035 (BRD §6.1.6): permanent recovery-flag markers — once set the row
  // records a non-reversible recovery decision by the Risk Head.
  recovery_flagged_at: timestamp("recovery_flagged_at", { withTimezone: true }),
  recovery_reason: text("recovery_reason"),
  // E-275 — loan written off-platform (e.g. 'Bajaj Finance'); nbfc_id NULL.
  external_lender: varchar("external_lender", { length: 64 }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- STEP 5: OTP CONFIRMATION (dispatch authorisation) ---

export const otpConfirmations = pgTable("otp_confirmations", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }).notNull(),
  otp_type: varchar("otp_type", { length: 50 }).default('dispatch_confirmation').notNull(),
  otp_hash: varchar("otp_hash", { length: 255 }).notNull(),
  phone_sent_to: varchar("phone_sent_to", { length: 20 }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  send_count: integer("send_count").default(1).notNull(),
  attempt_count: integer("attempt_count").default(0).notNull(),
  locked_until: timestamp("locked_until", { withTimezone: true }),
  is_used: boolean("is_used").default(false).notNull(),
  used_at: timestamp("used_at", { withTimezone: true }),
  used_by: uuid("used_by"),
  override_by_admin: boolean("override_by_admin").default(false),
  override_reason: text("override_reason"),
  override_by: uuid("override_by"),
});

// --- STEP 5: AFTER-SALES RECORDS (post-dispatch service handle) ---

export const afterSalesRecords = pgTable("after_sales_records", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  lead_id: varchar("lead_id", { length: 255 }),
  warranty_id: varchar("warranty_id", { length: 255 }),
  battery_serial: varchar("battery_serial", { length: 255 }),
  customer_id: varchar("customer_id", { length: 255 }),
  dealer_id: varchar("dealer_id", { length: 255 }),
  payment_mode: varchar("payment_mode", { length: 20 }),
  opened_at: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar({ length: 20 }).default('active').notNull(),
  closed_at: timestamp("closed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// =============================================================================
// NBFC RISK DASHBOARD (Phase A — see docs/NBFC_DASHBOARD_PLAN.md)
// =============================================================================
// Adds five tables for the multi-tenant NBFC partner dashboard at /nbfc/*.
// Tenant scoping is enforced in application code (drizzle where-clauses) until
// Phase C wires NBFC partner auth and we move to Postgres RLS.
//
// users.role gets a new value 'nbfc_partner' — no enum to migrate, role is
// already varchar(50).
// =============================================================================

// One row per NBFC partner.
//
// E-080 (BRD §6.4.2) — Mandatory compliance metadata renderer for borrower-impacting
// screens. RBI Digital Lending Directions 2025 require the formal registered NBFC
// legal name, RBI registration number, and grievance channel (URL + helpline) on
// every borrower-facing communication. `display_name` is a brand label; the four
// columns below carry the regulatory-grade identity that compliance screens render.
export const nbfcTenants = pgTable("nbfc_tenants", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  slug: text().notNull(),
  display_name: text("display_name").notNull(),
  contact_email: text("contact_email"),
  aum_inr: numeric("aum_inr", { precision: 16, scale:  2 }),
  active_loans: integer("active_loans").default(0).notNull(),
  is_active: boolean("is_active").default(true).notNull(),
  // E-080 — RBI DLD 2025 mandatory compliance identity columns.
  nbfc_legal_name: varchar("nbfc_legal_name", { length: 255 }),
  rbi_registration_no: varchar("rbi_registration_no", { length: 64 }),
  grievance_url: text("grievance_url"),
  grievance_helpline: varchar("grievance_helpline", { length: 32 }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// E-080 (BRD §6.4.2) — Versioned compliance copy, keyed by screen.
// One row per (tenant, screen_key, version). The latest active row by
// effective_from supplies the body_text rendered on every borrower-facing
// screen so that authoritative wording stays consistent and changes are
// audit-trailed. `screen_key` matches the API enum:
//   immobilisation_confirm | collection_sms | telemetry_view |
//   portal_footer | recovery_call | sms_template
export const nbfcComplianceText = pgTable(
  "nbfc_compliance_text",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull().references(() => nbfcTenants.id),
    screen_key: varchar("screen_key", { length: 64 }).notNull(),
    body_text: text("body_text").notNull(),
    version: integer("version").default(1).notNull(),
    effective_from: timestamp("effective_from", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantScreenIdx: index("nbfc_compliance_text_tenant_screen_idx").on(
      table.tenant_id,
      table.screen_key,
    ),
    effectiveIdx: index("nbfc_compliance_text_effective_idx").on(table.effective_from),
  }),
);

// Many-to-many between users and tenants. Most NBFC partner users belong to
// exactly one tenant; some Itarang internal operators may belong to many.
export const nbfcUsers = pgTable(
  "nbfc_users",
  {
    user_id: uuid("user_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    role: varchar({ length: 32 }).default('viewer').notNull(),
    // E-162 — optional custom RBAC role. NULL ⇒ run on the `role` string
    // default (every existing row); set ⇒ fine-grained permissions from
    // nbfc_role_permissions. role still drives the legacy coarse checks.
    role_id: uuid("role_id"),
    notification_prefs: jsonb("notification_prefs").default({}).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userTenantIdx: index("nbfc_users_user_tenant_idx").on(table.user_id, table.tenant_id),
    tenantIdx: index("nbfc_users_tenant_idx").on(table.tenant_id),
  }),
);

// E-162 — NBFC Custom RBAC (§15.8). Tenant-scoped custom roles cloned from a
// system role; the five system roles are CODE defaults (src/lib/nbfc/permissions.ts)
// and are NOT stored here. base_role maps a custom role back to a system role
// for the legacy coarse role checks; fine-grained access comes from
// nbfcRolePermissions.
export const nbfcRoles = pgTable(
  "nbfc_roles",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull().references(() => nbfcTenants.id),
    name: varchar("name", { length: 64 }).notNull(),
    description: text("description"),
    base_role: varchar("base_role", { length: 32 }).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_roles_tenant_idx").on(table.tenant_id, table.is_active),
  }),
);

export const nbfcRolePermissions = pgTable(
  "nbfc_role_permissions",
  {
    role_id: uuid("role_id").notNull().references(() => nbfcRoles.id, { onDelete: "cascade" }),
    permission_key: varchar("permission_key", { length: 64 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.role_id, table.permission_key] }),
  }),
);

// E-163 — Per-NBFC Notification Channels (§15.5). One row per tenant. The
// channel resolver falls back to the platform-global env gateway when a row is
// absent or a channel is left on its '*_default' mode, so existing sends are
// unchanged until an NBFC opts in.
export const nbfcNotificationChannels = pgTable(
  "nbfc_notification_channels",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull().references(() => nbfcTenants.id),
    email_mode: varchar("email_mode", { length: 16 }).default("itarang_default").notNull(),
    email_from: text("email_from"),
    email_from_name: text("email_from_name"),
    smtp_host: text("smtp_host"),
    smtp_port: integer("smtp_port"),
    smtp_user: text("smtp_user"),
    smtp_pass: text("smtp_pass"),
    smtp_secure: boolean("smtp_secure").default(false).notNull(),
    sms_provider: varchar("sms_provider", { length: 24 }).default("itarang_default").notNull(),
    sms_api_key: text("sms_api_key"),
    sms_source: text("sms_source"),
    sms_dlt_template_id: text("sms_dlt_template_id"),
    whatsapp_enabled: boolean("whatsapp_enabled").default(false).notNull(),
    whatsapp_provider: varchar("whatsapp_provider", { length: 24 }),
    whatsapp_waba_id: text("whatsapp_waba_id"),
    whatsapp_api_key: text("whatsapp_api_key"),
    whatsapp_from: text("whatsapp_from"),
    whatsapp_templates: jsonb("whatsapp_templates"),
    notification_email: text("notification_email"), // E-276 — recipient for NBFC event emails
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantUnique: uniqueIndex("nbfc_notification_channels_tenant_unique").on(table.tenant_id),
  }),
);

// E-131 — Addendum V0.1 §6 (Competitive NBFC Routing). One row per
// (lead × selected NBFC) created when the dealer submits Step 4 for a finance
// lead. Drives the Acquire queue at /nbfc/acquire. tenant_id is denormalised
// from nbfc.tenant_id for tenant-scoped index performance; see E-131.sql
// header for the backfill query if an nbfc is ever repointed.
export const nbfcLeadAssignments = pgTable(
  "nbfc_lead_assignments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    loan_product_id: integer("loan_product_id"),
    // Lifecycle: pending → in_progress → offer_submitted → selected |
    // not_selected | declined | withdrawn. A1 only writes 'pending'; later
    // phases drive the rest. CHECK constraint lives on the DB side (E-131).
    // E-245: 'withdrawn' = the DEALER closed the deal with this lender
    // (decision_reason='dealer_closed_deal'), freeing one of the two lender
    // slots so the lead can be re-routed. Distinct from 'not_selected', which
    // means it lost to a chosen winner.
    status: varchar({ length: 30 }).default("pending").notNull(),
    assigned_at: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    decision_reason: text("decision_reason"),
    // E-133 / Addendum V0.2 §7.4 — frozen copy of the NBFC's service-opt-in
    // toggles at the moment this lead bound to the NBFC. Config edits apply to
    // NEW leads only; in-flight leads read this snapshot. Nullable for rows
    // created before E-133.
    service_config_snapshot: jsonb("service_config_snapshot"),
    // E-275 — NBFC rejected the file (status='declined',
    // decision_reason='nbfc_rejected'). The rejection waits with the admin
    // until forwarded to the dealer by a human or by the SLA sweep.
    rejection_note: text("rejection_note"),
    rejection_admin_due_at: timestamp("rejection_admin_due_at", { withTimezone: true }),
    rejection_forwarded_at: timestamp("rejection_forwarded_at", { withTimezone: true }),
    rejection_forward_source: varchar("rejection_forward_source", { length: 16 }), // 'admin' | 'system'
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_lead_assignments_tenant_idx").on(
      table.tenant_id,
      table.status,
      table.assigned_at,
    ),
    leadIdx: index("nbfc_lead_assignments_lead_idx").on(table.lead_id),
    leadNbfcUnique: uniqueIndex("nbfc_lead_assignments_unique_lead_nbfc").on(
      table.lead_id,
      table.nbfc_id,
    ),
  }),
);

// E-140 — Addendum V0.2 §6.1 (Competitive Routing, Stage 1). Firm financing
// conditions an NBFC submits for a routed lead. One operative row per
// nbfcLeadAssignments (unique on assignment_id); resubmission updates it. The
// dealer compares offers across picked NBFCs and selects the winner, which
// flips nbfcLeadAssignments.status to selected/not_selected.
export const nbfcFinancingOffers = pgTable(
  "nbfc_financing_offers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    assignment_id: uuid("assignment_id").notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    roi_pct: numeric("roi_pct", { precision: 5, scale: 2 }),
    emi_amount: numeric("emi_amount", { precision: 14, scale: 2 }),
    tenure_months: integer("tenure_months"),
    loan_amount: numeric("loan_amount", { precision: 14, scale: 2 }),
    down_payment: numeric("down_payment", { precision: 14, scale: 2 }),
    processing_fee: numeric("processing_fee", { precision: 14, scale: 2 }),
    conditions: text("conditions"),
    valid_until: date("valid_until"),
    status: varchar({ length: 16 }).default("active").notNull(), // 'active' | 'withdrawn'
    // E-161 — iTarang CEO approval gate for out-of-band deviations (§13.3.4).
    // ceo_approval_status: not_required | pending | approved | rejected. An offer
    // is released to the dealer only when not_required or approved. deviation_*
    // capture why it tripped the gate; ceo_* the platform-CEO decision.
    deviation_detected: boolean("deviation_detected").default(false).notNull(),
    deviation_fields: jsonb("deviation_fields"),
    deviation_reason: text("deviation_reason"),
    ceo_approval_status: varchar("ceo_approval_status", { length: 24 }).default("not_required").notNull(),
    ceo_approval_request_id: uuid("ceo_approval_request_id"),
    ceo_decided_by: uuid("ceo_decided_by"),
    ceo_decided_at: timestamp("ceo_decided_at", { withTimezone: true }),
    submitted_by: uuid("submitted_by"),
    submitted_at: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    // E-238 — dealer <-> NBFC negotiation state for THIS offer. The round-by-round
    // history lives in nbfcOfferNegotiations; these four are the current state.
    // negotiation_status: open (dealer may ask for a revision) | dealer_countered
    // (NBFC to respond) | fixed (NBFC froze the terms — neither side can change
    // them and the dealer's Negotiate action disappears; winner selection still
    // allowed) | closed (E-245: the dealer ended the deal — terminal, set with
    // status='withdrawn' here and on the assignment). A fixed offer can still be
    // closed: fixing freezes the numbers, not the customer's decision.
    negotiation_status: varchar("negotiation_status", { length: 16 }).default("open").notNull(),
    negotiation_round: integer("negotiation_round").default(0).notNull(),
    fixed_at: timestamp("fixed_at", { withTimezone: true }),
    fixed_by: uuid("fixed_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    assignmentUnique: uniqueIndex("nbfc_financing_offers_assignment_unique").on(table.assignment_id),
    leadIdx: index("nbfc_financing_offers_lead_idx").on(table.lead_id),
    tenantIdx: index("nbfc_financing_offers_tenant_idx").on(table.tenant_id),
    ceoStatusIdx: index("nbfc_financing_offers_ceo_status_idx").on(table.ceo_approval_status),
  }),
);

// E-238 — append-only round log of the dealer <-> NBFC negotiation over one firm
// financing offer. nbfcFinancingOffers is UNIQUE on assignment_id and the submit
// route upserts in place, so every resubmit destroys the previous terms — this
// table is where the history that a disputed sanction turns on actually lives.
//
// Each row is a FULL snapshot of the terms one party put on the table at one
// moment (not a per-field ask/counter pair like vendorThreadLines): a financing
// offer is six interdependent numbers negotiated as a set, and the UI diffs
// consecutive rounds to surface only what changed.
//
// INVARIANT: a round is written only when its terms are visible to the dealer.
// While E-161 holds an out-of-band offer at ceo_approval_status='pending' the
// dealer cannot see it, so no round is appended until the iTarang CEO approves.
//
// The unique index on (offer_id, round) is a concurrency guard, not tidiness —
// the round written is always negotiation_round + 1, so two simultaneous submits
// must collide with 23505 rather than both claim the same round.
export const nbfcOfferNegotiations = pgTable(
  "nbfc_offer_negotiations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    offer_id: uuid("offer_id").notNull(),
    assignment_id: uuid("assignment_id").notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    round: integer("round").notNull(),
    // 'nbfc' | 'dealer' | 'customer' (E-265 — the borrower writing from their
    // own WhatsApp chat). No CHECK; the vocabulary is enforced in the service.
    party: varchar("party", { length: 8 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(), // 'offer' | 'counter' | 'fix'
    loan_amount: numeric("loan_amount", { precision: 14, scale: 2 }),
    roi_pct: numeric("roi_pct", { precision: 5, scale: 2 }),
    emi_amount: numeric("emi_amount", { precision: 14, scale: 2 }),
    tenure_months: integer("tenure_months"),
    down_payment: numeric("down_payment", { precision: 14, scale: 2 }),
    processing_fee: numeric("processing_fee", { precision: 14, scale: 2 }),
    conditions: text("conditions"),
    message: text("message"),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    offerRoundUnique: uniqueIndex("nbfc_offer_negotiations_offer_round_uidx").on(
      table.offer_id,
      table.round,
    ),
    offerIdx: index("nbfc_offer_negotiations_offer_idx").on(table.offer_id),
    leadIdx: index("nbfc_offer_negotiations_lead_idx").on(table.lead_id),
    tenantIdx: index("nbfc_offer_negotiations_tenant_idx").on(table.tenant_id),
  }),
);

// E-133 — Addendum V0.2 §7.4. Per-NBFC Service Opt-In + document/track config.
// One row per tenant; an absent row means every service is off (the NBFC runs
// each step off-platform its own way). vkyc_mode / enach_* / doc_agreement_method
// CHECK constraints live on the DB side (E-133). Edits apply to NEW leads only —
// in-flight leads read nbfcLeadAssignments.service_config_snapshot.
export const nbfcServiceConfig = pgTable(
  "nbfc_service_config",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull().references(() => nbfcTenants.id),
    fi_enabled: boolean("fi_enabled").default(false).notNull(),
    vkyc_enabled: boolean("vkyc_enabled").default(false).notNull(),
    vkyc_mode: varchar("vkyc_mode", { length: 16 }), // 'own' | 'itarang'
    enach_enabled: boolean("enach_enabled").default(false).notNull(),
    enach_handoff_method: varchar("enach_handoff_method", { length: 16 }), // 'redirect' | 'webhook' | 'itarang_razorpay'
    enach_endpoint_url: text("enach_endpoint_url"),
    doc_agreement_method: varchar("doc_agreement_method", { length: 24 }), // 'upload' | 'digio' | 'api_autofetch' | 'own_esign' (E-165)
    // E-165 — bring-your-own-provider handoff. Endpoint URLs the NBFC's OWN
    // provider is reached at when a rail is in "own" mode (vkyc_mode='own' /
    // doc_agreement_method='own_esign'); read live (NOT snapshotted). The
    // *_webhook_secret are iTarang-minted HMAC secrets for signing outbound
    // handoffs + verifying inbound result callbacks. NBFC API keys are NEVER
    // stored — only these URLs + secrets.
    vkyc_endpoint_url: text("vkyc_endpoint_url"),
    esign_endpoint_url: text("esign_endpoint_url"),
    vkyc_webhook_secret: text("vkyc_webhook_secret"),
    enach_webhook_secret: text("enach_webhook_secret"),
    esign_webhook_secret: text("esign_webhook_secret"),
    // E-166 — which e-sign provider the NBFC's loan agreements use (their own
    // Digio account / Leegality / …). NULL ⇒ 'digio' = iTarang's global account
    // (today's behaviour). Only meaningful when doc_agreement_method='digio'.
    esign_provider: varchar("esign_provider", { length: 24 }),
    store_sanction_letter: boolean("store_sanction_letter").default(false).notNull(),
    store_loan_agreement: boolean("store_loan_agreement").default(false).notNull(),
    // E-205 — the NBFC's own DPDP consent-template PDF (uploaded once in Settings,
    // reused across all leads for the Acquire e-sign/OTP consent flow). Stored in
    // the private nbfc-documents bucket; URL is the /nbfc-uploads/<key> proxy path.
    consent_template_url: text("consent_template_url"),
    consent_template_size: integer("consent_template_size"),
    track_completion_gate: boolean("track_completion_gate").default(true).notNull(),
    track_failure_halts: boolean("track_failure_halts").default(false).notNull(),
    // E-148 §10.7/§15.4.2 — per-NBFC FI agent-form + review parameters.
    // { reinspection_cap: number|null, gps_denied_block: boolean,
    //   camera_only: boolean, required_photos: string[] }
    fi_config: jsonb("fi_config").default(
      sql`'{"reinspection_cap": null, "gps_denied_block": true, "camera_only": true, "required_photos": ["exterior", "customer_at_residence", "corroborator", "agent_selfie"]}'::jsonb`,
    ).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantUnique: uniqueIndex("nbfc_service_config_tenant_unique").on(table.tenant_id),
  }),
);

// E-166 — per-tenant ENCRYPTED e-sign provider credentials (Model B). An NBFC's
// own provider keys (Leegality token, own Digio client id/secret, …) stored as
// an AES-256-GCM blob (see src/lib/nbfc/esign/crypto.ts); never plaintext.
// Absence of a row ⇒ iTarang's global Digio account (the fallback).
export const nbfcProviderCredentials = pgTable(
  "nbfc_provider_credentials",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull().references(() => nbfcTenants.id),
    provider_type: varchar("provider_type", { length: 24 }).notNull(), // 'digio' | 'leegality' | …
    environment: varchar("environment", { length: 12 }).default("sandbox").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    auth_tag: text("auth_tag").notNull(),
    key_version: integer("key_version").default(1).notNull(),
    label: text("label"),
    last_tested_at: timestamp("last_tested_at", { withTimezone: true }),
    last_test_ok: boolean("last_test_ok"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantProviderUnique: uniqueIndex("nbfc_provider_credentials_tenant_provider_unique").on(
      table.tenant_id,
      table.provider_type,
    ),
  }),
);

// E-133 — Addendum V0.2 §7.2. Per-NBFC step ownership: a default owner per step
// (city IS NULL) plus optional city-wise overrides. Owner is notified +
// accountable; any user with the role may act so work doesn't stall. The
// partial unique indexes (default-per-step, city-per-step) live on the DB side.
export const nbfcStepOwners = pgTable(
  "nbfc_step_owners",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull().references(() => nbfcTenants.id),
    step: varchar("step", { length: 16 }).notNull(), // 'fi' | 'vkyc' | 'enach'
    city: varchar("city", { length: 120 }),
    user_id: uuid("user_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_step_owners_tenant_idx").on(table.tenant_id),
  }),
);

// E-134 — Addendum V0.2 §9. E-NACH mandate registration (Model B2-B): the
// WINNING NBFC owns the mandate on its own credentials; iTarang triggers +
// records only. One row per attempt (§9.6) — retries create new rows, latest
// (by created_at) is operative. `status` is the canonical state all gates read;
// provider_raw_* is display/audit only and is never branched on (§9.3). The
// status / registration_method CHECK constraints live on the DB side (E-134).
export const enachMandates = pgTable(
  "enach_mandates",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    enach_ref: varchar("enach_ref", { length: 64 }).notNull(),
    // 'not_applicable' | 'pending' | 'in_progress' | 'registered' | 'failed' | 'skipped'
    status: varchar({ length: 20 }).default("pending").notNull(),
    umrn: varchar({ length: 64 }),
    bank_name: varchar("bank_name", { length: 120 }),
    account_masked: varchar("account_masked", { length: 64 }),
    max_amount: numeric("max_amount", { precision: 14, scale: 2 }),
    valid_from: date("valid_from"),
    valid_to: date("valid_to"),
    provider_name: varchar("provider_name", { length: 80 }),
    provider_raw_status: varchar("provider_raw_status", { length: 120 }),
    provider_raw_payload: jsonb("provider_raw_payload"),
    registration_method: varchar("registration_method", { length: 16 }), // 'callback' | 'manual' | 'razorpay'
    // E-145 — "iTarang Razorpay (managed)" variant: iTarang creates + tracks the
    // e-mandate itself via Razorpay Orders + Tokens. Correlation handles only;
    // canonical `status` (above) still drives every gate (§9.3).
    razorpay_order_id: varchar("razorpay_order_id", { length: 64 }),
    razorpay_customer_id: varchar("razorpay_customer_id", { length: 64 }),
    razorpay_token_id: varchar("razorpay_token_id", { length: 64 }),
    proof_url: text("proof_url"),
    failure_reason: text("failure_reason"),
    stale_risk: boolean("stale_risk").default(false).notNull(),
    registration_date: timestamp("registration_date", { withTimezone: true }),
    triggered_by: uuid("triggered_by"),
    triggered_at: timestamp("triggered_at", { withTimezone: true }),
    registered_at: timestamp("registered_at", { withTimezone: true }),
    skip_reason: text("skip_reason"),
    skipped_by: uuid("skipped_by"),
    skipped_at: timestamp("skipped_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    refUnique: uniqueIndex("enach_mandates_ref_unique").on(table.enach_ref),
    leadNbfcIdx: index("enach_mandates_lead_nbfc_idx").on(table.lead_id, table.nbfc_id),
    tenantStatusIdx: index("enach_mandates_tenant_status_idx").on(table.tenant_id, table.status),
  }),
);

// E-146 — Addendum V0.2 §11. Sanction-letter / loan-agreement signing for the
// WINNING NBFC. iTarang facilitates + files but is never a party (§11.1). One
// row per attempt; canonical `status` drives the stepper sub-label. NOT a
// disbursal gate — §11.5 Step-5 OTP is. Storage optional (§11.4): when
// store_loan_agreement is false iTarang keeps only the §11.6 audit record.
export const nbfcLoanAgreements = pgTable(
  "nbfc_loan_agreements",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    agreement_ref: varchar("agreement_ref", { length: 64 }).notNull(),
    method: varchar({ length: 16 }), // 'upload' | 'digio' | 'api_autofetch' | 'own_esign' (E-165)
    // E-166 — e-sign provider that owns this attempt (NULL ⇒ legacy 'digio').
    provider_type: varchar("provider_type", { length: 24 }),
    // 'pending' | 'in_progress' | 'signed' | 'failed' | 'skipped'
    status: varchar({ length: 20 }).default("pending").notNull(),
    digio_document_id: varchar("digio_document_id", { length: 120 }),
    // E-151: the NBFC-uploaded UNSIGNED agreement PDF (iTarang eSign mechanism);
    // /initiate hands this to Digio uploadpdf for the customer + NBFC to sign.
    source_document_url: text("source_document_url"),
    signed_document_url: text("signed_document_url"),
    audit_trail_url: text("audit_trail_url"),
    provider_raw_status: varchar("provider_raw_status", { length: 120 }),
    provider_raw_payload: jsonb("provider_raw_payload"),
    store_sanction_letter: boolean("store_sanction_letter").default(false).notNull(),
    store_loan_agreement: boolean("store_loan_agreement").default(false).notNull(),
    failure_reason: text("failure_reason"),
    initiated_by: uuid("initiated_by"),
    initiated_at: timestamp("initiated_at", { withTimezone: true }),
    signed_at: timestamp("signed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    refUnique: uniqueIndex("nbfc_loan_agreements_ref_unique").on(table.agreement_ref),
    leadNbfcIdx: index("nbfc_loan_agreements_lead_nbfc_idx").on(table.lead_id, table.nbfc_id),
    digioDocIdx: index("nbfc_loan_agreements_digio_doc_idx").on(table.digio_document_id),
  }),
);

// E-135 — Addendum V0.2 §10. Video KYC track (Active Video Liveness), per
// (lead × NBFC). mode 'own' = B2-B trigger+record (NBFC's vendor); 'itarang' =
// iTarang's Decentro Active Liveness. Canonical `status` drives all logic;
// provider_raw_* is display/audit only. status/mode CHECKs live on the DB side.
export const videoKycVerifications = pgTable(
  "video_kyc_verifications",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    vkyc_ref: varchar("vkyc_ref", { length: 64 }).notNull(),
    mode: varchar({ length: 16 }).notNull(), // 'own' | 'itarang' | 'passive' (E-153)
    // 'not_applicable' | 'pending' | 'in_progress' | 'verified' | 'failed'
    status: varchar({ length: 20 }).default("pending").notNull(),
    match_score: numeric("match_score", { precision: 5, scale: 2 }),
    liveliness: varchar({ length: 16 }),
    static_risk: boolean("static_risk"),
    prerecorded_risk: boolean("prerecorded_risk"),
    face_match_score: numeric("face_match_score", { precision: 5, scale: 2 }),
    geo_location: jsonb("geo_location"),
    provider_name: varchar("provider_name", { length: 80 }),
    provider_raw_status: varchar("provider_raw_status", { length: 120 }),
    provider_raw_payload: jsonb("provider_raw_payload"),
    failure_reason: text("failure_reason"),
    // E-154 — Addendum V0.3.1 §11.3.4/§11.6 "Session Video". The customer's
    // recorded passive-liveness clip, stored in the nbfc-documents bucket and
    // served via /api/nbfc-uploads/<key>. Null for active/own modes where no
    // local video exists (review screen hides the block).
    session_video_url: text("session_video_url"),
    // E-152 — passive VKYC link lifecycle (Addendum V0.3.1 §11). The single-use
    // capture link (token = vkyc_ref) is delivered over one of these channels.
    link_channel: varchar("link_channel", { length: 16 }), // 'sms' | 'email' | 'whatsapp'
    link_sent_at: timestamp("link_sent_at", { withTimezone: true }),
    link_expires_at: timestamp("link_expires_at", { withTimezone: true }),
    triggered_by: uuid("triggered_by"),
    triggered_at: timestamp("triggered_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    admin_action: varchar("admin_action", { length: 16 }), // 'accepted' | 'rejected'
    admin_action_by: uuid("admin_action_by"),
    admin_action_at: timestamp("admin_action_at", { withTimezone: true }),
    admin_action_notes: text("admin_action_notes"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    leadNbfcUnique: uniqueIndex("video_kyc_verifications_lead_nbfc_unique").on(table.lead_id, table.nbfc_id),
    refUnique: uniqueIndex("video_kyc_verifications_ref_unique").on(table.vkyc_ref),
    tenantStatusIdx: index("video_kyc_verifications_tenant_status_idx").on(table.tenant_id, table.status),
  }),
);

// E-135 — Addendum V0.2 §10/§8.2. One row per VKYC SESSION RUN — the billing
// unit for the iTarang VKYC flat fee (charged on every run, incl. losing/failed).
export const videoKycAttempts = pgTable(
  "video_kyc_attempts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    verification_id: uuid("verification_id").notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    attempt_ref: varchar("attempt_ref", { length: 80 }),
    provider_txn_id: varchar("provider_txn_id", { length: 120 }),
    session_url: text("session_url"),
    status: varchar({ length: 20 }).default("in_progress").notNull(),
    provider_raw_status: varchar("provider_raw_status", { length: 120 }),
    provider_raw_payload: jsonb("provider_raw_payload"),
    charged: boolean("charged").default(false).notNull(),
    charged_ledger_id: uuid("charged_ledger_id"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    verificationIdx: index("video_kyc_attempts_verification_idx").on(table.verification_id),
    txnIdx: index("video_kyc_attempts_txn_idx").on(table.provider_txn_id),
  }),
);

// E-148 — Addendum V0.3.1 §10 (Field Investigation, Full Spec). Model C, pure
// record-only: the Coordinator picks an agent from nbfcFiAgents, iTarang sends a
// single-use link, the AGENT submits a mobile field form (GPS + watermarked
// photos in fieldInvestigationPhotos), and the Coordinator reviews + decides.
// NOW ONE ROW PER ATTEMPT per (lead × NBFC): is_current flags the operative
// attempt; re-inspection appends a new row (attempt_no+1). 8 canonical states
// (§10.4). status/address_match/decision CHECKs live on the DB side (E-148).
export const fieldInvestigations = pgTable(
  "field_investigations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    // not_applicable|pending|assigned|in_progress|submitted|passed|failed|re_inspection_requested
    // (E-150: widened 20→32 — 're_inspection_requested' is 23 chars.)
    status: varchar({ length: 32 }).default("pending").notNull(),
    attempt_no: integer("attempt_no").default(1).notNull(),
    is_current: boolean("is_current").default(true).notNull(),
    // assignment / SLA
    assigned_agent_id: uuid("assigned_agent_id"), // FK → nbfcFiAgents
    assigned_to: varchar("assigned_to", { length: 200 }), // denormalised agent name (legacy + display)
    assigned_by: uuid("assigned_by"),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),
    sla_due_at: timestamp("sla_due_at", { withTimezone: true }),
    sla_breached: boolean("sla_breached").default(false).notNull(),
    // single-use link
    link_token: varchar("link_token", { length: 80 }),
    link_sent_at: timestamp("link_sent_at", { withTimezone: true }),
    link_channel: varchar("link_channel", { length: 12 }), // email|sms|whatsapp
    link_expires_at: timestamp("link_expires_at", { withTimezone: true }),
    // agent field-form submission
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    visited_at: timestamp("visited_at", { withTimezone: true }),
    gps_lat: numeric("gps_lat", { precision: 10, scale: 7 }),
    gps_lng: numeric("gps_lng", { precision: 10, scale: 7 }),
    gps_accuracy_m: numeric("gps_accuracy_m", { precision: 8, scale: 2 }),
    gps_server_timestamp: timestamp("gps_server_timestamp", { withTimezone: true }),
    stated_lat: numeric("stated_lat", { precision: 10, scale: 7 }), // geocoded address anchor
    stated_lng: numeric("stated_lng", { precision: 10, scale: 7 }),
    distance_from_address_m: numeric("distance_from_address_m", { precision: 10, scale: 2 }),
    address_text_match: boolean("address_text_match"), // legacy (E-136)
    address_match: varchar("address_match", { length: 10 }), // matches|partial|no
    address_match_notes: text("address_match_notes"),
    customer_present: boolean("customer_present"),
    customer_present_notes: text("customer_present_notes"),
    agent_notes: text("agent_notes"),
    agent_declaration_at: timestamp("agent_declaration_at", { withTimezone: true }),
    proof_urls: jsonb("proof_urls"), // legacy (E-136); photos now in fieldInvestigationPhotos
    // Coordinator decision (§10.8.2)
    outcome: varchar({ length: 10 }), // legacy mirror: 'pass' | 'fail'
    decision: varchar("decision", { length: 16 }), // 'pass' | 'fail' | 're_inspection'
    decision_reason: text("decision_reason"),
    decided_by: uuid("decided_by"),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    reviewed_by: uuid("reviewed_by"), // legacy (E-136)
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
    // NBFC Admin reopen audit (§10.8.2)
    reopened_by: uuid("reopened_by"),
    reopened_at: timestamp("reopened_at", { withTimezone: true }),
    reopen_reason: text("reopen_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // one CURRENT attempt per (lead × NBFC); history rows are is_current=false
    currentUnique: uniqueIndex("field_investigations_current_unique")
      .on(table.lead_id, table.nbfc_id)
      .where(sql`is_current`),
    tenantStatusIdx: index("field_investigations_tenant_status_idx").on(table.tenant_id, table.status),
  }),
);

// E-148 — Addendum V0.3.1 §10.5/§10.9.3. Per-NBFC FI agent directory.
// Agents are NOT iTarang users (no login); lightweight contact records used for
// single-use link dispatch + Coordinator selfie reference comparison.
export const nbfcFiAgents = pgTable(
  "nbfc_fi_agents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    nbfc_id: integer("nbfc_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 20 }).notNull(),
    email: varchar("email", { length: 200 }),
    city: varchar("city", { length: 120 }),
    preferred_channel: varchar("preferred_channel", { length: 12 }).default("email").notNull(), // email|sms|whatsapp
    reference_photo_url: text("reference_photo_url"),
    active: boolean("active").default(true).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantActiveIdx: index("nbfc_fi_agents_tenant_active_idx").on(table.tenant_id, table.active),
  }),
);

// E-148 — Addendum V0.3.1 §10.9.2. One row per FI photo, watermarked with
// GPS + server timestamp at capture; structured GPS also stored.
export const fieldInvestigationPhotos = pgTable(
  "field_investigation_photos",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    field_investigation_id: uuid("field_investigation_id").notNull(),
    // exterior|customer_at_residence|corroborator|agent_selfie|extra
    photo_type: varchar("photo_type", { length: 24 }).notNull(),
    image_url: text("image_url").notNull(),
    gps_lat: numeric("gps_lat", { precision: 10, scale: 7 }),
    gps_lng: numeric("gps_lng", { precision: 10, scale: 7 }),
    gps_server_timestamp: timestamp("gps_server_timestamp", { withTimezone: true }),
    watermark_applied: boolean("watermark_applied").default(false).notNull(),
    exif_data: jsonb("exif_data"),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fiIdx: index("field_investigation_photos_fi_idx").on(table.field_investigation_id),
  }),
);

// E-137 — Addendum V0.2 §8.1. NBFC prepaid wallet (Model 1). One per tenant.
// An empty wallet blocks initiation of new chargeable activity; recharge via
// manual top-up or auto-NACH (NBFC sets threshold + recharge amount).
export const nbfcWallets = pgTable(
  "nbfc_wallets",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    balance: numeric("balance", { precision: 14, scale: 2 }).default("0").notNull(),
    currency: varchar({ length: 8 }).default("INR").notNull(),
    auto_nach_enabled: boolean("auto_nach_enabled").default(false).notNull(),
    auto_nach_threshold: numeric("auto_nach_threshold", { precision: 14, scale: 2 }),
    auto_nach_recharge_amount: numeric("auto_nach_recharge_amount", { precision: 14, scale: 2 }),
    auto_nach_mandate_ref: varchar("auto_nach_mandate_ref", { length: 120 }),
    // E-160 — §16.4 funds-provider handles. provider_name + the iTarang Virtual
    // Account (Smart Collect) display fields + the creditor-side auto-recharge
    // mandate handles. NBFC-facing UI must use "iTarang Virtual Account" /
    // "iTarang Auto-Recharge Mandate", never the vendor name (§3.2).
    provider_name: varchar("provider_name", { length: 40 }),
    va_provider_account_id: varchar("va_provider_account_id", { length: 64 }),
    va_upi_vpa: varchar("va_upi_vpa", { length: 120 }),
    va_account_number: varchar("va_account_number", { length: 40 }),
    va_ifsc: varchar("va_ifsc", { length: 20 }),
    va_status: varchar("va_status", { length: 24 }),
    auto_nach_customer_id: varchar("auto_nach_customer_id", { length: 64 }),
    auto_nach_token_id: varchar("auto_nach_token_id", { length: 64 }),
    auto_nach_order_id: varchar("auto_nach_order_id", { length: 64 }),
    auto_nach_status: varchar("auto_nach_status", { length: 24 }).default("none"), // none | pending | registered | failed
    auto_nach_last_fired_at: timestamp("auto_nach_last_fired_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantUnique: uniqueIndex("nbfc_wallets_tenant_unique").on(table.tenant_id),
  }),
);

// E-137 — Addendum V0.2 §8.2. Admin-maintained chargeable-item catalogue.
// tenant_id NULL = a global default item; non-null = a per-NBFC override.
// type / trigger / status CHECKs live on the DB side (E-137).
export const nbfcChargeCatalogue = pgTable(
  "nbfc_charge_catalogue",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id"),
    name: varchar({ length: 160 }).notNull(),
    type: varchar({ length: 20 }).notNull(), // service_usage | platform_fee | disbursal_fee | other
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    trigger: varchar({ length: 24 }).notNull(), // on_api_execution | on_vkyc_run | on_disbursal | monthly | manual
    status: varchar({ length: 12 }).default("active").notNull(), // active | inactive
    commercial_doc_url: text("commercial_doc_url"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantTriggerIdx: index("nbfc_charge_catalogue_tenant_trigger_idx").on(table.tenant_id, table.trigger, table.status),
  }),
);

// E-137 — Addendum V0.2 §8.2. Append-only wallet ledger. amount < 0 = debit,
// > 0 = credit (top-up). balance_after snapshots the running balance; `month`
// (YYYY-MM) groups the monthly GST statement. kind CHECK lives on the DB side.
export const nbfcWalletLedger = pgTable(
  "nbfc_wallet_ledger",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    catalogue_item_id: uuid("catalogue_item_id"),
    kind: varchar({ length: 20 }).notNull(), // charge | manual_deduction | topup | adjustment
    type: varchar({ length: 20 }),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    balance_after: numeric("balance_after", { precision: 14, scale: 2 }).notNull(),
    lead_id: varchar("lead_id", { length: 50 }),
    nbfc_id: integer("nbfc_id"),
    trigger_rule: varchar("trigger_rule", { length: 24 }),
    posted_by: uuid("posted_by"),
    month: varchar({ length: 7 }).notNull(),
    // E-160 — provider inflow correlation handle on top-up lines (§16.3 audit).
    provider_event_id: varchar("provider_event_id", { length: 120 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantMonthIdx: index("nbfc_wallet_ledger_tenant_month_idx").on(table.tenant_id, table.month),
    leadIdx: index("nbfc_wallet_ledger_lead_idx").on(table.lead_id),
  }),
);

// E-160 — Addendum V0.3.1 §16.3/§16.4. Idempotency + audit ledger for wallet
// money-IN (VA credits + recurring-debit settlements). The UNIQUE on
// (provider_name, provider_event_id) is the dedupe guarantee — a re-delivered
// webhook inserts ON CONFLICT DO NOTHING, so it cannot double-credit the wallet.
// ledger_id links to the topup line actually posted (NULL until posted).
export const nbfcWalletInflows = pgTable(
  "nbfc_wallet_inflows",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    nbfc_id: integer("nbfc_id"),
    provider_name: varchar("provider_name", { length: 40 }).notNull(),
    provider_event_id: varchar("provider_event_id", { length: 120 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    raw_status: varchar("raw_status", { length: 40 }),
    ledger_id: uuid("ledger_id"),
    raw_payload: jsonb("raw_payload"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    eventUnique: uniqueIndex("nbfc_wallet_inflows_event_unique").on(table.provider_name, table.provider_event_id),
    tenantIdx: index("nbfc_wallet_inflows_tenant_idx").on(table.tenant_id),
  }),
);

// E-138 — Addendum V0.2 §11.7. Manual Handoff (Model M2): routes a lead to
// off-platform NBFC(s) by email. Competitive; Sent → Outcome only (no
// intermediate status); a 24h recurring admin nudge runs until an outcome is
// recorded or the admin declares it exhausted. One row per lead. status CHECK
// lives on the DB side (E-138).
export const manualHandoffs = pgTable(
  "manual_handoffs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 50 }).notNull(),
    tenant_id: uuid("tenant_id"),
    // 'sent' | 'outcome_accepted' | 'outcome_declined' | 'exhausted'
    status: varchar({ length: 24 }).default("sent").notNull(),
    sent_to_emails: jsonb("sent_to_emails").notNull(),
    sent_by: uuid("sent_by"),
    sent_at: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    last_nudge_at: timestamp("last_nudge_at", { withTimezone: true }),
    nudge_count: integer("nudge_count").default(0).notNull(),
    outcome: text("outcome"),
    winning_nbfc_name: varchar("winning_nbfc_name", { length: 200 }),
    declining_nbfcs: jsonb("declining_nbfcs"),
    outcome_recorded_by: uuid("outcome_recorded_by"),
    outcome_recorded_at: timestamp("outcome_recorded_at", { withTimezone: true }),
    agreement_doc_url: text("agreement_doc_url"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    leadUnique: uniqueIndex("manual_handoffs_lead_unique").on(table.lead_id),
    statusNudgeIdx: index("manual_handoffs_status_nudge_idx").on(table.status, table.last_nudge_at),
  }),
);

// NBFC servicing ledger keyed by loan_application_id (the PK). That id comes
// from one of: an NBFC's own loan id (CSV import), or a loan_sanctions.id
// projected by the disbursement bridge (projectDisbursedLoan, §6.1.3). It is
// therefore NOT a FK to loan_applications — that legacy FK was dropped in E-144
// because the bridge keys it to loan_sanctions.id. One loan belongs to one NBFC.
export const nbfcLoans = pgTable(
  "nbfc_loans",
  {
    loan_application_id: varchar("loan_application_id", { length: 255 }).primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    vehicleno: varchar({ length: 64 }),
    emi_amount: numeric("emi_amount", { precision: 12, scale:  2 }),
    emi_due_date_dom: integer("emi_due_date_dom"),
    current_dpd: integer("current_dpd").default(0).notNull(),
    outstanding_amount: numeric("outstanding_amount", { precision: 14, scale:  2 }),
    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_loans_tenant_idx").on(table.tenant_id),
    vnoIdx: index("nbfc_loans_vno_idx").on(table.vehicleno),
    dpdIdx: index("nbfc_loans_dpd_idx").on(table.current_dpd),
  }),
);

// Hypothesis catalogue. Stable identity so cards can be tracked across runs.
// Initially seeded with 5 hand-coded entries; LangGraph proposes new ones over
// time and writes them here with source='llm-v1'.
export const riskHypotheses = pgTable("risk_hypotheses", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  slug: text().notNull(),
  title: text().notNull(),
  description: text().notNull(),
  test_method: varchar("test_method", { length: 16 }).notNull(),
  test_definition: jsonb("test_definition").notNull(),
  source: varchar({ length: 16 }).default('human').notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  retired_at: timestamp("retired_at", { withTimezone: true }),
  // E-188 — human-in-the-loop promotion. An llm-v1 hypothesis is capped at
  // severity=warn until a human vets it; only then can it raise a High Alert.
  // source='human' rows are promoted by definition (backfilled by the migration).
  promoted_at: timestamp("promoted_at", { withTimezone: true }),
  promoted_by: uuid("promoted_by"),
  retire_reason: text("retire_reason"),
});

// One row per (tenant, hypothesis, run). Risk page reads the latest run per
// (tenant, hypothesis); older runs serve as a time series for the audit page.
export const riskCardRuns = pgTable(
  "risk_card_runs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    hypothesis_id: uuid("hypothesis_id").notNull(),
    run_at: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    // high | warn | ok | inconclusive | error (E-185). `ok` means "tested, found
    // nothing"; a test we could not run is inconclusive/error, never ok.
    severity: varchar({ length: 16 }).notNull(),
    // E-185 — who computed the numbers: hand_coded | sandbox | none | legacy_llm.
    // Rows written before E-185 are backfilled to legacy_llm unless they came
    // from a hand-coded evaluator; an LLM may have stated those counts itself.
    verdict_source: varchar("verdict_source", { length: 16 }),
    // E-187 — the risk_runs row that produced this card. Null for rows written
    // before run tracking existed.
    run_id: uuid("run_id"),
    finding_summary: text("finding_summary").notNull(),
    affected_count: integer("affected_count").default(0).notNull(),
    total_count: integer("total_count").default(0).notNull(),
    evidence_json: jsonb("evidence_json"),
    llm_critique: text("llm_critique"),
    llm_model: varchar("llm_model", { length: 64 }),
    llm_prompt_tokens: integer("llm_prompt_tokens"),
    llm_completion_tokens: integer("llm_completion_tokens"),
  },
  (table) => ({
    tenantRunIdx: index("risk_card_runs_tenant_run_idx").on(table.tenant_id, table.run_at),
    tenantHypIdx: index("risk_card_runs_tenant_hyp_idx").on(table.tenant_id, table.hypothesis_id),
    severityIdx: index("risk_card_runs_severity_idx").on(table.severity),
  }),
);

// E-187 — One row per risk-engine invocation. Also the concurrency lock: the
// partial unique index (tenant_id) WHERE status='running' means the DB, not a
// check-then-insert, decides who gets to run. See src/lib/nbfc/risk-run.ts.
export const riskRuns = pgTable(
  "risk_runs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    triggered_by: varchar("triggered_by", { length: 16 }).notNull(), // manual | cron
    actor_user_id: uuid("actor_user_id"),
    status: varchar({ length: 16 }).default("running").notNull(), // running | completed | failed
    started_at: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    cards_generated: integer("cards_generated").default(0).notNull(),
    cards_computed: integer("cards_computed").default(0).notNull(),
    cards_inconclusive: integer("cards_inconclusive").default(0).notNull(),
    cards_errored: integer("cards_errored").default(0).notNull(),
    prompt_tokens: integer("prompt_tokens").default(0).notNull(),
    completion_tokens: integer("completion_tokens").default(0).notNull(),
    error: text(),
  },
  (table) => ({
    tenantStartedIdx: index("risk_runs_tenant_started_idx").on(table.tenant_id, table.started_at),
  }),
);

// E-199 — Per-NBFC risk-card visibility allowlist. STRICT: presence of a
// (tenant_id, hypothesis_id) row means an admin has enabled that card for the
// tenant. No row = hidden; a tenant with zero rows sees zero cards. Filtered at
// display time in the Risk page's loadCards(), so it survives every re-run.
export const nbfcRiskCardVisibility = pgTable(
  "nbfc_risk_card_visibility",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull().references(() => nbfcTenants.id, { onDelete: "cascade" }),
    hypothesis_id: uuid("hypothesis_id").notNull().references(() => riskHypotheses.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_by: uuid("updated_by"),
  },
  (table) => ({
    tenantHypUniq: uniqueIndex("nbfc_risk_card_visibility_tenant_hyp_uidx").on(
      table.tenant_id,
      table.hypothesis_id,
    ),
    tenantIdx: index("nbfc_risk_card_visibility_tenant_idx").on(table.tenant_id),
  }),
);

// -----------------------------------------------------------------------------
// E-026 — Portfolio Overview summary cards (Section 6.1.3)
// -----------------------------------------------------------------------------
// Two new tables to support the portfolio summary endpoint:
//   • borrower_risk_scores      — nightly-computed CDS / PCI per borrower
//   • nbfc_recovery_pipeline    — recovered batteries moving through the
//                                  recovery & auction stage flow
// Tenant scoping enforced in application code (drizzle where-clauses).
// -----------------------------------------------------------------------------

export const borrowerRiskScores = pgTable(
  "borrower_risk_scores",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    borrower_id: uuid("borrower_id").notNull(),
    // E-117 — widened uuid → varchar so a score can be keyed to any
    // loan_sanctions.id (which is varchar, often non-uuid e.g. 'BAJAJ-LIVE-…').
    loan_sanction_id: varchar("loan_sanction_id", { length: 255 }).notNull(),
    cds_score: numeric("cds_score", { precision: 5, scale: 2 }),
    pci_score: numeric("pci_score", { precision: 4, scale: 3 }),
    confidence: varchar({ length: 16 }),
    computed_at: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("borrower_risk_scores_tenant_idx").on(table.tenant_id),
    borrowerIdx: index("borrower_risk_scores_borrower_idx").on(table.borrower_id),
    loanSanctionIdx: index("borrower_risk_scores_loan_sanction_idx").on(table.loan_sanction_id),
  }),
);

export const nbfcRecoveryPipeline = pgTable(
  "nbfc_recovery_pipeline",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    battery_serial: varchar("battery_serial", { length: 64 }).notNull(),
    stage: varchar({ length: 32 }).notNull(),
    estimated_recovery_value: numeric("estimated_recovery_value", { precision: 12, scale: 2 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // [E-232] recovery_batteries.id — the real key that replaces the string
    // join in settlements.ts, which matched battery_serial against
    // auction_lots.lot_code. Those two values are never equal, so marking a
    // battery 'resold' has never once worked.
    battery_id: uuid("battery_id"),
  },
  (table) => ({
    tenantIdx: index("nbfc_recovery_pipeline_tenant_idx").on(table.tenant_id),
    stageIdx: index("nbfc_recovery_pipeline_stage_idx").on(table.stage),
    tenantStageIdx: index("nbfc_recovery_pipeline_tenant_stage_idx").on(table.tenant_id, table.stage),
    batteryIdx: index("nbfc_recovery_pipeline_battery_idx").on(table.battery_id),
  }),
);

// -----------------------------------------------------------------------------
// E-232 — recovery_batteries: the battery master (Battery Auction BRD §3)
// -----------------------------------------------------------------------------
// Deliberately a SEPARATE table from nbfc_recovery_pipeline rather than twelve
// more columns on it, because the two have different lifetimes. A pipeline row
// is a workflow position that ends at 'resold'. A battery is a physical asset
// that outlives it — refurbished, auctioned, refinanced, and recovered again
// later. One battery, many pipeline passes.
//
// `state_code` is named that way because `state` on this same row is the
// geographic state. Values: draft | intaken | inspected | refurbishing | ready
// | lotted | sold | scrapped. No pgEnum and no CHECK, matching every other
// status column in this family — the vocabulary lives in
// src/lib/nbfc/recovery/battery.ts so it can move without a migration on a
// drifting database.
// -----------------------------------------------------------------------------

export const recoveryBatteries = pgTable(
  "recovery_batteries",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    // Global, not per-tenant: the serial is what an operator reads off the
    // casing, and the same battery must not exist twice because it changed
    // hands.
    serial: varchar("serial", { length: 64 }).notNull().unique(),
    model: varchar("model", { length: 120 }),
    capacity: varchar("capacity", { length: 32 }),
    manufacturing_date: date("manufacturing_date"),
    condition_grade: varchar("condition_grade", { length: 24 }),
    recovery_date: timestamp("recovery_date", { withTimezone: true }),
    warehouse: varchar("warehouse", { length: 160 }),
    lat: numeric("lat", { precision: 10, scale: 7 }),
    lng: numeric("lng", { precision: 10, scale: 7 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),
    // varchar(255), NOT uuid — `loan_sanctions.id` is character varying here.
    loan_sanction_id: varchar("loan_sanction_id", { length: 255 }),
    recovery_pipeline_id: uuid("recovery_pipeline_id"),
    // Relative /api/files/<bucket>/<key> strings, never absolute URLs — the
    // backend flips between Supabase and S3 behind STORAGE_BACKEND and the
    // proxy route is the only stable address. Captured once at inspection and
    // reused verbatim as the auction images (BRD §20).
    image_urls: text("image_urls").array().notNull().default(sql`'{}'::text[]`),
    state_code: varchar("state_code", { length: 24 }).notNull().default("draft"),
    notes: text("notes"),
    // [E-258] Set when this battery was sold to iTarang as scrap. Turns
    // state_code='scrapped' from a bare status into "sold under SCR-000123",
    // which is what anyone auditing a scrapped battery actually asks.
    scrap_consignment_id: uuid("scrap_consignment_id"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("recovery_batteries_tenant_idx").on(table.tenant_id),
    stateIdx: index("recovery_batteries_state_idx").on(table.state_code),
    pipelineIdx: index("recovery_batteries_pipeline_idx").on(table.recovery_pipeline_id),
    loanIdx: index("recovery_batteries_loan_idx").on(table.loan_sanction_id),
    scrapConsignmentIdx: index("recovery_batteries_scrap_consignment_idx").on(
      table.scrap_consignment_id,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-262 — recovery agent dispatch: the physical leg between flag and bench
// -----------------------------------------------------------------------------
// Flagging a loan for recovery writes the flag, a pipeline row at
// 'needs_inspection' and a battery stub; inspection then assumes the battery is
// already on a bench. The job in between — somebody drives to the borrower,
// finds the battery, photographs it and brings it back — had no record at all.
//
// The NBFC keeps a directory of recovery agents (no logins, contacts only),
// dispatches one with a single-use link, and the agent's phone captures live
// GPS and watermarked photos at the address. The NBFC reviews and approves,
// which stamps the battery master and hands it to the inspection wizard.
//
// Modelled on field_investigations / nbfc_fi_agents (E-148), which already
// solved assign → tokenised link → GPS + photo capture → reviewer decision.
//
// Mirrors drizzle/E-262_recovery_agent_dispatch.sql, which is the source of
// truth. No pgEnum and no CHECK on the status columns — same decision as every
// other status column in this family (see the E-232 header).
//
// THREE INDEXES LIVE ONLY IN THE SQL. Drizzle's index builder cannot express a
// partial index, and all three of these carry a rule rather than a lookup:
//   recovery_assignments_open_unique         one live assignment per loan
//   recovery_assignments_link_token_unique   the token is a credential
//   recovery_assignment_photos_slot_unique   one photo per named slot
// -----------------------------------------------------------------------------
export const nbfcRecoveryAgents = pgTable(
  "nbfc_recovery_agents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    nbfc_id: integer("nbfc_id"),
    name: varchar("name", { length: 200 }).notNull(),
    // Phone required, email optional — an agent is reached on a phone; email is
    // the link wire when they have one.
    phone: varchar("phone", { length: 20 }).notNull(),
    email: varchar("email", { length: 200 }),
    city: varchar("city", { length: 120 }),
    /** Free text — "Ranchi + 60km". Not a geofence; it helps a human pick. */
    coverage_area: text("coverage_area"),
    preferred_channel: varchar("preferred_channel", { length: 12 })
      .default("email")
      .notNull(), // email|sms|whatsapp
    /** Compared against the selfie the field form captures. */
    reference_photo_url: text("reference_photo_url"),
    /** Soft delete — assignments reference these rows. */
    active: boolean("active").default(true).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantActiveIdx: index("nbfc_recovery_agents_tenant_active_idx").on(
      table.tenant_id,
      table.active,
    ),
  }),
);

export const recoveryAssignments = pgTable(
  "recovery_assignments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    // varchar(255), NOT uuid — `loan_sanctions.id` is character varying here.
    loan_sanction_id: varchar("loan_sanction_id", { length: 255 }).notNull(),
    recovery_pipeline_id: uuid("recovery_pipeline_id"),
    battery_id: uuid("battery_id"),
    /**
     * Nullable: a flag raised with no serial has none, and the agent supplies
     * it on the field form — they are the one holding the battery.
     */
    battery_serial: varchar("battery_serial", { length: 64 }),

    attempt_no: integer("attempt_no").default(1).notNull(),
    is_current: boolean("is_current").default(true).notNull(),
    /**
     * assigned | in_progress | collected | completed | rejected | cancelled
     *
     * `assigned` means the link exists but the send was never confirmed;
     * `in_progress` means the agent has it. Without that distinction a bounced
     * email looks exactly like an agent who has not set off yet.
     */
    status: varchar("status", { length: 24 }).default("assigned").notNull(),

    agent_id: uuid("agent_id"),
    /** Denormalised so renaming an agent does not rewrite history. */
    agent_name: varchar("agent_name", { length: 200 }),
    agent_phone: varchar("agent_phone", { length: 20 }),
    assigned_by: uuid("assigned_by"),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),
    due_at: timestamp("due_at", { withTimezone: true }),

    link_token: varchar("link_token", { length: 80 }),
    link_sent_at: timestamp("link_sent_at", { withTimezone: true }),
    link_channel: varchar("link_channel", { length: 12 }), // email|sms|whatsapp
    link_expires_at: timestamp("link_expires_at", { withTimezone: true }),
    /** Why nobody was reached, so the queue never shows a silent 'assigned'. */
    dispatch_error: text("dispatch_error"),

    collected_at: timestamp("collected_at", { withTimezone: true }),
    gps_lat: numeric("gps_lat", { precision: 10, scale: 7 }),
    gps_lng: numeric("gps_lng", { precision: 10, scale: 7 }),
    gps_accuracy_m: numeric("gps_accuracy_m", { precision: 8, scale: 2 }),
    /**
     * Server clock, not the handset's — a phone's time is user-settable and
     * this is evidence.
     */
    gps_server_timestamp: timestamp("gps_server_timestamp", { withTimezone: true }),
    /**
     * Geocoded borrower address, frozen at assign. NULL when no geocoding key
     * is configured — say so in the UI rather than rendering a bare dash.
     */
    stated_lat: numeric("stated_lat", { precision: 10, scale: 7 }),
    stated_lng: numeric("stated_lng", { precision: 10, scale: 7 }),
    distance_from_address_m: numeric("distance_from_address_m", { precision: 10, scale: 2 }),
    condition_notes: text("condition_notes"),
    agent_declaration_at: timestamp("agent_declaration_at", { withTimezone: true }),

    reviewed_by: uuid("reviewed_by"),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
    review_decision: varchar("review_decision", { length: 16 }), // approve|reject
    review_notes: text("review_notes"),

    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    /** NULL when the system cancelled it — nobody clicked, the borrower paid. */
    cancelled_by: uuid("cancelled_by"),
    cancel_reason: text("cancel_reason"),
    cancel_source: varchar("cancel_source", { length: 24 }), // manual|emi_payment|reassigned

    // [E-263] A cache of the visit log, for the queue. The log is authoritative.
    next_visit_at: timestamp("next_visit_at", { withTimezone: true }),
    visit_attempt_count: integer("visit_attempt_count").default(0).notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantStatusIdx: index("recovery_assignments_tenant_status_idx").on(
      table.tenant_id,
      table.status,
    ),
    loanIdx: index("recovery_assignments_loan_idx").on(table.loan_sanction_id),
    // recovery_assignments_open_unique and recovery_assignments_link_token_unique
    // are PARTIAL and therefore SQL-only. See the header.
  }),
);

export const recoveryAssignmentPhotos = pgTable(
  "recovery_assignment_photos",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    assignment_id: uuid("assignment_id").notNull(),
    // serial | battery | vehicle | agent_selfie | extra
    photo_type: varchar("photo_type", { length: 24 }).notNull(),
    /**
     * Relative storage path, never an absolute URL — the backend flips between
     * Supabase and S3 behind STORAGE_BACKEND and a signed URL would rot.
     */
    image_url: text("image_url").notNull(),
    gps_lat: numeric("gps_lat", { precision: 10, scale: 7 }),
    gps_lng: numeric("gps_lng", { precision: 10, scale: 7 }),
    gps_server_timestamp: timestamp("gps_server_timestamp", { withTimezone: true }),
    /**
     * watermarkPhoto() never throws; it reports whether it managed to stamp the
     * image. An unstamped photo is still evidence — flagged, not dropped.
     */
    watermark_applied: boolean("watermark_applied").default(false).notNull(),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    assignmentIdx: index("recovery_assignment_photos_assignment_idx").on(
      table.assignment_id,
    ),
    // recovery_assignment_photos_slot_unique is PARTIAL — SQL-only.
  }),
);

// -----------------------------------------------------------------------------
// E-263 — recovery_visit_attempts: the doorstep nobody answered
// -----------------------------------------------------------------------------
// E-262 modelled a collection as one event. Real repossession is not: the agent
// drives out, knocks, and the customer is not home — or refuses, or the address
// is wrong. None of those is a collection, and until this table there was no way
// to record any of them, so an agent who went and found nobody looked identical
// to one who never left.
//
// Append-only, one row per journey, each with its own GPS fix. A set of columns
// on the assignment would let a third visit overwrite the second, and "we
// attended twice at the agreed time" is exactly the history a disputed
// repossession turns on.
//
// Mirrors drizzle/E-263_recovery_visit_attempts.sql, which is the source of
// truth. `recovery_visit_attempts_no_unique` is a plain unique index and IS
// expressible here; `recovery_assignments_next_visit_idx` is partial and stays
// SQL-only.
// -----------------------------------------------------------------------------
export const recoveryVisitAttempts = pgTable(
  "recovery_visit_attempts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    assignment_id: uuid("assignment_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    /** The agent's count of journeys, not a sequence — it reads that way in the UI. */
    attempt_no: integer("attempt_no").default(1).notNull(),
    /**
     * not_present | refused | address_not_found | battery_missing | other
     *
     * Never `collected`: a successful collection is the assignment's own
     * terminal write, and duplicating it here would create two disagreeing
     * records of one fact.
     */
    outcome: varchar("outcome", { length: 24 }).notNull(),
    gps_lat: numeric("gps_lat", { precision: 10, scale: 7 }),
    gps_lng: numeric("gps_lng", { precision: 10, scale: 7 }),
    gps_accuracy_m: numeric("gps_accuracy_m", { precision: 8, scale: 2 }),
    gps_server_timestamp: timestamp("gps_server_timestamp", { withTimezone: true }),
    distance_from_address_m: numeric("distance_from_address_m", { precision: 10, scale: 2 }),
    notes: text("notes"),
    /** NULL is a real answer — "nobody home and I am not going back". */
    next_visit_at: timestamp("next_visit_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    assignmentIdx: index("recovery_visit_attempts_assignment_idx").on(
      table.assignment_id,
      table.created_at,
    ),
    tenantIdx: index("recovery_visit_attempts_tenant_idx").on(
      table.tenant_id,
      table.created_at,
    ),
    attemptUnique: uniqueIndex("recovery_visit_attempts_no_unique").on(
      table.assignment_id,
      table.attempt_no,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-258 — scrap consignments: the NBFC → iTarang sale of scrapped batteries
// -----------------------------------------------------------------------------
// `nbfc_recovery_pipeline.stage = 'scrap'` is terminal and has no buyer behind
// it: the auction path sells refurbished stock to dealers and excludes scrap by
// design (SOH < 55%). iTarang buys that scrap directly.
//
// The NBFC bundles one or many scrap batteries into a consignment with photos
// and a RATE PER BATTERY; admin answers with its own rate; either side may
// counter; on acceptance the rate freezes and amount = rate × battery_count;
// iTarang then pays (RazorpayX payout or a recorded offline transfer) and the
// batteries transfer.
//
// Mirrors drizzle/E-258_scrap_consignments.sql, which is the source of truth.
// No pgEnum and no CHECK on the status columns — same decision as every other
// status column in this family (see the E-232 header): the vocabulary lives in
// src/lib/nbfc/scrap/consignment.ts so it can move without a migration against
// a drifting database.
// -----------------------------------------------------------------------------

export const scrapConsignments = pgTable(
  "scrap_consignments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ref_code: varchar("ref_code", { length: 24 }).notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    // draft | submitted | negotiating | agreed | paid | rejected | withdrawn
    status: varchar("status", { length: 24 }).notNull().default("draft"),
    battery_count: integer("battery_count").notNull().default(0),
    // [E-260] flat = one rate for every battery; itemised = a rate per item.
    pricing_mode: varchar("pricing_mode", { length: 16 })
      .notNull()
      .default("flat"),
    asking_rate_per_battery: numeric("asking_rate_per_battery", { precision: 12, scale: 2 }),
    // [E-260] The total asked, written in BOTH modes — flat stores
    // rate × count, itemised the sum of the item rates. The negotiation runs
    // on this column, which is what keeps every downstream read from having to
    // ask which of the two price fields is authoritative.
    asking_amount: numeric("asking_amount", { precision: 14, scale: 2 }),
    agreed_rate_per_battery: numeric("agreed_rate_per_battery", { precision: 12, scale: 2 }),
    agreed_amount: numeric("agreed_amount", { precision: 14, scale: 2 }),
    current_round: integer("current_round").notNull().default(0),
    // Who spoke last ('nbfc' | 'admin') — the other side owes the next answer.
    last_party: varchar("last_party", { length: 8 }),
    pickup_city: varchar("pickup_city", { length: 120 }),
    pickup_state: varchar("pickup_state", { length: 120 }),
    warehouse: varchar("warehouse", { length: 160 }),
    // Relative /api/files/<bucket>/<key> paths, never absolute URLs. Per-battery
    // shots stay on recovery_batteries.image_urls and are not copied here.
    photo_urls: text("photo_urls").array().notNull().default(sql`'{}'::text[]`),
    note: text("note"),
    // Where iTarang sends the money. On the deal rather than on nbfc_tenants,
    // which carries no bank columns at all.
    payee_name: varchar("payee_name", { length: 160 }),
    payee_account_number: varchar("payee_account_number", { length: 40 }),
    payee_ifsc: varchar("payee_ifsc", { length: 11 }),
    // unpaid | processing | paid | failed
    payment_status: varchar("payment_status", { length: 24 }).notNull().default("unpaid"),
    payment_provider: varchar("payment_provider", { length: 16 }),
    payment_ref: text("payment_ref"),
    payment_utr: varchar("payment_utr", { length: 64 }),
    payment_failure_reason: text("payment_failure_reason"),
    paid_at: timestamp("paid_at", { withTimezone: true }),
    paid_by: uuid("paid_by"),
    created_by: uuid("created_by"),
    agreed_by: uuid("agreed_by"),
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    agreed_at: timestamp("agreed_at", { withTimezone: true }),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    // [E-259] When the batteries physically reached iTarang. Under a post_lot
    // payment term this is a hard gate on the payout; under pre_lot it is
    // still recorded, because paid-on / arrived-on is the pair of dates a
    // reconciliation needs.
    received_at: timestamp("received_at", { withTimezone: true }),
    received_by: uuid("received_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    refUnique: uniqueIndex("scrap_consignments_ref_uidx").on(table.ref_code),
    tenantIdx: index("scrap_consignments_tenant_idx").on(table.tenant_id, table.created_at),
    statusIdx: index("scrap_consignments_status_idx").on(table.status, table.created_at),
    // The partial "open" index (scrap_consignments_open_idx) is created by the
    // migration; drizzle's builder has no partial-index syntax, so it is
    // intentionally absent here.
  }),
);

export const scrapConsignmentItems = pgTable(
  "scrap_consignment_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    consignment_id: uuid("consignment_id")
      .notNull()
      .references(() => scrapConsignments.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id").notNull(),
    battery_id: uuid("battery_id"),
    // Snapshotted, not joined: the serial is what a dispute is argued in and
    // the battery row can be re-pointed by a later recovery.
    serial: varchar("serial", { length: 64 }).notNull(),
    // [E-260] The NBFC's price for this one battery; NULL in flat mode. Never
    // rewritten after submission — it is the breakdown behind the asking
    // total, not a per-battery negotiation of its own.
    asking_rate: numeric("asking_rate", { precision: 12, scale: 2 }),
    // [E-261] This battery's share of the settled deal, frozen at acceptance
    // when the accepted round was itemised — and cleared when it was not, so a
    // stale breakdown can never disagree with agreed_amount.
    agreed_rate: numeric("agreed_rate", { precision: 12, scale: 2 }),
    model: varchar("model", { length: 120 }),
    capacity: varchar("capacity", { length: 32 }),
    soh_pct: numeric("soh_pct", { precision: 5, scale: 2 }),
    condition_note: text("condition_note"),
    // TRUE while the parent deal is live. The migration's partial unique index
    // on (battery_id) WHERE is_open is what stops one battery being sold twice.
    is_open: boolean("is_open").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    consignmentIdx: index("scrap_consignment_items_consignment_idx").on(table.consignment_id),
    batteryIdx: index("scrap_consignment_items_battery_idx").on(table.battery_id),
    itemUnique: uniqueIndex("scrap_consignment_items_uidx").on(
      table.consignment_id,
      table.battery_id,
    ),
  }),
);

// Append-only round log, modelled on nbfcOfferNegotiations (E-238) for the same
// reason: the header row is overwritten with each new rate, so without this the
// history a disputed payment turns on is gone. The unique (consignment_id,
// round) is a concurrency guard — a round is always current_round + 1, so two
// simultaneous counters must collide with 23505 rather than both claim round 3.
export const scrapConsignmentOffers = pgTable(
  "scrap_consignment_offers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    consignment_id: uuid("consignment_id")
      .notNull()
      .references(() => scrapConsignments.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id").notNull(),
    round: integer("round").notNull(),
    party: varchar("party", { length: 8 }).notNull(), // 'nbfc' | 'admin'
    kind: varchar("kind", { length: 16 }).notNull(), // quote|counter|accept|reject|withdraw
    // [E-261] How THIS round was expressed: 'lot' = one number for the pile,
    // 'itemised' = a rate per battery in scrap_consignment_offer_items. On the
    // round rather than the consignment, because either side may switch at any
    // round — an itemised ask can be answered with a lot price and vice versa.
    pricing_mode: varchar("pricing_mode", { length: 16 })
      .notNull()
      .default("lot"),
    rate_per_battery: numeric("rate_per_battery", { precision: 12, scale: 2 }),
    battery_count: integer("battery_count"),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    message: text("message"),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    roundUnique: uniqueIndex("scrap_consignment_offers_round_uidx").on(
      table.consignment_id,
      table.round,
    ),
    consignmentIdx: index("scrap_consignment_offers_consignment_idx").on(
      table.consignment_id,
      table.created_at,
    ),
  }),
);

/**
 * [E-261] The per-battery breakdown of one negotiation round.
 *
 * Append-only, like the round log it hangs off: a superseded round keeps its
 * numbers, so "what did they say about THIS battery three rounds ago" stays
 * answerable. SUM(rate) equals the parent offer's `amount`, which is what
 * acceptance and payment actually read.
 */
export const scrapConsignmentOfferItems = pgTable(
  "scrap_consignment_offer_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    offer_id: uuid("offer_id")
      .notNull()
      .references(() => scrapConsignmentOffers.id, { onDelete: "cascade" }),
    // Denormalised so a consignment's whole breakdown is one indexed read
    // rather than a join through every round.
    consignment_id: uuid("consignment_id").notNull(),
    item_id: uuid("item_id")
      .notNull()
      .references(() => scrapConsignmentItems.id, { onDelete: "cascade" }),
    battery_id: uuid("battery_id"),
    rate: numeric("rate", { precision: 12, scale: 2 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // One rate per battery per round: without it a retried write would double
    // the round's total, which is a SUM over these rows.
    offerItemUnique: uniqueIndex("scrap_consignment_offer_items_uidx").on(
      table.offer_id,
      table.item_id,
    ),
    consignmentIdx: index("scrap_consignment_offer_items_consignment_idx").on(
      table.consignment_id,
      table.created_at,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-037 — Battery Evaluation 3-step form (Section 6.1.7)
// -----------------------------------------------------------------------------
// nbfc_battery_evaluations stores the 3-step evaluation form a Recovery
// operator fills in for a recovered battery before it is auctioned or
// scrapped. step1/step2/step3 are kept as JSONB blobs because BRD §6.1.7
// doesn't pin a flat shape and the UI wizard mirrors these step boundaries.
// `base_auction_price` is computed deterministically from SOH and the
// step3 original_value (see logic in
// src/app/api/nbfc/recovery/[id]/evaluation/route.ts).
// -----------------------------------------------------------------------------

export const nbfcBatteryEvaluations = pgTable(
  "nbfc_battery_evaluations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    recovery_pipeline_id: uuid("recovery_pipeline_id").notNull(),
    step1: jsonb("step1").notNull(),
    step2: jsonb("step2").notNull(),
    step3: jsonb("step3").notNull(),
    base_auction_price: numeric("base_auction_price", { precision: 12, scale: 2 }),
    rejected: boolean("rejected").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // [E-233] What THIS evaluation saw. recovery_batteries.image_urls is the
    // canonical gallery; this column exists so a re-inspection after
    // refurbishment does not overwrite the before shots.
    photo_urls: text("photo_urls").array().notNull().default(sql`'{}'::text[]`),
    // [E-233] new | refurbished | partial_working (BRD §6). Stored rather than
    // recomputed from SOH — the bands may be retuned, and a battery already
    // sold as partial_working must not silently re-grade itself.
    condition_grade: varchar("condition_grade", { length: 24 }),
  },
  (table) => ({
    tenantIdx: index("nbfc_battery_evaluations_tenant_idx").on(table.tenant_id),
    pipelineIdx: index("nbfc_battery_evaluations_pipeline_idx").on(table.recovery_pipeline_id),
  }),
);

// -----------------------------------------------------------------------------
// E-233 — refurbishment_jobs (Battery Auction BRD §5, §15)
// -----------------------------------------------------------------------------
// One workshop job per recovered battery. The NBFC raises it, the iTarang
// workshop works it, and the battery re-enters the pipeline at
// ready_for_auction.
//
// Refurbishment is RECOMMENDED, NEVER MANDATORY — see the bypass edge
// needs_inspection -> ready_for_auction in src/lib/nbfc/recovery/stages.ts.
//
// `estimated_cost` and `actual_cost` are deliberately two columns: the estimate
// is what the NBFC agreed to, the actual is what the workshop spent, and the
// pair is the only thing a workshop can be audited against.
//
// The partial unique index enforcing at most one OPEN job per battery lives in
// the migration only — drizzle's builder cannot express a WHERE clause on an
// index (same treatment as E-093, E-226, E-230, E-232).
// -----------------------------------------------------------------------------

export const refurbishmentJobs = pgTable(
  "refurbishment_jobs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    battery_id: uuid("battery_id").notNull(),
    recovery_pipeline_id: uuid("recovery_pipeline_id"),
    requested_by_user_id: uuid("requested_by_user_id"),
    assigned_workshop: varchar("assigned_workshop", { length: 160 }),
    checklist: jsonb("checklist").notNull().default(sql`'[]'::jsonb`),
    // BRD §15 — charger, harness, SOC meter, always new (~₹7–8k), costed here
    // and rolled into the lot base price so the dealer sees one number.
    accessories: jsonb("accessories").notNull().default(sql`'[]'::jsonb`),
    estimated_cost: numeric("estimated_cost", { precision: 12, scale: 2 }),
    actual_cost: numeric("actual_cost", { precision: 12, scale: 2 }),
    status: varchar("status", { length: 24 }).notNull().default("requested"),
    notes: text("notes"),
    requested_at: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    started_at: timestamp("started_at", { withTimezone: true }),
    returned_at: timestamp("returned_at", { withTimezone: true }),
    // [E-270] The lot this job travels in. NULL = legacy single job (E-233).
    lot_id: uuid("lot_id"),
    decline_reason: text("decline_reason"),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    decided_by: uuid("decided_by"),
    // [E-270] received | damaged | missing — workshop receipt of THIS battery.
    out_received_condition: varchar("out_received_condition", { length: 16 }),
    out_received_note: text("out_received_note"),
    out_received_photo_urls: text("out_received_photo_urls")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ready_at: timestamp("ready_at", { withTimezone: true }),
    // [E-270] received | damaged | missing — NBFC receipt on return.
    ret_received_condition: varchar("ret_received_condition", { length: 16 }),
    ret_received_note: text("ret_received_note"),
    ret_received_photo_urls: text("ret_received_photo_urls")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ret_received_at: timestamp("ret_received_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("refurbishment_jobs_tenant_idx").on(table.tenant_id),
    batteryIdx: index("refurbishment_jobs_battery_idx").on(table.battery_id),
    statusIdx: index("refurbishment_jobs_status_idx").on(table.status),
    lotIdx: index("refurbishment_jobs_lot_idx").on(table.lot_id),
  }),
);

// -----------------------------------------------------------------------------
// E-270 — refurbishment_lots + refurbishment_lot_events
// -----------------------------------------------------------------------------
// One batch of batteries the NBFC sends to the iTarang workshop. The lot
// carries the timeline/estimate negotiation and both physical legs; the
// per-battery items are refurbishment_jobs rows with lot_id set.
//
// Mirrors drizzle/E-270_refurbishment_lots.sql, which is the source of truth.
// No pgEnum and no CHECK on status — the vocabulary lives in
// src/lib/nbfc/recovery/refurbishment-lot-status.ts (same call as E-258).
// -----------------------------------------------------------------------------

export const refurbishmentLots = pgTable(
  "refurbishment_lots",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    ref_code: varchar("ref_code", { length: 24 }).notNull(),
    // E-271 vocabulary: requested | proposed | countered | agreed |
    // awaiting_advance | advance_paid | pickup_scheduled | in_transit_out |
    // delivered | received | in_progress | revision_pending | ready |
    // in_transit_return | delivered_back | balance_due | settled | cancelled
    status: varchar("status", { length: 24 }).notNull().default("requested"),
    battery_count: integer("battery_count").notNull().default(0),
    note: text("note"),

    current_round: integer("current_round").notNull().default(0),
    // 'nbfc' | 'admin' — who moved last; the other side owes the next move.
    last_party: varchar("last_party", { length: 8 }),
    expected_receipt_date: date("expected_receipt_date"),
    expected_return_date: date("expected_return_date"),
    estimated_labour_total: numeric("estimated_labour_total", { precision: 14, scale: 2 }),
    estimated_accessories_total: numeric("estimated_accessories_total", {
      precision: 14,
      scale: 2,
    }),
    estimated_total: numeric("estimated_total", { precision: 14, scale: 2 }),
    proposal_note: text("proposal_note"),
    agreed_at: timestamp("agreed_at", { withTimezone: true }),
    agreed_by: uuid("agreed_by"),

    // Leg 1: NBFC -> workshop.
    out_carrier: varchar("out_carrier", { length: 120 }),
    out_vehicle_no: varchar("out_vehicle_no", { length: 32 }),
    out_docket_no: varchar("out_docket_no", { length: 64 }),
    out_dispatched_on: date("out_dispatched_on"),
    out_dispatch_note: text("out_dispatch_note"),
    out_photo_urls: text("out_photo_urls").array().notNull().default(sql`'{}'::text[]`),
    out_dispatched_at: timestamp("out_dispatched_at", { withTimezone: true }),
    out_dispatched_by: uuid("out_dispatched_by"),
    out_received_at: timestamp("out_received_at", { withTimezone: true }),
    out_received_by: uuid("out_received_by"),
    out_receipt_note: text("out_receipt_note"),
    out_receipt_photo_urls: text("out_receipt_photo_urls")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    out_has_mismatch: boolean("out_has_mismatch").notNull().default(false),

    // Leg 2: workshop -> NBFC.
    ret_carrier: varchar("ret_carrier", { length: 120 }),
    ret_vehicle_no: varchar("ret_vehicle_no", { length: 32 }),
    ret_docket_no: varchar("ret_docket_no", { length: 64 }),
    ret_dispatched_on: date("ret_dispatched_on"),
    ret_dispatch_note: text("ret_dispatch_note"),
    ret_photo_urls: text("ret_photo_urls").array().notNull().default(sql`'{}'::text[]`),
    ret_dispatched_at: timestamp("ret_dispatched_at", { withTimezone: true }),
    ret_dispatched_by: uuid("ret_dispatched_by"),
    ret_received_at: timestamp("ret_received_at", { withTimezone: true }),
    ret_received_by: uuid("ret_received_by"),
    ret_receipt_note: text("ret_receipt_note"),
    ret_receipt_photo_urls: text("ret_receipt_photo_urls")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ret_has_mismatch: boolean("ret_has_mismatch").notNull().default(false),

    work_started_at: timestamp("work_started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    cancelled_by: uuid("cancelled_by"),
    cancelled_by_party: varchar("cancelled_by_party", { length: 8 }),
    cancel_reason: text("cancel_reason"),

    // ---- E-271: pickup / e-way bill / custody --------------------------------
    // nbfc_ships | itarang_pickup — part of the quote the NBFC approves.
    pickup_mode: varchar("pickup_mode", { length: 16 }).notNull().default("nbfc_ships"),
    pickup_address: text("pickup_address"),
    workshop_address: text("workshop_address"),
    scheduled_pickup_date: date("scheduled_pickup_date"),
    out_eway_bill_no: varchar("out_eway_bill_no", { length: 32 }),
    out_eway_bill_url: text("out_eway_bill_url"),
    out_picked_up_at: timestamp("out_picked_up_at", { withTimezone: true }),
    out_picked_up_by: uuid("out_picked_up_by"),
    out_delivered_at: timestamp("out_delivered_at", { withTimezone: true }),
    out_delivered_by: uuid("out_delivered_by"),
    ret_eway_bill_no: varchar("ret_eway_bill_no", { length: 32 }),
    ret_eway_bill_url: text("ret_eway_bill_url"),
    ret_delivered_at: timestamp("ret_delivered_at", { withTimezone: true }),
    ret_delivered_by: uuid("ret_delivered_by"),
    // ---- E-271: the quote the NBFC approved + revision round ------------------
    quote_approved_total: numeric("quote_approved_total", { precision: 14, scale: 2 }),
    quote_approved_at: timestamp("quote_approved_at", { withTimezone: true }),
    quote_approved_by: uuid("quote_approved_by"),
    revised_total: numeric("revised_total", { precision: 14, scale: 2 }),
    revision_note: text("revision_note"),
    revision_round: integer("revision_round").notNull().default(0),
    // ---- E-271: advance (NBFC -> iTarang), E-252 money-block shape -------------
    advance_pct: numeric("advance_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    advance_amount: numeric("advance_amount", { precision: 14, scale: 2 }),
    // not_required | pending | recorded | confirmed
    advance_status: varchar("advance_status", { length: 16 }).notNull().default("not_required"),
    advance_provider: varchar("advance_provider", { length: 16 }), // razorpay | offline
    advance_order_id: varchar("advance_order_id", { length: 64 }),
    advance_payment_id: varchar("advance_payment_id", { length: 64 }),
    advance_reference: varchar("advance_reference", { length: 120 }),
    advance_recorded_at: timestamp("advance_recorded_at", { withTimezone: true }),
    advance_confirmed_at: timestamp("advance_confirmed_at", { withTimezone: true }),
    advance_confirmed_by: uuid("advance_confirmed_by"),
    // ---- E-271: balance = final_total - advance -------------------------------
    final_total: numeric("final_total", { precision: 14, scale: 2 }),
    balance_amount: numeric("balance_amount", { precision: 14, scale: 2 }),
    // not_due | pending | recorded | confirmed
    balance_status: varchar("balance_status", { length: 16 }).notNull().default("not_due"),
    balance_provider: varchar("balance_provider", { length: 16 }),
    balance_order_id: varchar("balance_order_id", { length: 64 }),
    balance_payment_id: varchar("balance_payment_id", { length: 64 }),
    balance_reference: varchar("balance_reference", { length: 120 }),
    balance_recorded_at: timestamp("balance_recorded_at", { withTimezone: true }),
    balance_confirmed_at: timestamp("balance_confirmed_at", { withTimezone: true }),
    balance_confirmed_by: uuid("balance_confirmed_by"),
    settled_at: timestamp("settled_at", { withTimezone: true }),

    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    refUnique: uniqueIndex("refurbishment_lots_ref_uidx").on(table.ref_code),
    tenantIdx: index("refurbishment_lots_tenant_idx").on(table.tenant_id, table.created_at),
    statusIdx: index("refurbishment_lots_status_idx").on(table.status, table.created_at),
  }),
);

export const refurbishmentLotEvents = pgTable(
  "refurbishment_lot_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_id: uuid("lot_id")
      .notNull()
      .references(() => refurbishmentLots.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id").notNull(),
    seq: integer("seq").notNull(),
    party: varchar("party", { length: 8 }).notNull(), // nbfc | admin | system
    kind: varchar("kind", { length: 24 }).notNull(),
    message: text("message"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    seqUnique: uniqueIndex("refurbishment_lot_events_seq_uidx").on(table.lot_id, table.seq),
    lotIdx: index("refurbishment_lot_events_lot_idx").on(table.lot_id, table.created_at),
  }),
);

// -----------------------------------------------------------------------------
// E-035 — Flag for Recovery action (Section 6.1.6)
// -----------------------------------------------------------------------------
// nbfc_borrower_actions records a Risk Head's executed actions against a
// borrower / loan_sanction (single-approval, per BRD §6.1.6 row "Flag for
// Recovery"). Used here for the irreversible flag and reused by future units
// (e.g. E-031 send-payment-reminder) which carry the same shape.
// -----------------------------------------------------------------------------

export const nbfcBorrowerActions = pgTable(
  "nbfc_borrower_actions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    loan_sanction_id: varchar("loan_sanction_id", { length: 255 }).notNull(),
    action_type: varchar("action_type", { length: 64 }).notNull(),
    status: varchar({ length: 32 }).notNull(),
    requested_by: uuid("requested_by"),
    payload: jsonb("payload"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_borrower_actions_tenant_idx").on(table.tenant_id),
    loanIdx: index("nbfc_borrower_actions_loan_idx").on(table.loan_sanction_id),
    actionTypeIdx: index("nbfc_borrower_actions_action_type_idx").on(table.action_type),
  }),
);

// -----------------------------------------------------------------------------
// E-031 — Send Payment Reminder action (Section 6.1.6 — Risk Action Framework)
// -----------------------------------------------------------------------------
// nbfc_audit_log is the immutable, append-only audit trail mandated by BRD
// §6.1.2 + RBI Digital Lending Directions 2025: every NBFC-initiated action
// MUST emit a row here with before/after JSON state. It is intentionally
// separate from the mutable `nbfc_borrower_actions` table (which records the
// current status of an action) and from the shared `audit_logs` table (which
// covers generic CRM mutations) — keeping the NBFC tier evidentiary log
// isolated lets us export it cleanly for regulator inspection.
//
// `user_id` is the canonical column name (renamed from earlier draft
// `actor_user_id`) to align with `nbfc_users.user_id` and `lead_documents.user_id`,
// avoiding silent-rename divergence.
// -----------------------------------------------------------------------------

export const nbfcAuditLog = pgTable(
  "nbfc_audit_log",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    user_id: uuid("user_id").notNull(),
    action_type: varchar("action_type", { length: 32 }).notNull(),
    action_id: uuid("action_id"),
    before_state: jsonb("before_state"),
    after_state: jsonb("after_state"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_audit_log_tenant_idx").on(table.tenant_id),
    actionIdIdx: index("nbfc_audit_log_action_id_idx").on(table.action_id),
    actionTypeIdx: index("nbfc_audit_log_action_type_idx").on(table.action_type),
  }),
);

// -----------------------------------------------------------------------------
// E-027 — Portfolio Data Freshness Badge (Section 6.1.3)
// -----------------------------------------------------------------------------
// telemetry_ingestion_log records each per-battery IoT ingestion event so the
// freshness endpoint can compute the most recent telemetry timestamp for a
// tenant's portfolio. The freshness badge in the NBFC portal turns amber when
// the most recent ingestion (or the most recent CDS computed_at) is older than
// 24 hours — surfacing IoT sync issues to the partner.
// -----------------------------------------------------------------------------

export const telemetryIngestionLog = pgTable(
  "telemetry_ingestion_log",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    battery_serial: varchar("battery_serial", { length: 64 }).notNull(),
    ingested_at: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("telemetry_ingestion_log_tenant_idx").on(table.tenant_id),
    tenantIngestedIdx: index("telemetry_ingestion_log_tenant_ingested_idx").on(
      table.tenant_id,
      table.ingested_at,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-029 — EMI schedules (Section 6.1.5)
// -----------------------------------------------------------------------------
// Per-loan EMI ledger feeding the nightly CDS computation (E-029) and the
// PCI computation (E-030). One row per scheduled EMI with `status` in
// {paid, paid_late, missed, overdue, scheduled}; `paid_at` is set when an
// EMI is settled and `days_overdue` tracks how many days late (0 if paid
// on or before due_date).
//
// This table is also referenced by E-028 (Lead Intelligence "EMI Status"
// column) — read-only there.
//
// Naming: `days_overdue` mirrors the BRD field name; an audit fuzzy-match
// flagged loan_files.overdue_days as a token-level twin (different table,
// different concept — loan_files predates the nbfc dashboard era), so we
// keep the BRD-canonical name on this new table.
// -----------------------------------------------------------------------------
export const emiSchedules = pgTable(
  "emi_schedules",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    loan_sanction_id: varchar("loan_sanction_id", { length: 255 }).notNull(),
    due_date: date("due_date").notNull(),
    paid_at: timestamp("paid_at", { withTimezone: true }),
    // Canonical set: scheduled | overdue | missed | paid | paid_late | failed
    status: varchar({ length: 16 }).notNull(),
    days_overdue: integer("days_overdue"),
    // E-171 — EMI Tracker per-installment fields.
    emi_seq: integer("emi_seq"),
    amount: numeric("amount", { precision: 12, scale: 2 }),
    // E-173 — cumulative amount collected against this installment (partial
    // payments). Fully settled when amount_paid >= amount.
    amount_paid: numeric("amount_paid", { precision: 12, scale: 2 }).default("0").notNull(),
    principal_component: numeric("principal_component", { precision: 12, scale: 2 }),
    interest_component: numeric("interest_component", { precision: 12, scale: 2 }),
    attempt_count: integer("attempt_count").default(0).notNull(),
    last_attempt_at: timestamp("last_attempt_at", { withTimezone: true }),
    payment_ref: varchar("payment_ref", { length: 64 }),
    collection_mode: varchar("collection_mode", { length: 16 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    loanIdx: index("emi_schedules_loan_idx").on(table.loan_sanction_id),
    loanDueIdx: index("emi_schedules_loan_due_idx").on(
      table.loan_sanction_id,
      table.due_date,
    ),
    statusDueIdx: index("emi_schedules_status_due_idx").on(
      table.status,
      table.due_date,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-172 — EMI Tracker: per-attempt collection ledger.
// -----------------------------------------------------------------------------
// One row per auto-debit / collection attempt against an emi_schedules row.
// emi_schedules holds installment STATE; this holds the EVENTS (every try, with
// Razorpay correlation handles + raw payload). The UNIQUE index on
// idempotency_key is the hard double-debit guard — the auto-debit cron inserts
// ON CONFLICT DO NOTHING with a deterministic per-(emi, cycle) key.
// -----------------------------------------------------------------------------
export const emiPaymentAttempts = pgTable(
  "emi_payment_attempts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    emi_schedule_id: uuid("emi_schedule_id").notNull(),
    loan_sanction_id: varchar("loan_sanction_id", { length: 255 }).notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    idempotency_key: varchar("idempotency_key", { length: 80 }).notNull(),
    // 'simulate' | 'live' | 'manual'
    mode: varchar("mode", { length: 16 }).notNull(),
    // 'enach' | 'upi_link' | 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'qr'
    channel: varchar("channel", { length: 16 }).notNull(),
    razorpay_order_id: varchar("razorpay_order_id", { length: 64 }),
    razorpay_payment_id: varchar("razorpay_payment_id", { length: 64 }),
    razorpay_customer_id: varchar("razorpay_customer_id", { length: 64 }),
    razorpay_token_id: varchar("razorpay_token_id", { length: 64 }),
    amount_paise: integer("amount_paise").notNull(),
    // 'initiated' | 'submitted' | 'succeeded' | 'failed' | 'simulated'
    status: varchar({ length: 20 }).notNull(),
    provider_raw_status: varchar("provider_raw_status", { length: 120 }),
    failure_reason: text("failure_reason"),
    provider_raw_payload: jsonb("provider_raw_payload"),
    // E-173 — manual-collection metadata.
    reference_no: varchar("reference_no", { length: 80 }),
    document_url: text("document_url"),
    collected_at: timestamp("collected_at", { withTimezone: true }),
    note: text("note"),
    actor_user_id: uuid("actor_user_id"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    idemUnique: uniqueIndex("emi_payment_attempts_idem_uniq").on(table.idempotency_key),
    tenantIdx: index("emi_payment_attempts_tenant_idx").on(table.tenant_id),
    emiIdx: index("emi_payment_attempts_emi_idx").on(table.emi_schedule_id),
    orderIdx: index("emi_payment_attempts_order_idx").on(table.razorpay_order_id),
    paymentIdx: index("emi_payment_attempts_payment_idx").on(table.razorpay_payment_id),
  }),
);

// -----------------------------------------------------------------------------
// E-181 — EMI Tracker per-loan display overrides.
// -----------------------------------------------------------------------------
// Manual override layer for the EMI Tracker portfolio table. Keyed by
// (tenant, loan_application_id). Every column is nullable — NULL means "no
// override, show the computed/stored value". The page query COALESCEs
// override → computed, so canonical records are never mutated and clearing an
// override reverts to the live value. See drizzle/E-181_*.sql.
// -----------------------------------------------------------------------------
export const nbfcEmiTrackerOverrides = pgTable(
  "nbfc_emi_tracker_overrides",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    // E-183 — nullable: a STANDALONE row (is_standalone=true) has no loan.
    loan_application_id: varchar("loan_application_id", { length: 255 }),
    // E-183 — true for a force-imported row with no matching loan; the row
    // carries all its own display values (no computed fallback) and the EMI
    // Tracker page UNIONs it in. Edited/deleted by id, never feeds CDS/PCI/DPD.
    is_standalone: boolean("is_standalone").default(false).notNull(),
    borrower: text("borrower"),
    vehicleno: text("vehicleno"),
    emi: numeric("emi", { precision: 12, scale: 2 }),
    next_due: date("next_due"),
    last_paid: date("last_paid"),
    progress_paid: integer("progress_paid"),
    progress_total: integer("progress_total"),
    status: varchar("status", { length: 16 }),
    dpd: integer("dpd"),
    mandate: varchar("mandate", { length: 30 }),
    next_auto_debit: date("next_auto_debit"),
    // E-182 — free-text financier label (no computed fallback; NULL → "—").
    financier: text("financier"),
    updated_by: uuid("updated_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantLoanUniq: uniqueIndex("nbfc_emi_tracker_overrides_tenant_loan_uidx").on(
      table.tenant_id,
      table.loan_application_id,
    ),
    // E-183 — one standalone row per (tenant, battery serial).
    standaloneSerialUniq: uniqueIndex("nbfc_emi_tracker_overrides_standalone_serial_uidx")
      .on(table.tenant_id, sql`lower(vehicleno)`)
      .where(sql`is_standalone`),
  }),
);

// -----------------------------------------------------------------------------
// E-067 — Risk Rule Engine threshold configuration (Section 6.3.3)
// -----------------------------------------------------------------------------
// Single canonical platform-wide table that holds the eight tunable risk
// thresholds (CDS bands, alert triggers, action gates). E-067 owns this table
// (read + impact-preview); E-085's dual-approval gate writes back into
// `current_value` here after the second approver signs off, and separately
// records the change history in its own audit table
// (`nbfc_risk_rule_thresholds`). See drizzle/E-067_nbfc_risk_rules.sql for
// the seed of the eight platform rules.
// -----------------------------------------------------------------------------
export const nbfcRiskRules = pgTable(
  "nbfc_risk_rules",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    rule_key: varchar("rule_key", { length: 64 }).notNull().unique(),
    rule_label: varchar("rule_label", { length: 160 }).notNull(),
    current_value: numeric("current_value", { precision: 12, scale: 4 }).notNull(),
    unit: varchar("unit", { length: 16 }),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updated_by: uuid("updated_by"),
  },
);

// -----------------------------------------------------------------------------
// E-091 — DPDPA retention tombstones.
//
// Every DPDPA-driven deletion (KYC docs purged after 7y, telemetry raw events
// purged after 2y, future categories) is recorded here as an immutable
// attestation. The original PII is gone but the *fact* of the deletion is
// auditable: which table, which id (or row count for batch deletes), why,
// and where it was stored — DPDPA 2023 + RBI accountability.
//
// storage_region defaults to 'ap-south-1' (Mumbai) per the data-localisation
// requirement: deletion never crosses borders.
// -----------------------------------------------------------------------------

export const nbfcRetentionTombstones = pgTable(
  "nbfc_retention_tombstones",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    table_name: varchar("table_name", { length: 64 }).notNull(),
    original_id: varchar("original_id", { length: 255 }),
    row_count: integer("row_count").default(1).notNull(),
    reason: varchar("reason", { length: 64 }).notNull(),
    deleted_at: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
    storage_region: varchar("storage_region", { length: 24 })
      .default('ap-south-1')
      .notNull(),
  },
  (table) => ({
    tableNameIdx: index("nbfc_retention_tombstones_table_name_idx").on(
      table.table_name,
    ),
    deletedAtIdx: index("nbfc_retention_tombstones_deleted_at_idx").on(
      table.deleted_at,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-068 — Risk Rule Engine dual-approval commit workflow (BRD §6.3.3)
// -----------------------------------------------------------------------------
// One row per pending/executed/rejected threshold-change request.
//
// Lifecycle:
//   pending_second_approval — requester submitted with MFA; awaits Risk Head.
//   executed                — Risk Head approved; nbfc_risk_rules.current_value
//                             now equals new_value; applied_at is set.
//   rejected                — Risk Head rejected; current_value untouched.
//
// Distinct from `dual_approval_requests` (E-082): that primitive gates per-NBFC
// *operational* actions on a per-tenant basis. The eight platform thresholds
// in `nbfc_risk_rules` have no tenant_id, so their change history lives here
// in a global table instead.
// -----------------------------------------------------------------------------
export const nbfcRiskRuleChangeRequests = pgTable(
  "nbfc_risk_rule_change_requests",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    rule_key: varchar("rule_key", { length: 64 }).notNull(),
    previous_value: numeric("previous_value", { precision: 12, scale: 4 })
      .notNull(),
    new_value: numeric("new_value", { precision: 12, scale: 4 }).notNull(),
    requested_by: uuid("requested_by").notNull(),
    approved_by: uuid("approved_by"),
    status: varchar("status", { length: 32 }).notNull(),
    requested_at: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    applied_at: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("nbfc_risk_rule_change_requests_status_idx").on(
      table.status,
    ),
    ruleKeyIdx: index("nbfc_risk_rule_change_requests_rule_key_idx").on(
      table.rule_key,
    ),
    requestedByIdx: index("nbfc_risk_rule_change_requests_requested_by_idx").on(
      table.requested_by,
    ),
  }),
);

// =============================================================================
// END NBFC additions
// =============================================================================

// Dealer correction rounds — one row per round of "Request Correction" against
// a dealer onboarding application. Supports multiple rounds: when a new round
// is opened, any existing pending/submitted round for the same application is
// flipped to "superseded".
//
// status flow:
//   pending      — round opened, dealer has not submitted yet
//   submitted    — dealer submitted via the magic-link form
//   applied      — admin clicked Update Application; values merged into app
//   superseded   — a newer round was opened before this one was applied
export const dealerCorrectionRounds = pgTable(
  "dealer_correction_rounds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    application_id: uuid("application_id")
      .notNull()
      .references(() => dealerOnboardingApplications.id, { onDelete: "cascade" }),
    round_number: integer("round_number").notNull(),
    status: varchar("status", { length: 30 }).default("pending").notNull(),
    requested_by: uuid("requested_by"),
    remarks: text("remarks").notNull(),
    requested_fields: jsonb("requested_fields").$type<string[]>().default([]).notNull(),
    requested_documents: jsonb("requested_documents").$type<string[]>().default([]).notNull(),
    dealer_submitted_at: timestamp("dealer_submitted_at"),
    dealer_note: text("dealer_note"),
    applied_by: uuid("applied_by"),
    applied_at: timestamp("applied_at"),
    // sha256 hex of the raw token sent in the dealer email — never store the
    // raw token. Lookup is by hash.
    token_hash: text("token_hash").notNull().unique(),
    token_expires_at: timestamp("token_expires_at").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    applicationIdx: index("dealer_correction_rounds_application_id_idx").on(
      table.application_id,
    ),
    statusIdx: index("dealer_correction_rounds_status_idx").on(table.status),
    tokenHashIdx: index("dealer_correction_rounds_token_hash_idx").on(
      table.token_hash,
    ),
  }),
);

// One row per (round × document or field) — captures both the originally
// requested item AND the dealer's submitted response so the admin panel can
// render a clean before/after diff without recomputing from history.
export const dealerCorrectionItems = pgTable(
  "dealer_correction_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    round_id: uuid("round_id")
      .notNull()
      .references(() => dealerCorrectionRounds.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 20 }).notNull(), // "field" | "document"
    key: varchar("key", { length: 100 }).notNull(),
    previous_value: text("previous_value"),
    new_value: text("new_value"),
    previous_document_id: uuid("previous_document_id"),
    new_document_id: uuid("new_document_id"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    roundIdx: index("dealer_correction_items_round_id_idx").on(table.round_id),
  }),
);

// =============================================================================
// E-082 — Dual Approval Gate primitive
// Two-person rule for high-impact NBFC actions (battery immobilisation, loan
// restructuring, risk-rule threshold change, bulk immobilisation, auction lot
// cancellation, audit-log export, PII access). Initiator creates a pending
// row; an Approver 2 (distinct user, role-matched) approves or rejects within
// 24h. Status transitions are append-only and mirrored in `audit_logs`.
// =============================================================================

export const dualApprovalRequests = pgTable(
  "dual_approval_requests",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull().references(() => nbfcTenants.id),
    action_type: varchar("action_type", { length: 64 }).notNull(),
    entity_id: varchar("entity_id", { length: 255 }).notNull(),
    initiator_user_id: uuid("initiator_user_id").notNull(),
    approver_user_id: uuid("approver_user_id"),
    required_approver_role: varchar("required_approver_role", { length: 64 }).notNull(),
    status: varchar("status", { length: 24 }).default('pending_approval').notNull(),
    reason_code: varchar("reason_code", { length: 64 }).notNull(),
    evidence_snapshot: jsonb("evidence_snapshot").notNull(),
    borrower_notice_id: varchar("borrower_notice_id", { length: 255 }),
    rejection_reason: text("rejection_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    rejected_at: timestamp("rejected_at", { withTimezone: true }),
    expired_at: timestamp("expired_at", { withTimezone: true }),
  },
  (table) => ({
    tenantStatusIdx: index("dual_approval_requests_tenant_status_idx").on(
      table.tenant_id,
      table.status,
    ),
    initiatorIdx: index("dual_approval_requests_initiator_idx").on(table.initiator_user_id),
    expiresIdx: index("dual_approval_requests_expires_idx").on(table.expires_at),
  }),
);

// Catalogue of which action_type requires which Approver-2 role. Tenant-scoped
// so each NBFC may map roles differently. Seeded once per tenant at deploy.
export const dualApprovalActionConfig = pgTable(
  "dual_approval_action_config",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    action_type: varchar("action_type", { length: 64 }).notNull(),
    initiator_role: varchar("initiator_role", { length: 64 }).notNull(),
    approver_role: varchar("approver_role", { length: 64 }).notNull(),
  },
  (table) => ({
    actionTypeIdx: index("dual_approval_action_config_action_type_idx").on(
      table.action_type,
    ),
  }),
);

// =============================================================================
// E-085 — Risk Rule Threshold Change (BRD §6.4.3)
// Append-only history of risk-rule threshold mutations. Every approved change
// is appended (never edited in place); the previously active row for the same
// rule_key is flipped is_active=false at apply time. Tied to a
// dual_approval_requests row via approval_request_id so RBI auditors can trace
// any threshold mutation back to its two-person approval.
// =============================================================================
export const nbfcRiskRuleThresholds = pgTable(
  "nbfc_risk_rule_thresholds",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    rule_key: varchar("rule_key", { length: 128 }).notNull(),
    prior_threshold_json: jsonb("prior_threshold_json"),
    new_threshold_json: jsonb("new_threshold_json").notNull(),
    approval_request_id: uuid("approval_request_id").notNull(),
    applied_at: timestamp("applied_at", { withTimezone: true }),
    applied_by: uuid("applied_by"),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => ({
    ruleKeyActiveIdx: index("nbfc_risk_rule_thresholds_rule_key_active_idx").on(
      table.rule_key,
      table.is_active,
    ),
    approvalRequestIdx: index("nbfc_risk_rule_thresholds_approval_request_idx").on(
      table.approval_request_id,
    ),
  }),
);

// =============================================================================
// E-083 — Battery Immobilisation Action (Section 6.4.3)
// One row per executed immobilisation outcome. Created ONLY after the upstream
// dual_approval_requests row (action_type='battery_immobilisation') flips to
// 'approved' by an nbfc_risk_head user. iot_command_id and executed_at stamp
// the IoT dispatch; borrower_notified_at is set if a Fair-Practices notice was
// sent. Separate from the approval row because one approval can spawn multiple
// side-effects (notice, IoT command, audit log).
// =============================================================================
export const nbfcImmobilisationActions = pgTable(
  "nbfc_immobilisation_actions",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => nbfcTenants.id),
    loan_application_id: varchar("loan_application_id", {
      length: 255,
    }).notNull(),
    imei: varchar("imei", { length: 64 }).notNull(),
    approval_request_id: uuid("approval_request_id").notNull(),
    iot_command_id: varchar("iot_command_id", { length: 128 }),
    executed_at: timestamp("executed_at", { withTimezone: true }),
    borrower_notified_at: timestamp("borrower_notified_at", {
      withTimezone: true,
    }),
  },
  (table) => ({
    approvalRequestIdx: index(
      "nbfc_immobilisation_actions_approval_request_idx",
    ).on(table.approval_request_id),
    tenantLoanIdx: index("nbfc_immobilisation_actions_tenant_loan_idx").on(
      table.tenant_id,
      table.loan_application_id,
    ),
  }),
);

// =============================================================================
// E-084 — Loan Restructuring Restructure History (Section 6.4.3)
// Records every loan-restructuring event executed via the dual-approval gate
// (Risk Manager initiates → Credit Manager approves). Captures prior vs new
// EMI terms and the link back to the dual_approval_requests row that
// authorised the change. Distinct from nbfc_loans (mutable current state) so
// the history of restructures is preserved across multiple events.
// =============================================================================
export const nbfcLoanRestructures = pgTable(
  "nbfc_loan_restructures",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => nbfcTenants.id),
    loan_application_id: varchar("loan_application_id", { length: 255 }).notNull(),
    approval_request_id: uuid("approval_request_id").notNull(),
    prior_emi_amount: numeric("prior_emi_amount", { precision: 12, scale: 2 }),
    new_emi_amount: numeric("new_emi_amount", { precision: 12, scale: 2 }).notNull(),
    prior_tenure_months: integer("prior_tenure_months"),
    new_tenure_months: integer("new_tenure_months").notNull(),
    new_emi_due_dom: integer("new_emi_due_dom").notNull(),
    executed_at: timestamp("executed_at", { withTimezone: true }),
  },
  (table) => ({
    tenantLoanIdx: index("nbfc_loan_restructures_tenant_loan_idx").on(
      table.tenant_id,
      table.loan_application_id,
    ),
    approvalIdx: index("nbfc_loan_restructures_approval_idx").on(
      table.approval_request_id,
    ),
  }),
);

// =============================================================================
// E-089 — PII Access Gated (BRD §6.4.3 — "PII Data Access")
// Adds the requestor-MFA leg + time-boxed grant ledger on top of E-082's
// dual-approval primitive. Action_type 'pii_data_access' flows through
// dualApprovalRequests; once Compliance Officer approves, this table mints a
// short-lived (30 min) access token for a single unmask call by the
// requestor for one specific lead. Each unmask is logged in audit_logs.
// =============================================================================
export const nbfcPiiAccessGrants = pgTable(
  "nbfc_pii_access_grants",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    requested_by: uuid("requested_by").notNull(),
    approval_request_id: uuid("approval_request_id").notNull(),
    access_token: varchar("access_token", { length: 128 }).notNull(),
    fields: jsonb("fields").notNull(),
    granted_at: timestamp("granted_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    used_count: integer("used_count").default(0).notNull(),
  },
  (table) => ({
    accessTokenIdx: uniqueIndex("nbfc_pii_access_grants_access_token_idx").on(
      table.access_token,
    ),
    approvalIdx: index("nbfc_pii_access_grants_approval_idx").on(
      table.approval_request_id,
    ),
    leadIdx: index("nbfc_pii_access_grants_lead_idx").on(table.lead_id),
  }),
);

// =============================================================================
// E-003 — NBFC Master Details (Section 6.0.3)
// Master NBFC partner table per BRD 6.0.7 — captures NBFC partner identities,
// RBI registration data, statutory IDs (CIN, GST, PAN), grievance officer
// fields (mandatory per RBI DL Directions 2025), and partnership metadata.
// Distinct from `nbfc_tenants` which models the multi-tenant dashboard scope.
//
// E-001 augmentation: `approved_by` / `approved_at` capture the final approval
// gate release (null until the gate passes; 409 idempotency on re-approval).
// =============================================================================
export const nbfc = pgTable("nbfc", {
  id: serial("id").primaryKey(),
  nbfc_id: varchar("nbfc_id", { length: 50 }).notNull().unique(),
  legal_name: varchar("legal_name", { length: 200 }).notNull(),
  short_name: varchar("short_name", { length: 100 }).notNull(),
  rbi_registration_no: varchar("rbi_registration_no", { length: 100 }).notNull().unique(),
  cin: varchar("cin", { length: 25 }).notNull(),
  gst_number: varchar("gst_number", { length: 20 }).notNull(),
  pan_number: varchar("pan_number", { length: 20 }).notNull(),
  nbfc_type: varchar("nbfc_type", { length: 32 }).notNull(),
  registered_address: jsonb("registered_address").notNull(),
  active_geographies: jsonb("active_geographies").notNull(),
  primary_contact_name: varchar("primary_contact_name", { length: 200 }).notNull(),
  primary_contact_email: varchar("primary_contact_email", { length: 200 }).notNull(),
  primary_contact_phone: varchar("primary_contact_phone", { length: 20 }).notNull(),
  grievance_officer_name: varchar("grievance_officer_name", { length: 200 }).notNull(),
  grievance_helpline: varchar("grievance_helpline", { length: 200 }).notNull(),
  grievance_url: text("grievance_url").notNull(),
  nodal_officer: varchar("nodal_officer", { length: 200 }),
  partnership_date: date("partnership_date").notNull(),
  fldg_terms: text("fldg_terms"),
  cor_expiry_date: date("cor_expiry_date"),
  lsp_agreement_id: integer("lsp_agreement_id"),
  status: varchar("status", { length: 32 }).default("draft").notNull(),
  // E-001 — final approval gate audit columns. approved_by stores the admin
  // user uuid that released the gate; approved_at stamps when the gate fell.
  // Both stay null until the gate passes; a 409 idempotency check rejects
  // re-approving an already-approved NBFC.
  approved_by: uuid("approved_by"),
  approved_at: timestamp("approved_at", { withTimezone: true }),
  // E-107 — Step 2.5 mid-flow CEO verification stamping. docs_verified_at
  // is read by the LSP signer-form gate to unlock Step 3 for the Admin.
  docs_verified_at: timestamp("docs_verified_at", { withTimezone: true }),
  docs_verified_by: uuid("docs_verified_by"),
  // E-002 — activation timestamp. Distinct from approved_at: approved_at fires
  // when the final-approval gate releases (status='approved'); activated_at
  // fires when portal credentials are dispatched (status='active').
  activated_at: timestamp("activated_at", { withTimezone: true }),
  // E-026B — bridge to the portal tenant scope. Nullable because legacy NBFC
  // rows may not have a corresponding nbfc_tenants entry yet; backfilled by
  // legal_name match in the E-026B migration.
  tenant_id: uuid("tenant_id").references(() => nbfcTenants.id),
  created_by: integer("created_by").notNull(),
  // E-108 — Supabase auth uuid of the user who created the row. Nullable for
  // legacy rows (pre-E-108). New inserts always populate this so the "My
  // Submitted Drafts" sidebar entry (/admin/nbfc?owner=me) can scope.
  created_by_auth_id: uuid("created_by_auth_id"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// =============================================================================
// E-002 — NBFC portal credential issuance audit (Section 6.0.2 Step 6)
// One row per credential dispatch attempt for an NBFC partner. Records the
// supabase auth user that backs the portal login, the dispatch lifecycle
// (pending → dispatched | failed), and the timestamp the credential email was
// sent. Password itself is never persisted — only Supabase holds the hashed
// credential. Resend operations append additional rows so every attempt is
// auditable.
// =============================================================================
export const nbfcPortalCredentials = pgTable(
  "nbfc_portal_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nbfc_id: integer("nbfc_id")
      .notNull()
      .references(() => nbfc.id),
    supabase_user_id: uuid("supabase_user_id").notNull(),
    email_dispatched_at: timestamp("email_dispatched_at", {
      withTimezone: true,
    }),
    dispatch_status: varchar("dispatch_status", { length: 32 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    nbfcIdx: index("nbfc_portal_credentials_nbfc_id_idx").on(table.nbfc_id),
    statusIdx: index("nbfc_portal_credentials_dispatch_status_idx").on(
      table.dispatch_status,
    ),
  }),
);

// =============================================================================
// E-005 — NBFC compliance document upload/verify/reject workflow
// (Section 6.0.4)
// Per-NBFC compliance document tracking with verify/reject lifecycle, distinct
// from dealer documents. Each row is one document upload by an admin, then
// transitions through pending_review → verified | rejected.
// =============================================================================
export const nbfcComplianceDocuments = pgTable(
  "nbfc_compliance_documents",
  {
    id: serial("id").primaryKey(),
    nbfc_id: integer("nbfc_id")
      .notNull()
      .references(() => nbfc.id),
    document_type: varchar("document_type", { length: 64 }).notNull(),
    file_url: text("file_url").notNull(),
    expiry_date: date("expiry_date"),
    status: varchar("status", { length: 32 })
      .default("pending_review")
      .notNull(),
    uploaded_by: integer("uploaded_by").notNull(),
    verified_by: integer("verified_by"),
    verified_at: timestamp("verified_at", { withTimezone: true }),
    rejected_by: integer("rejected_by"),
    rejected_at: timestamp("rejected_at", { withTimezone: true }),
    rejection_reason: text("rejection_reason"),
    verifier_notes: text("verifier_notes"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    nbfcIdx: index("nbfc_compliance_documents_nbfc_id_idx").on(table.nbfc_id),
    statusIdx: index("nbfc_compliance_documents_status_idx").on(table.status),
  }),
);

// =============================================================================
// E-006 — RBI CoR expiry alert ledger (Section 6.0.4)
// Tracks which (nbfc_id, cor_expiry_date) pair has already received a 60-day
// expiry-warning alert. Idempotency guard for the daily cron — without this
// table the same alert would fan out daily for the entire 60-day window.
// =============================================================================
export const nbfcCorExpiryAlerts = pgTable(
  "nbfc_cor_expiry_alerts",
  {
    id: serial("id").primaryKey(),
    nbfc_id: integer("nbfc_id")
      .notNull()
      .references(() => nbfc.id),
    cor_expiry_date: date("cor_expiry_date").notNull(),
    alerted_at: timestamp("alerted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    nbfcIdx: index("nbfc_cor_expiry_alerts_nbfc_id_idx").on(table.nbfc_id),
    pairIdx: uniqueIndex("nbfc_cor_expiry_alerts_pair_idx").on(
      table.nbfc_id,
      table.cor_expiry_date,
    ),
  }),
);

// E-007/E-008 — Digio-driven LSP agreement record. agreement_status mirrors the
// shared dealer agreement_status ENUM domain (DRAFT, INITIATED, IN_PROGRESS,
// COMPLETED, FAILED, EXPIRED, SENT_TO_EXTERNAL_PARTY, SIGN_PENDING,
// PARTIALLY_SIGNED, SIGNED) per Sync Audit G-01. Stored as varchar so the
// final-approval gate can re-validate it via a simple equality check.
//
// E-007 augmentation: signatory fields, agreement_id (AGR-NBFC-YYYYMMDD-SEQ
// pattern), expires_at, audit_trail_url, signing_date, created_by per
// Section 6.0.4a's Digio multi_templates create_sign_request integration.
export const nbfcLspAgreements = pgTable(
  "nbfc_lsp_agreements",
  {
    id: serial("id").primaryKey().notNull(),
    agreement_id: varchar("agreement_id", { length: 50 }).unique(),
    nbfc_id: integer("nbfc_id").notNull().references(() => nbfc.id),
    digio_request_id: varchar("digio_request_id", { length: 128 }),
    digio_document_id: varchar("digio_document_id", { length: 128 }),
    agreement_status: varchar("agreement_status", { length: 32 }).default("DRAFT").notNull(),
    signing_date: date("signing_date"),
    nbfc_signatory_name: varchar("nbfc_signatory_name", { length: 200 }),
    nbfc_signatory_email: varchar("nbfc_signatory_email", { length: 200 }),
    itarang_signatory_1_name: varchar("itarang_signatory_1_name", { length: 200 }),
    itarang_signatory_1_email: varchar("itarang_signatory_1_email", { length: 200 }),
    itarang_signatory_2_name: varchar("itarang_signatory_2_name", { length: 200 }),
    itarang_signatory_2_email: varchar("itarang_signatory_2_email", { length: 200 }),
    signed_pdf_url: text("signed_pdf_url"),
    audit_trail_url: text("audit_trail_url"),
    // E-110 — admin-uploaded blank template (the file Digio will eventually
    // paint with signer fields). Filled at Step 3 "Send to CEO" and read by
    // the CEO approval gate.
    agreement_template_url: text("agreement_template_url"),
    agreement_template_size: integer("agreement_template_size"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    created_by: integer("created_by"),
    initiated_by: integer("initiated_by"),
    initiated_at: timestamp("initiated_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    last_webhook_payload: jsonb("last_webhook_payload"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    nbfcIdx: index("nbfc_lsp_agreements_nbfc_id_idx").on(table.nbfc_id),
    statusIdx: index("nbfc_lsp_agreements_status_idx").on(table.agreement_status),
    agreementIdIdx: index("nbfc_lsp_agreements_agreement_id_idx").on(table.agreement_id),
  }),
);

// =============================================================================
// E-109 — Per-signer rows for an NBFC LSP agreement (N signers, designation,
// identity-document URL). Replaces the legacy 3 hardcoded signer columns on
// nbfc_lsp_agreements for new initiations; old columns stay nullable for
// backward compat. See drizzle/E-109_nbfc_lsp_agreement_signers.sql.
// =============================================================================
export const nbfcLspAgreementSigners = pgTable(
  "nbfc_lsp_agreement_signers",
  {
    id: serial("id").primaryKey().notNull(),
    nbfc_lsp_agreement_id: integer("nbfc_lsp_agreement_id")
      .notNull()
      .references(() => nbfcLspAgreements.id),
    signer_order: integer("signer_order").notNull(),
    party: varchar("party", { length: 20 }).notNull(),
    full_name: varchar("full_name", { length: 200 }).notNull(),
    email: varchar("email", { length: 200 }).notNull(),
    designation: varchar("designation", { length: 120 }).notNull(),
    identity_document_url: text("identity_document_url").notNull(),
    identity_document_size: integer("identity_document_size"),
    // E-112 — per-signer Digio signing status. See drizzle/E-112_*.sql.
    digio_signer_identifier: varchar("digio_signer_identifier", { length: 200 }),
    signing_status: varchar("signing_status", { length: 32 })
      .notNull()
      .default("pending"),
    signed_at: timestamp("signed_at", { withTimezone: true }),
    signing_url: text("signing_url"),
    last_status_event_at: timestamp("last_status_event_at", {
      withTimezone: true,
    }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    agreementIdx: index("idx_nbfc_lsp_agreement_signers_agreement").on(
      table.nbfc_lsp_agreement_id,
      table.signer_order,
    ),
    statusIdx: index("idx_nbfc_lsp_signers_status").on(
      table.nbfc_lsp_agreement_id,
      table.signing_status,
    ),
  }),
);

// =============================================================================
// E-009 — NBFC loan-product catalogue (BRD 6.0.5)
// Per-NBFC product definitions: amount/tenure ranges, ROI bounds, down-payment,
// subvention, file charges, and disbursement method. Status gates which products
// are offerable. References the canonical `nbfc` master from E-003.
// =============================================================================
export const nbfcLoanProducts = pgTable("nbfc_loan_products", {
  id: serial("id").primaryKey(),
  nbfc_id: integer("nbfc_id")
    .notNull()
    .references(() => nbfc.id),
  product_name: varchar("product_name", { length: 120 }).notNull(),
  eligible_battery_categories: jsonb("eligible_battery_categories")
    .$type<string[]>()
    .notNull(),
  loan_amount_min: integer("loan_amount_min").notNull(),
  loan_amount_max: integer("loan_amount_max").notNull(),
  tenure_months_min: integer("tenure_months_min").notNull(),
  tenure_months_max: integer("tenure_months_max").notNull(),
  min_roi_pct: numeric("min_roi_pct", { precision: 5, scale: 2 }).notNull(),
  max_roi_pct: numeric("max_roi_pct", { precision: 5, scale: 2 }).notNull(),
  down_payment_pct: numeric("down_payment_pct", {
    precision: 5,
    scale: 2,
  }).notNull(),
  subvention_available: boolean("subvention_available")
    .default(false)
    .notNull(),
  file_charge_fixed: numeric("file_charge_fixed", { precision: 12, scale: 2 }),
  file_charge_pct: numeric("file_charge_pct", { precision: 5, scale: 2 }),
  disbursement_method: varchar("disbursement_method", {
    length: 32,
  }).notNull(),
  status: varchar("status", { length: 16 }).default("active").notNull(),
  // E-113 — Scheme highlights, geography, and eligibility checklist.
  // Deprecated by E-114 — replaced by active_locations. Kept for additive-migration policy.
  active_cities: jsonb("active_cities")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // E-114 — Structured state+city pairs, queryable via JSONB @> for dealer filter.
  active_locations: jsonb("active_locations")
    .$type<{ state: string; city: string }[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  processing_fee_owned_rupees: integer("processing_fee_owned_rupees"),
  processing_fee_rented_rupees: integer("processing_fee_rented_rupees"),
  health_life_insurance_owned_rupees: integer("health_life_insurance_owned_rupees"),
  health_life_insurance_rented_rupees: integer("health_life_insurance_rented_rupees"),
  disbursement_tat_hours: integer("disbursement_tat_hours"),
  min_credit_score: integer("min_credit_score"),
  // E-115 — CIBIL/CRIF applicability + upper bound. cibil_required = null means
  // "legacy row, unknown"; false = bureau check waived; true = both min and max
  // must be set (enforced by the API Zod refinement).
  cibil_required: boolean("cibil_required"),
  max_credit_score: integer("max_credit_score"),
  // E-130 — Addendum V0.1 §4.3. Bureau-abstracted gate. Phase 1 ships the
  // handle (default 'equifax'); Phase 3 swaps the live provider behind it.
  // Reserved values: 'equifax' (default), 'cibil' (legacy), 'crif', 'experian'.
  credit_bureau: varchar("credit_bureau", { length: 20 }).default('equifax'),
  eligibility_documents: jsonb("eligibility_documents")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// =============================================================================
// E-065 — NBFC Ecosystem Overview metrics cache (BRD §6.3.2)
// Stores 15-minute IoT connectivity rollup and nightly Avg CDS network value
// to satisfy BRD refresh cadence without recomputing on every request.
// Keyed by metric_key so the route can fetch by well-known constants
// (e.g. 'iot_connectivity_pct', 'avg_cds_network', 'platform_uptime_pct').
// =============================================================================
export const nbfcEcosystemMetricsCache = pgTable("nbfc_ecosystem_metrics_cache", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  metric_key: varchar("metric_key", { length: 64 }).notNull().unique(),
  metric_value: numeric("metric_value", { precision: 18, scale: 4 }),
  refreshed_at: timestamp("refreshed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// =============================================================================
// E-011 — NBFC status lifecycle audit table (BRD 6.0.6)
// Records every NBFC status transition with actor and reason for the RBI audit
// trail. Append-only: rows are immutable. The 8-state transition graph itself
// is enforced by `src/lib/nbfc/admin/status-transitions.ts`; this table is the
// durable journal those transitions write to. actor_id is uuid to match the
// rest of the codebase's user-id convention (audit_logs.performed_by is uuid).
// =============================================================================
export const nbfcStatusHistory = pgTable(
  "nbfc_status_history",
  {
    id: serial("id").primaryKey(),
    nbfc_id: integer("nbfc_id")
      .notNull()
      .references(() => nbfc.id),
    from_status: varchar("from_status", { length: 32 }),
    to_status: varchar("to_status", { length: 32 }).notNull(),
    actor_id: uuid("actor_id").notNull(),
    reason: text("reason"),
    occurred_at: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    nbfcIdx: index("nbfc_status_history_nbfc_id_idx").on(table.nbfc_id),
    occurredAtIdx: index("nbfc_status_history_occurred_at_idx").on(
      table.occurred_at,
    ),
  }),
);

// =============================================================================
// E-111 — CEO per-item correction request rounds (BRD §6.0.6 Step 4)
// Each CEO "Request Corrections" submission writes one row to
// nbfc_correction_rounds and one row per flagged item to
// nbfc_correction_items. Round + item state machine:
//   round:  open → resolved | superseded
//   item:   pending → resolved | dismissed
// When admin transitions request_correction → pending_admin_review, the
// transition route auto-snapshots the new value/file_url into each pending
// item and flips the round to resolved. See
// `src/app/api/admin/nbfc/[nbfcId]/transition/route.ts`.
// =============================================================================
export const nbfcCorrectionRounds = pgTable(
  "nbfc_correction_rounds",
  {
    id: serial("id").primaryKey(),
    nbfc_id: integer("nbfc_id")
      .notNull()
      .references(() => nbfc.id, { onDelete: "cascade" }),
    round_number: integer("round_number").notNull(),
    status: varchar("status", { length: 20 }).default("open").notNull(),
    requested_by: uuid("requested_by").notNull(),
    summary_remarks: text("summary_remarks"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    resolved_by: uuid("resolved_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueRound: uniqueIndex("nbfc_correction_rounds_unique").on(
      table.nbfc_id,
      table.round_number,
    ),
    nbfcStatusIdx: index("idx_nbfc_correction_rounds_nbfc_status").on(
      table.nbfc_id,
      table.status,
    ),
  }),
);

export const nbfcCorrectionItems = pgTable(
  "nbfc_correction_items",
  {
    id: serial("id").primaryKey(),
    round_id: integer("round_id")
      .notNull()
      .references(() => nbfcCorrectionRounds.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 24 }).notNull(),
    target_key: varchar("target_key", { length: 120 }).notNull(),
    target_ref_id: integer("target_ref_id"),
    previous_value: text("previous_value"),
    previous_file_url: text("previous_file_url"),
    remark: text("remark"),
    resolution_status: varchar("resolution_status", { length: 20 })
      .default("pending")
      .notNull(),
    new_value: text("new_value"),
    new_file_url: text("new_file_url"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    resolved_by: uuid("resolved_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueItem: uniqueIndex("nbfc_correction_items_unique").on(
      table.round_id,
      table.kind,
      table.target_key,
    ),
    roundStatusIdx: index("idx_nbfc_correction_items_round_status").on(
      table.round_id,
      table.resolution_status,
    ),
  }),
);

// =============================================================================
// E-086 — Bulk Immobilisation (>5 batteries) gated by dual approval
// (BRD §6.4.3 row "Bulk Immobilisation"; Approver 1: NBFC Risk Head,
// Approver 2: iTarang Admin). RBI Digital Lending Directions 2025 elevate
// bulk recovery actions (>5 batteries in a single batch) to a two-person
// rule beyond the standard per-loan dual approval (E-033 / E-082). This
// table captures the batch identity and aggregate counts so audit reviewers
// can see a single approval covered N loans, not N separate approvals.
// =============================================================================
export const nbfcBulkImmobilisationBatches = pgTable(
  "nbfc_bulk_immobilisation_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => nbfcTenants.id),
    approval_request_id: uuid("approval_request_id").notNull(),
    batch_size: integer("batch_size").notNull(),
    loan_application_ids: jsonb("loan_application_ids").notNull(),
    executed_at: timestamp("executed_at", { withTimezone: true }),
    executed_count: integer("executed_count").default(0).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_bulk_immob_batches_tenant_idx").on(table.tenant_id),
    approvalIdx: index("nbfc_bulk_immob_batches_approval_idx").on(
      table.approval_request_id,
    ),
  }),
);

// =============================================================================
// E-088 — Audit log data export gated by dual approval (BRD §6.4.3)
// Records the lifecycle of bulk audit-log export requests: requestor identity,
// MFA confirmation timestamp, time range, expected/actual row count, and the
// signed-URL artefact + checksum produced after the iTarang Compliance Officer
// approves via the E-082 dual-approval gate. Required for DPDPA accountability
// when audit data leaves the system; the row is created with status implicit
// in the FK to dual_approval_requests, and download_url/checksum_sha256 stay
// NULL until the second approver flips the request to 'approved' and the
// async export job completes.
// =============================================================================
export const nbfcAuditLogExports = pgTable(
  "nbfc_audit_log_exports",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    requested_by: uuid("requested_by").notNull(),
    approval_request_id: uuid("approval_request_id").notNull(),
    mfa_verified_at: timestamp("mfa_verified_at", { withTimezone: true })
      .notNull(),
    from_ts: timestamp("from_ts", { withTimezone: true }).notNull(),
    to_ts: timestamp("to_ts", { withTimezone: true }).notNull(),
    entity_type: varchar("entity_type", { length: 50 }),
    row_count: integer("row_count"),
    download_url: text("download_url"),
    checksum_sha256: varchar("checksum_sha256", { length: 64 }),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    approvalIdx: index("nbfc_audit_log_exports_approval_idx").on(
      table.approval_request_id,
    ),
    requestedByIdx: index("nbfc_audit_log_exports_requested_by_idx").on(
      table.requested_by,
    ),
  }),
);

// =============================================================================
// E-092 — CDS/PCI Score Explainability Drawer (BRD §6.4.5)
// =============================================================================
// Persists each CDS/PCI score computation along with the exact EMI inputs that
// produced it, so the explainability drawer can render formula + inputs +
// confidence with no recomputation drift.
//
//   • nbfc_score_runs            — one row per (loan, score_type) computation;
//                                  carries score_value, computed_at, confidence
//   • nbfc_score_input_snapshots — last-N EMI rows tied to a score run, with
//                                  per-row contribution to the final score
//
// `borrower_risk_scores` (E-026) is the network-wide nightly cache; this pair
// is the audit trail behind the *explainability* surface. They co-exist by
// design — borrower_risk_scores is read-optimised; the snapshots are write-
// once, append-only.
// =============================================================================
export const nbfcScoreRuns = pgTable(
  "nbfc_score_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    loan_application_id: varchar("loan_application_id", { length: 255 }).notNull(),
    score_type: varchar("score_type", { length: 8 }).notNull(),
    score_value: numeric("score_value", { precision: 6, scale: 2 }).notNull(),
    computed_at: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    confidence_level: varchar("confidence_level", { length: 8 }).notNull(),
    confidence_reasons: jsonb("confidence_reasons"),
  },
  (table) => ({
    loanIdx: index("nbfc_score_runs_loan_idx").on(table.loan_application_id),
    loanTypeIdx: index("nbfc_score_runs_loan_type_idx").on(
      table.loan_application_id,
      table.score_type,
    ),
    computedAtIdx: index("nbfc_score_runs_computed_at_idx").on(table.computed_at),
  }),
);

export const nbfcScoreInputSnapshots = pgTable(
  "nbfc_score_input_snapshots",
  {
    id: uuid().primaryKey().defaultRandom(),
    score_run_id: uuid("score_run_id").notNull(),
    row_index: integer("row_index").notNull(),
    due_date: timestamp("due_date", { withTimezone: true }),
    amount: numeric("amount", { precision: 12, scale: 2 }),
    status: varchar({ length: 24 }),
    days_late: integer("days_late"),
    contribution: numeric("contribution", { precision: 6, scale: 2 }),
  },
  (table) => ({
    runIdx: index("nbfc_score_input_snapshots_run_idx").on(table.score_run_id),
    runRowIdx: index("nbfc_score_input_snapshots_run_row_idx").on(
      table.score_run_id,
      table.row_index,
    ),
  }),
);

// E-090 — DPDPA 2023 consent record persistence + withdrawal.
// `consent_records` (line 1326) lacks DPDPA scope-level state, so we add:
//   * nbfc_consent_scopes — toggleable per-purpose scope flags
//     (loan_processing / risk_assessment / warranty_management) keyed by
//     consent_id, with a deactivated_at timestamp for partial withdrawal.
//   * nbfc_consent_withdrawals — append-only record of every withdrawal,
//     including the channel it came in through (grievance_portal / helpline /
//     email) and an optional free-text reason. The original consent_records
//     row is never deleted: DPDPA forbids retroactive erasure of past data
//     and existing loan obligations remain in force.
export const nbfcConsentScopes = pgTable(
  "nbfc_consent_scopes",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    consent_id: varchar("consent_id", { length: 255 }).notNull(),
    scope_key: varchar("scope_key", { length: 64 }).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    deactivated_at: timestamp("deactivated_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    consentIdx: index("nbfc_consent_scopes_consent_idx").on(table.consent_id),
    consentScopeUniq: uniqueIndex("nbfc_consent_scopes_consent_scope_uniq").on(
      table.consent_id,
      table.scope_key,
    ),
  }),
);

export const nbfcConsentWithdrawals = pgTable(
  "nbfc_consent_withdrawals",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    lead_id: varchar("lead_id", { length: 255 }).notNull(),
    consent_id: varchar("consent_id", { length: 255 }).notNull(),
    withdrawal_channel: varchar("withdrawal_channel", { length: 32 }).notNull(),
    reason: text("reason"),
    withdrawn_at: timestamp("withdrawn_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    leadIdx: index("nbfc_consent_withdrawals_lead_idx").on(table.lead_id),
    consentIdx: index("nbfc_consent_withdrawals_consent_idx").on(
      table.consent_id,
    ),
  }),
);

// =============================================================================
// E-093 — NBFC score override (BRD 6.4.5)
// NBFC Risk Manager may override a borrower's computed credit score with a
// documented reason. The override is logged to audit_logs but does NOT mutate
// the computed value in nbfc_score_runs / borrower_risk_scores. Append-only:
// when a new override is created for the same (loan_application_id, score_type)
// pair, the prior active row is flipped to is_active=false (superseded) and
// the new row becomes is_active=true. RBI Digital Lending Directions 2025
// require that human overrides of credit scores are documented with a reason
// and visible in the audit log.
// =============================================================================
export const nbfcScoreOverrides = pgTable(
  "nbfc_score_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loan_application_id: varchar("loan_application_id", {
      length: 255,
    }).notNull(),
    score_type: varchar("score_type", { length: 8 }).notNull(),
    computed_score_value: numeric("computed_score_value", {
      precision: 6,
      scale: 2,
    }).notNull(),
    override_value: numeric("override_value", {
      precision: 6,
      scale: 2,
    }).notNull(),
    reason: text("reason").notNull(),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => ({
    loanScoreIdx: index("nbfc_score_overrides_loan_score_idx").on(
      table.loan_application_id,
      table.score_type,
    ),
    activeIdx: index("nbfc_score_overrides_active_idx").on(
      table.loan_application_id,
      table.score_type,
      table.is_active,
    ),
    createdAtIdx: index("nbfc_score_overrides_created_at_idx").on(
      table.created_at,
    ),
  }),
);

// =============================================================================
// E-066 — Auto Anomaly Flag on NBFC record (BRD §6.3.2)
// Persists which NBFC tenants have had auto-anomaly flags raised by the
// evaluator (delinquency_pct > 15, recovery_rate_pct < 70, avg_dpd > 30 — 2/3
// breaches => red, 1/3 => amber). Rows are upserted by (nbfc_id) so the
// open-flag state lives across metric refreshes; `cleared_at` is stamped when
// the NBFC's metrics return to within thresholds. Reasons array is jsonb so
// the Ops dashboard can render the breach checklist verbatim.
// =============================================================================
export const nbfcAnomalyFlags = pgTable(
  "nbfc_anomaly_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nbfc_id: uuid("nbfc_id")
      .notNull()
      .references(() => nbfcTenants.id),
    severity: varchar("severity", { length: 10 }).notNull(),
    reasons: jsonb("reasons").notNull(),
    flagged_at: timestamp("flagged_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    cleared_at: timestamp("cleared_at", { withTimezone: true }),
  },
  (table) => ({
    // One open flag row per NBFC: queries always read the latest by flagged_at,
    // and the evaluator upserts based on (nbfc_id, cleared_at IS NULL) — but
    // since SQL unique can't easily express that, we keep a simple nbfc_id
    // index and let the evaluator manage open-row uniqueness in code.
    nbfcIdx: index("nbfc_anomaly_flags_nbfc_idx").on(table.nbfc_id),
    severityIdx: index("nbfc_anomaly_flags_severity_idx").on(table.severity),
    flaggedAtIdx: index("nbfc_anomaly_flags_flagged_at_idx").on(
      table.flagged_at,
    ),
    clearedAtIdx: index("nbfc_anomaly_flags_cleared_at_idx").on(
      table.cleared_at,
    ),
  }),
);

// =============================================================================
// [E-102] Canonical dealers table — first-time definition (closes Sync Audit
// G-04 + G-08). The integer `id` is the FK target for inventory.dealer_id,
// leads.dealer_id, coupons.dealer_id, coupon_batches.dealer_id, etc.
// (those FK migrations are out of scope for this unit). The human-readable
// VARCHAR(50) `dealer_id` (DLR-NNN) is generated only when onboarding_status
// transitions to 'active' and is what surfaces in APIs / UI / S3 paths.
// dealer_onboarding_applications stays the in-flight application record;
// dealers is the post-activation canonical entity. The 16 fuzzy column
// collisions reported by the auditor (company_name, gst_number, owner_*,
// bank_*, etc. against dealer_onboarding_applications and personal_details)
// are intentional per BRD Resolution D and approved in audit_E-102.
// =============================================================================
export const dealers = pgTable(
  "dealers",
  {
    id: serial("id").primaryKey(),
    // Human-readable dealer code (DLR-001). NULL pre-activation, populated
    // and uniqued at activation. Never used as a FK target in other tables.
    dealer_id: varchar("dealer_id", { length: 50 }).unique(),
    company_name: varchar("company_name", { length: 200 }).notNull(),
    company_type: varchar("company_type", { length: 32 }).notNull(),
    // E-202 — dealer business type ('new' | 'scrap' | 'both'), copied from the
    // onboarding application at approval. Distinct from company_type (legal).
    dealer_type: varchar("dealer_type", { length: 16 }),
    gst_number: varchar("gst_number", { length: 20 }),
    pan_number: varchar("pan_number", { length: 20 }),
    registered_address: jsonb("registered_address"),
    bank_name: varchar("bank_name", { length: 200 }),
    // DPDPA — financial PII; column-level encryption applied at the service
    // layer before insert (see lib/dealers/encryption.ts when added).
    bank_account_number: varchar("bank_account_number", { length: 200 }),
    bank_ifsc: varchar("bank_ifsc", { length: 20 }),
    bank_beneficiary: varchar("bank_beneficiary", { length: 200 }),
    bank_branch: varchar("bank_branch", { length: 200 }),
    bank_account_type: varchar("bank_account_type", { length: 16 }),
    owner_name: varchar("owner_name", { length: 200 }),
    owner_phone: varchar("owner_phone", { length: 20 }),
    // Used as dealer login user id on activation.
    owner_email: varchar("owner_email", { length: 200 }),
    finance_enabled: boolean("finance_enabled").default(false).notNull(),
    onboarding_status: varchar("onboarding_status", { length: 32 })
      .default("draft")
      .notNull(),
    // Links to dealer_onboarding_applications.id (the in-flight application
    // record from the V2-Feb-2 onboarding flow). Stored as varchar to mirror
    // BRD Section D.1 and to avoid a hard FK while consumer-table FK
    // migrations are still pending.
    application_id: varchar("application_id", { length: 50 }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Set when onboarding_status transitions to 'active'.
    activated_at: timestamp("activated_at", { withTimezone: true }),
  },
  (table) => ({
    onboardingStatusIdx: index("dealers_onboarding_status_idx").on(
      table.onboarding_status,
    ),
    applicationIdIdx: index("dealers_application_id_idx").on(
      table.application_id,
    ),
  }),
);

// =============================================================================
// E-012 — dealer_nbfc_assignments (Sync Audit G-05)
// Junction table that links finance-enabled dealers to their approved NBFCs.
// Only NBFCs present here appear in a given dealer's loan-sanction dropdown
// (consumed by E-013). UNIQUE (dealer_id, nbfc_id) prevents duplicate
// assignments; the API surfaces 409 on duplicate insert. Status transitions:
// active <-> suspended; either state may move to terminated (terminal).
// =============================================================================
export const dealerNbfcAssignments = pgTable(
  "dealer_nbfc_assignments",
  {
    id: serial("id").primaryKey(),
    // FK target is dealers.id (INT). Hard FK to dealers omitted to mirror the
    // rest of the dealer-consumer fanout migration which is staged separately
    // (G-04 follow-up); enforced at the application layer instead.
    dealer_id: integer("dealer_id").notNull(),
    nbfc_id: integer("nbfc_id")
      .notNull()
      .references(() => nbfc.id),
    enabled_at: timestamp("enabled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Admin user surrogate id that created the assignment. BRD spec defines
    // this column as INTEGER FK admin_user_id; we keep it INTEGER and resolve
    // from users.numeric_id at the route layer (set to 0 in test bypass).
    enabled_by: integer("enabled_by").notNull(),
    // active | suspended | terminated
    status: varchar("status", { length: 16 }).default("active").notNull(),
    notes: text("notes"),
  },
  (table) => ({
    uniqDealerNbfc: uniqueIndex("dealer_nbfc_assignments_dealer_nbfc_uq").on(
      table.dealer_id,
      table.nbfc_id,
    ),
    dealerIdx: index("dealer_nbfc_assignments_dealer_idx").on(table.dealer_id),
    nbfcIdx: index("dealer_nbfc_assignments_nbfc_idx").on(table.nbfc_id),
  }),
);

// -----------------------------------------------------------------------------
// E-038 — Auction Marketplace Lots and Bidding (BRD §6.1.7)
// -----------------------------------------------------------------------------
// `auction_lots` is the catalogue of recovered-battery lots offered to NBFC
// tenants (bidders) on the auction marketplace. Each lot exposes the public
// pricing parameters (base_price, bid_increment), a binding deadline
// (ends_at), and a coarse status flag ("live" | "ended").
//
// `auction_bids` is the per-bid log for every binding bid placed against a
// lot. It is append-only — bids are immutable and form the audit-grade record
// for binding bid acceptance. Note: `tenant_id` here is the bidder's NBFC
// tenant (one tenant places many bids); the column is intentionally named
// `tenant_id` (not `bidder_tenant_id`) to align with the rest of the NBFC
// schema's tenant_id naming convention. The bidder vs. seller distinction is
// implicit: auction_lots has no tenant column (lots are platform-owned in this
// release; seller_tenant_id is deferred to E-039), so the only tenant_id on
// auction_bids is the bidder.
// -----------------------------------------------------------------------------

export const auctionLots = pgTable(
  "auction_lots",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_code: varchar("lot_code", { length: 32 }).notNull().unique(),
    capacity: varchar("capacity", { length: 32 }),
    avg_soh: numeric("avg_soh", { precision: 5, scale: 2 }),
    age_months: integer("age_months"),
    quantity: integer("quantity").notNull(),
    base_price: numeric("base_price", { precision: 12, scale: 2 }).notNull(),
    bid_increment: numeric("bid_increment", {
      precision: 12,
      scale: 2,
    }).notNull(),
    ends_at: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("live"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // [E-232] Lot composition, scheduling and the seller identity.
    // status now spans draft | scheduled | live | paused | ended | cancelled;
    // the DEFAULT stays 'live' in SQL on purpose (changing it would silently
    // alter every INSERT that omits the column) and the draft default is
    // applied in src/lib/nbfc/auction/composeLot.ts instead.
    seller_tenant_id: uuid("seller_tenant_id"),
    auction_type: varchar("auction_type", { length: 24 })
      .notNull()
      .default("cash"),
    starts_at: timestamp("starts_at", { withTimezone: true }),
    anti_snipe_seconds: integer("anti_snipe_seconds").notNull().default(120),
    reserve_price: numeric("reserve_price", { precision: 12, scale: 2 }),
    title: varchar("title", { length: 160 }),
    published_at: timestamp("published_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("auction_lots_status_idx").on(table.status),
    endsAtIdx: index("auction_lots_ends_at_idx").on(table.ends_at),
    sellerTenantIdx: index("auction_lots_seller_tenant_idx").on(
      table.seller_tenant_id,
    ),
  }),
);

export const auctionBids = pgTable(
  "auction_bids",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_id: uuid("lot_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    placed_at: timestamp("placed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // [E-232] The bidder re-point (BRD §9 — dealers only, never other NBFCs).
    // Added ALONGSIDE tenant_id, not instead of it. On a dealer bid BOTH are
    // populated: bidder_dealer_id is the dealer account, and tenant_id carries
    // the SELLER's tenant so the nbfc_audit_log row lands in the right log and
    // every existing tenant-scoped query on this table stays meaningful.
    // bidder_kind says which one is authoritative, so nothing infers it from
    // NULLness.
    // varchar(255), NOT uuid — `accounts.id` holds application-issued strings
    // like 'ACC-ITARANG-20260409-971', and so does `users.dealer_id`.
    bidder_dealer_id: varchar("bidder_dealer_id", { length: 255 }),
    bidder_kind: varchar("bidder_kind", { length: 16 })
      .notNull()
      .default("nbfc"),
  },
  (table) => ({
    lotIdx: index("auction_bids_lot_idx").on(table.lot_id),
    tenantIdx: index("auction_bids_tenant_idx").on(table.tenant_id),
    placedAtIdx: index("auction_bids_placed_at_idx").on(table.placed_at),
    bidderDealerIdx: index("auction_bids_bidder_dealer_idx").on(
      table.bidder_dealer_id,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-234 — multi-battery lots, visibility, and the frozen audience
// -----------------------------------------------------------------------------
// `auction_lot_items` is what makes "5 batteries, one lot" expressible;
// `auction_lots.quantity` was an integer that publishLotFromRecovery() hard-
// coded to 1. `condition` lives on the ITEM, not the lot, because a pallet may
// mix grades and a dealer who bid on "refurbished" and received
// "partial_working" has been mis-sold.
//
// It is also the real key that replaces two string joins on `lot_code` — in
// settlements.ts and in the cancel service — which matched zero rows every time
// because `lot_code` is "LOT-" + 8 hex of a pipeline uuid and is never equal to
// a battery serial or an inventory serial number.
//
// `auction_lot_audience` is resolved ONCE at publish and frozen. Re-evaluating
// on read would make the audience a moving target and "who did we tell?"
// unanswerable, which is the question a disputed auction turns on.
//
// The partial index `auction_lot_audience_pending_idx` lives only in the
// migration — drizzle cannot express a WHERE clause on an index.
// -----------------------------------------------------------------------------

export const auctionLotItems = pgTable(
  "auction_lot_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_id: uuid("lot_id").notNull(),
    battery_id: uuid("battery_id").notNull(),
    condition: varchar("condition", { length: 24 }).notNull().default("refurbished"),
    item_price: numeric("item_price", { precision: 12, scale: 2 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    lotIdx: index("auction_lot_items_lot_idx").on(table.lot_id),
    batteryIdx: index("auction_lot_items_battery_idx").on(table.battery_id),
    lotBatteryUniq: unique("auction_lot_items_lot_battery_key").on(
      table.lot_id,
      table.battery_id,
    ),
  }),
);

export const auctionLotVisibility = pgTable("auction_lot_visibility", {
  lot_id: uuid("lot_id").primaryKey().notNull(),
  scope: varchar("scope", { length: 16 }).notNull().default("india"),
  states: text("states").array().notNull().default(sql`'{}'::text[]`),
  cities: text("cities").array().notNull().default(sql`'{}'::text[]`),
  centre_lat: numeric("centre_lat", { precision: 10, scale: 7 }),
  centre_lng: numeric("centre_lng", { precision: 10, scale: 7 }),
  radius_km: integer("radius_km"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auctionLotAudience = pgTable(
  "auction_lot_audience",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_id: uuid("lot_id").notNull(),
    // accounts.id — character varying, NOT uuid.
    dealer_id: varchar("dealer_id", { length: 255 }).notNull(),
    dealer_name: varchar("dealer_name", { length: 255 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),
    distance_km: numeric("distance_km", { precision: 8, scale: 2 }),
    channel: varchar("channel", { length: 16 }).notNull().default("in_app"),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    lotIdx: index("auction_lot_audience_lot_idx").on(table.lot_id),
    dealerIdx: index("auction_lot_audience_dealer_idx").on(table.dealer_id),
    lotDealerChannelUniq: unique("auction_lot_audience_lot_dealer_channel_key").on(
      table.lot_id,
      table.dealer_id,
      table.channel,
    ),
  }),
);

// =============================================================================
// [E-047] Telemetry storage — Section 6.2.4
// =============================================================================
// Two new tables that own the canonical telemetry storage layer:
//
//   telemetry_events           — Raw per-packet time-series store. High-volume,
//                                insert-only. Intended for monthly partitioning
//                                in production; the BRD explicitly omits the
//                                FK on serial_number for write throughput.
//   telemetry_daily_summary    — One row per (battery, day) aggregated for risk
//                                scoring. Upsert key is (serial_number,
//                                summary_date) — enforced as a unique
//                                constraint so concurrent ingest jobs cannot
//                                duplicate a day's roll-up.
//
// Schema-only unit; no API surface. Ingestion (E-046), summary upsert
// (E-048), and risk-scoring reads (E-050/E-051) are downstream units that
// depend on this table existing. Auto-approved via /nbfc loop --auto-approve-schema.
//
// Fuzzy-collision dispositions from _audit_E-047.json:
//   - serial_number on both tables is an intentional logical FK to
//     inventory.serial_number; left un-FK'd at DB level (BRD 6.2.4 — write
//     throughput) and same-named on purpose.
//   - telemetry_events.soc_percent and telemetry_events.voltage_v reuse the
//     names of inventory.soc_percent (last-known SOC) and products.voltage_v
//     (nominal voltage) — distinct semantics (per-packet readings vs.
//     last-known / nominal), kept identical for column-name clarity.
// =============================================================================
export const telemetryEvents = pgTable(
  "telemetry_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    serial_number: varchar("serial_number", { length: 50 }).notNull(),
    imei_id: varchar("imei_id", { length: 20 }).notNull(),
    // Device-reported UTC.
    device_time: timestamp("device_time", { withTimezone: true }).notNull(),
    // Server receipt time.
    server_time: timestamp("server_time", { withTimezone: true })
      .defaultNow()
      .notNull(),
    soc_percent: integer("soc_percent"),
    soh_percent: integer("soh_percent"),
    voltage_v: numeric("voltage_v", { precision: 6, scale: 2 }),
    // Positive = charging.
    current_a: numeric("current_a", { precision: 7, scale: 2 }),
    temperature_c: numeric("temperature_c", { precision: 5, scale: 2 }),
    charge_cycles: integer("charge_cycles"),
    gps_lat: numeric("gps_lat", { precision: 10, scale: 7 }),
    gps_lng: numeric("gps_lng", { precision: 10, scale: 7 }),
    daily_km: numeric("daily_km", { precision: 8, scale: 2 }),
    idle_hours: numeric("idle_hours", { precision: 6, scale: 2 }),
    bms_status: varchar("bms_status", { length: 50 }),
    charger_connected: boolean("charger_connected"),
  },
  (table) => ({
    // Primary read pattern — most-recent packets for a given battery.
    serialDeviceTimeIdx: index("telemetry_events_serial_device_time_idx").on(
      table.serial_number,
      table.device_time,
    ),
    // Used by the daily-summary upsert job (E-048) to scan a day's packets
    // for one battery.
    serialServerTimeIdx: index("telemetry_events_serial_server_time_idx").on(
      table.serial_number,
      table.server_time,
    ),
  }),
);

export const telemetryDailySummary = pgTable(
  "telemetry_daily_summary",
  {
    id: serial("id").primaryKey(),
    serial_number: varchar("serial_number", { length: 50 }).notNull(),
    // One row per battery per day.
    summary_date: date("summary_date").notNull(),
    avg_soc: numeric("avg_soc", { precision: 5, scale: 2 }),
    min_soc: numeric("min_soc", { precision: 5, scale: 2 }),
    max_soh: numeric("max_soh", { precision: 5, scale: 2 }),
    total_km: numeric("total_km", { precision: 8, scale: 2 }),
    total_idle_hours: numeric("total_idle_hours", { precision: 6, scale: 2 }),
    // Number of charge events.
    charge_sessions: integer("charge_sessions").default(0),
    // Count of fault/warning bms_status events.
    bms_faults: integer("bms_faults").default(0).notNull(),
    // Data quality metric.
    packets_received: integer("packets_received").default(0).notNull(),
    // Most common GPS cluster for this day.
    gps_home_lat: numeric("gps_home_lat", { precision: 10, scale: 7 }),
    gps_home_lng: numeric("gps_home_lng", { precision: 10, scale: 7 }),
  },
  (table) => ({
    // BRD AC2 — exactly one row per battery per day. Concurrent ingest
    // jobs MUST collide on this constraint and fall back to upsert.
    serialDateUnique: uniqueIndex("telemetry_daily_summary_serial_date_uniq").on(
      table.serial_number,
      table.summary_date,
    ),
    // Range-by-day reads for the risk dashboard (E-050).
    dateIdx: index("telemetry_daily_summary_date_idx").on(table.summary_date),
  }),
);

// =============================================================================
// [E-049] Telemetry alert rules — Section 6.2.6
// =============================================================================
// Persistent ledger for the eight rule-based alerts triggered by the
// per-packet evaluator (BMS Fault, High Temperature, Low SOC, Usage Drop,
// Geo-Shift, SOH Decline) and the offline-scan cron (Battery Offline,
// Battery Offline Extended).
//
// Reuse-vs-new rationale (per _audit_E-049.json — auto-approved):
//   - battery_alerts already exists (line 2086) with shape (id, device_id,
//     alert_type, severity, message, value, threshold, acknowledged*) — that
//     table is owned by an earlier ad-hoc battery-monitor flow and uses a
//     varchar(255) primary key plus an `alert_type`+`message` pair. The BRD
//     6.2.6 model is rule-based with a fixed enum of `rule` names, an
//     open/resolved lifecycle (`resolved_at`), a JSON `payload` and a JSON
//     `notified_to` fan-out audit, plus a `cds_flagged` flag for the >48h
//     escalation. Reusing battery_alerts would require renaming columns and
//     widening the PK shape, which would break existing battery_alerts
//     readers. Therefore telemetry_alerts is kept as a separate table; the
//     `severity` and `resolved_at` name collisions are intentional —
//     conventional resolution-timestamp / severity columns shared across
//     alert tables.
//   - serial_number is a logical FK to inventory.serial_number, mirroring
//     the convention used in iot_devices, telemetry_events and
//     telemetry_daily_summary. Not enforced at the DB level for write
//     throughput (BRD 6.2.4).
//
// Dedup contract (BRD logic step 6): a single open alert per
// (serial_number, rule). Once resolved_at is non-null the row is closed and
// a new alert for the same rule may be opened. Enforced by a partial unique
// index on (serial_number, rule) WHERE resolved_at IS NULL.
// =============================================================================
export const telemetryAlerts = pgTable(
  "telemetry_alerts",
  {
    id: serial().primaryKey(),
    serial_number: varchar("serial_number", { length: 50 }).notNull(),
    // One of: 'BMS Fault' | 'High Temperature' | 'Low SOC' | 'Usage Drop' |
    // 'Geo-Shift' | 'SOH Decline' | 'Battery Offline' | 'Battery Offline Extended'.
    rule: varchar({ length: 50 }).notNull(),
    // 'critical' | 'warning' | 'info'.
    severity: varchar({ length: 20 }).notNull(),
    triggered_at: timestamp("triggered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    // Snapshot of evaluator inputs (e.g. {soc_percent: 8, charger_connected:
    // false, threshold: 10}). Lets the dashboard render the firing context
    // without round-tripping to telemetry_events.
    payload: jsonb(),
    // Array of audience ids notified, e.g.
    // [{audience: 'nbfc-dashboard', at: '...'}, {audience: 'admin-email', at: '...'}].
    notified_to: jsonb("notified_to"),
    // Set true on Battery Offline Extended (>48h). Read by E-050/CDS scoring.
    cds_flagged: boolean("cds_flagged").notNull().default(false),
  },
  (table) => ({
    // Dedup: only one open alert per (serial_number, rule).
    serialRuleOpenUnique: uniqueIndex("telemetry_alerts_serial_rule_open_uniq")
      .on(table.serial_number, table.rule)
      .where(sql`resolved_at IS NULL`),
    // Dashboard read pattern — list open alerts for a serial, newest first.
    serialTriggeredIdx: index("telemetry_alerts_serial_triggered_idx").on(
      table.serial_number,
      table.triggered_at,
    ),
    // Severity filter for the NBFC dashboard "Critical alerts" widget.
    severityIdx: index("telemetry_alerts_severity_idx").on(table.severity),
  }),
);

// -----------------------------------------------------------------------------
// E-030 — PCI nightly computation (Section 6.1.5)
// -----------------------------------------------------------------------------
// emi_schedules is already defined above (line ~3071) and reused here. This
// section adds nbfc_risk_alerts — the alert rows surfaced on the NBFC Risk
// Alerts UI. The PCI job inserts type='pci_low' rows when a borrower dips
// below 0.40; other E-units may insert their own types (cds_high, etc.).
// Tenant scoping enforced in application code (drizzle where-clauses).
// -----------------------------------------------------------------------------

export const nbfcRiskAlerts = pgTable(
  "nbfc_risk_alerts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id").notNull(),
    borrower_id: uuid("borrower_id").notNull(),
    // E-117 — widened uuid → varchar so an alert can be keyed to any
    // loan_sanctions.id (which is varchar, often non-uuid e.g. 'BAJAJ-LIVE-…').
    loan_sanction_id: varchar("loan_sanction_id", { length: 255 }).notNull(),
    type: varchar({ length: 32 }).notNull(), // 'pci_low' | 'cds_high' | ...
    severity: varchar({ length: 16 }).notNull(), // 'low' | 'medium' | 'high' | 'critical'
    payload: jsonb("payload"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    tenantIdx: index("nbfc_risk_alerts_tenant_idx").on(table.tenant_id),
    borrowerIdx: index("nbfc_risk_alerts_borrower_idx").on(table.borrower_id),
    loanSanctionIdx: index("nbfc_risk_alerts_loan_sanction_idx").on(
      table.loan_sanction_id,
    ),
    typeIdx: index("nbfc_risk_alerts_type_idx").on(table.type),
    createdAtIdx: index("nbfc_risk_alerts_created_at_idx").on(table.created_at),
  }),
);

// =============================================================================
// E-070 — Cancel Lot with MFA, dual approval, battery return-to-inventory
// (BRD §6.3.4)
// =============================================================================
// `nbfc_auction_cancel_requests` is the dual-approval ledger for the
// "Cancel Lot" admin action in the Auction Control Centre. Cancellation is
// the ONLY auction action that requires dual approval per BRD §6.3.4 — it
// removes a lot from the auction and returns the underlying battery to
// inventory.
//
// Lifecycle:
//   1. First admin POSTs /cancel/request with mfa_token + lot_id + reason.
//      We validate MFA, insert a row with status='pending_second_approval',
//      requested_by = first admin's uuid.
//   2. A *different* admin POSTs /cancel/approve with decision.
//      - decision='reject' → status='rejected'.
//      - decision='approve' → atomically:
//          a. lot.status='cancelled'
//          b. inventory rows whose serial_number == lot.lot_code (the
//             convention shared with E-039 recovery_pipeline.battery_serial)
//             flip to status='in_stock' (the canonical 'returned to
//             inventory' state in this codebase — `inventory.status` defaults
//             to 'in_stock', see line ~143).
//          c. request row → status='executed', approved_by, applied_at.
//          d. audit_logs row with action='AUCTION_LOT_CANCELLED' carrying
//             both approver IDs, lot_id, and the mandatory reason.
//
// Self-approval is rejected at the service layer (FORBIDDEN) — the second
// approver's uuid must differ from requested_by.
// -----------------------------------------------------------------------------

export const nbfcAuctionCancelRequests = pgTable(
  "nbfc_auction_cancel_requests",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_id: uuid("lot_id").notNull(),
    reason: text("reason").notNull(),
    requested_by: uuid("requested_by").notNull(),
    approved_by: uuid("approved_by"),
    status: varchar({ length: 32 }).notNull(),
    requested_at: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    applied_at: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => ({
    // Approval-queue read pattern — list pending requests, newest first.
    statusIdx: index("nbfc_auction_cancel_requests_status_idx").on(
      table.status,
    ),
    lotIdx: index("nbfc_auction_cancel_requests_lot_idx").on(table.lot_id),
    requestedByIdx: index("nbfc_auction_cancel_requests_requested_by_idx").on(
      table.requested_by,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-069 — Auction Control Centre admin actions audit trail (BRD §6.3.4)
// -----------------------------------------------------------------------------
// `nbfc_auction_lot_actions` is the per-lot audit log for every admin control
// action issued from the Auction Control Centre. The five action codes
// supported by the BRD are:
//   - extend_time            (Extend Time +15m / +30m / +1h)
//   - reduce_time            (Reduce Time -15m / End Now)
//   - pause                  (Pause Auction; freeze countdown)
//   - reserve_price_set      (Set Reserve Price; pre-bid only)
//   - approve_winning_bid    (Post-auction; trigger payment flow)
//
// Per-action parameters and pre/post snapshots live in jsonb columns so we do
// not need a column per action variant. `previous_value` and `new_value`
// capture the field that changed (e.g. ends_at for extend_time, status for
// pause, reserve_price for reserve_price_set). `reason` is a free-text field
// surfaced by the UI; some actions (extend_time) require it, others
// (approve_winning_bid) do not.
//
// This table is platform-global — auction lots themselves have no tenant_id
// (lots are platform-owned in this release; same convention as
// nbfc_auction_cancel_requests / E-070). The acting admin is recorded in
// `acted_by` (uuid). Distinct from `audit_logs` (which spans the whole CRM):
// this table is the queryable, lot-scoped index the Auction Control Centre
// reads to render the per-lot history strip without scanning audit_logs.
// -----------------------------------------------------------------------------

export const nbfcAuctionLotActions = pgTable(
  "nbfc_auction_lot_actions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_id: uuid("lot_id").notNull(),
    action_code: varchar("action_code", { length: 48 }).notNull(),
    previous_value: jsonb("previous_value"),
    new_value: jsonb("new_value"),
    reason: text("reason"),
    acted_by: uuid("acted_by").notNull(),
    acted_at: timestamp("acted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Per-lot history-strip read pattern — list actions on a lot, newest first.
    lotActedAtIdx: index("nbfc_auction_lot_actions_lot_acted_at_idx").on(
      table.lot_id,
      table.acted_at,
    ),
    actionCodeIdx: index("nbfc_auction_lot_actions_action_code_idx").on(
      table.action_code,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-039 — Post-auction Settlement Table (BRD §6.1.7)
// -----------------------------------------------------------------------------
// `auction_settlements` is the per-lot settlement record created when an
// auction lot ends. It captures the winner tenant, the seller tenant (the
// platform tenant that owned the underlying recovery batch), the binding
// final price, and the fulfilment status moving through:
//   payment_pending → in_transit → delivered.
//
// Naming: `seller_tenant_id` and `winner_tenant_id` are intentionally
// role-prefixed because a single settlement row references TWO different
// nbfc_tenants in DIFFERENT roles (seller vs. winning bidder) — the unprefixed
// `tenant_id` convention used elsewhere in the schema cannot disambiguate two
// such columns on the same row. This is the same pattern this codebase will
// reach for whenever a row genuinely has multiple tenant references.
//
// Restored after merge regression (one-time recovery patch); originally added
// by E-039.
// -----------------------------------------------------------------------------

export const auctionSettlements = pgTable(
  "auction_settlements",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_id: uuid("lot_id").notNull().unique(),
    seller_tenant_id: uuid("seller_tenant_id").notNull(),
    winner_tenant_id: uuid("winner_tenant_id").notNull(),
    final_price: numeric("final_price", { precision: 12, scale: 2 }).notNull(),
    status: varchar("status", { length: 24 })
      .notNull()
      .default("payment_pending"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // [E-232] accounts.id of the winning DEALER, mirroring
    // auction_bids.bidder_dealer_id. winner_tenant_id stays NOT NULL and
    // carries the seller's tenant on a dealer win.
    winner_dealer_id: varchar("winner_dealer_id", { length: 255 }),

    // [E-252] The money. Until these landed, the three-state ladder above
    // recorded no evidence that payment had happened — `in_transit` was a
    // manual flip by the seller. `paid_at` is now the gate on that transition.
    //
    // `refinance_loan_id` is varchar, not uuid, because `loan_sanctions.id` is
    // character varying. E-232 had to ship a correction block for exactly this
    // mistake on `winner_dealer_id`.
    payment_ref: varchar("payment_ref", { length: 120 }),
    payment_provider: varchar("payment_provider", { length: 24 }),
    paid_at: timestamp("paid_at", { withTimezone: true }),
    refinance_loan_id: varchar("refinance_loan_id", { length: 255 }),
    failure_reason: text("failure_reason"),
  },
  (table) => ({
    lotIdx: index("auction_settlements_lot_idx").on(table.lot_id),
    paymentRefIdx: index("auction_settlements_payment_ref_idx").on(
      table.payment_ref,
    ),
    refinanceLoanIdx: index("auction_settlements_refinance_loan_idx").on(
      table.refinance_loan_id,
    ),
    sellerTenantIdx: index("auction_settlements_seller_tenant_idx").on(
      table.seller_tenant_id,
    ),
    winnerDealerIdx: index("auction_settlements_winner_dealer_idx").on(
      table.winner_dealer_id,
    ),
    winnerTenantIdx: index("auction_settlements_winner_tenant_idx").on(
      table.winner_tenant_id,
    ),
    statusIdx: index("auction_settlements_status_idx").on(table.status),
  }),
);

// E-093 — auction_auto_bids (BRD §6.1.7 Auto-Bid).
// Persists the bidder's standing-order maximum for a lot. Only one row per
// (lot_id, tenant_id) may be 'active' (enforced by a partial-unique index in
// the migration); cancelled rows remain for audit.
export const auctionAutoBids = pgTable(
  "auction_auto_bids",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    lot_id: uuid("lot_id").notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    // [E-234] Required after the E-232 re-point: a dealer bid writes the
    // SELLER's tenant into auction_bids.tenant_id, so every dealer bidding on
    // one lot shares a tenant_id and it can no longer identify a bidder.
    // Without this the proxy engine cannot tell whose standing order is whose,
    // and E-093's (lot_id, tenant_id) unique index would let the second dealer
    // to set a maximum silently cancel the first one's.
    bidder_dealer_id: varchar("bidder_dealer_id", { length: 255 }),
    max_amount: numeric("max_amount", { precision: 12, scale: 2 }).notNull(),
    status: varchar({ length: 16 }).notNull().default("active"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    lotIdx: index("auction_auto_bids_lot_idx").on(table.lot_id),
    tenantIdx: index("auction_auto_bids_tenant_idx").on(table.tenant_id),
  }),
);

// =============================================================================
// E-118 — nbfc_buyback_requests (BRD §6.1.7 Recovery & Auction)
// Customer-initiated battery buyback requests surfaced on the NBFC Recovery &
// Auction page. Source of truth is the migration drizzle/E-118_*.sql.
// =============================================================================
export const nbfcBuybackRequests = pgTable(
  "nbfc_buyback_requests",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    customer_name: varchar("customer_name", { length: 160 }).notNull(),
    battery_serial: varchar("battery_serial", { length: 64 }).notNull(),
    soh_percent: numeric("soh_percent", { precision: 5, scale: 2 }),
    requested_at: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // 'pending' | 'in_review' | 'completed'
    evaluation_status: varchar("evaluation_status", { length: 24 })
      .notNull()
      .default("pending"),
    offer_amount: numeric("offer_amount", { precision: 12, scale: 2 }),
    // 'pending_evaluation' | 'offer_made' | 'accepted' | 'rejected'
    status: varchar({ length: 24 }).notNull().default("pending_evaluation"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_buyback_requests_tenant_idx").on(table.tenant_id),
    statusIdx: index("nbfc_buyback_requests_status_idx").on(table.status),
  }),
);

// =============================================================================
// NBFC entity KYC verifications (CIN, PAN, GSTIN)
// Sanchit (CEO) runs these from /admin/nbfc/[id]/kyc-review before the final
// approval gate releases. The gate (E-001) requires at least one row with
// status='success' for each of (cin, pan, gstin). Provider raw payload is
// retained verbatim for the RBI audit trail.
// =============================================================================
export const nbfcEntityKycVerifications = pgTable(
  "nbfc_entity_kyc_verifications",
  {
    id: serial("id").primaryKey(),
    nbfc_id: integer("nbfc_id")
      .notNull()
      .references(() => nbfc.id),
    verification_type: varchar("verification_type", { length: 16 }).notNull(),
    id_number: varchar("id_number", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    provider_reference_id: varchar("provider_reference_id", { length: 64 }),
    raw_response: jsonb("raw_response"),
    verified_by: uuid("verified_by"),
    verified_at: timestamp("verified_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    nbfcIdx: index("nbfc_entity_kyc_verifications_nbfc_id_idx").on(
      table.nbfc_id,
    ),
    typeIdx: index("nbfc_entity_kyc_verifications_type_idx").on(
      table.verification_type,
    ),
  }),
);

// =============================================================================
// NBFC directors — one row per NBFC, seeded from primary_contact_* at create
// time. Holds the subject of the director-side KYC (PAN / Aadhaar / RC). This
// is intentionally a 1:1 with `nbfc` for now; the table key still indexes by
// nbfc_id so multi-director support can land later without a migration.
// =============================================================================
export const nbfcDirectors = pgTable(
  "nbfc_directors",
  {
    id: serial("id").primaryKey(),
    nbfc_id: integer("nbfc_id")
      .notNull()
      .references(() => nbfc.id),
    full_name: varchar("full_name", { length: 200 }).notNull(),
    email: varchar("email", { length: 200 }),
    phone: varchar("phone", { length: 20 }),
    pan_number: varchar("pan_number", { length: 20 }),
    aadhaar_last4: varchar("aadhaar_last4", { length: 4 }),
    rc_number: varchar("rc_number", { length: 30 }),
    kyc_status: varchar("kyc_status", { length: 16 })
      .default("pending")
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    nbfcIdx: index("nbfc_directors_nbfc_id_idx").on(table.nbfc_id),
  }),
);

// =============================================================================
// NBFC director KYC verifications (PAN, Aadhaar, RC). Mirrors the entity table
// but keys off director_id. Verification type is one of: pan | aadhaar | rc.
// =============================================================================
export const nbfcDirectorKycVerifications = pgTable(
  "nbfc_director_kyc_verifications",
  {
    id: serial("id").primaryKey(),
    director_id: integer("director_id")
      .notNull()
      .references(() => nbfcDirectors.id),
    verification_type: varchar("verification_type", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    provider_reference_id: varchar("provider_reference_id", { length: 64 }),
    raw_response: jsonb("raw_response"),
    verified_by: uuid("verified_by"),
    verified_at: timestamp("verified_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    directorIdx: index("nbfc_director_kyc_verifications_director_idx").on(
      table.director_id,
    ),
    typeIdx: index("nbfc_director_kyc_verifications_type_idx").on(
      table.verification_type,
    ),
  }),
);

// --- ADMIN INVENTORY UPLOAD AUDIT (Step 4 upstream feeder) ---

export const inventoryUploadReports = pgTable(
  "inventory_upload_reports",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    dealer_id: varchar("dealer_id", { length: 255 }).notNull(),
    asset_type: varchar("asset_type", { length: 30 }).notNull(),
    inventory_type: varchar("inventory_type", { length: 30 }),
    upload_method: varchar("upload_method", { length: 20 }),
    uploaded_by: uuid("uploaded_by").notNull(),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    total_rows: integer("total_rows").default(0).notNull(),
    inserted_rows: integer("inserted_rows").default(0).notNull(),
    skipped_rows: integer("skipped_rows").default(0).notNull(),
    rows_imported: integer("rows_imported").default(0).notNull(),
    rows_skipped: integer("rows_skipped").default(0).notNull(),
    errors_json: jsonb("errors_json"),
    inserted_inventory_ids: jsonb("inserted_inventory_ids"),
    file_url: text("file_url"),
    report_url: text("report_url"),
    source: varchar({ length: 20 }).default('bulk').notNull(),
    notes: text(),
  },
  (table) => ({
    invUplDealerIdx: index("inventory_upload_reports_dealer_idx").on(
      table.dealer_id,
    ),
    invUplUploadedByIdx: index("inventory_upload_reports_uploaded_by_idx").on(
      table.uploaded_by,
    ),
    invUplUploadedAtIdx: index("inventory_upload_reports_uploaded_at_idx").on(
      table.uploaded_at,
    ),
  }),
);

// BRD V2 §5.4 — inter-dealer inventory transfers.
// One row per transfer event, regardless of how many serials it covers.
// `serials` is a jsonb array of inventory.serial_number values; `status`
// transitions: pending_acknowledgement → completed | cancelled.
//
//   pending_acknowledgement: source serials already flipped to
//     'transferred_out'; target dealer has been notified but hasn't yet
//     hit /acknowledge-transfer.
//   completed:               target dealer ack'd; serials now flipped to
//     'available' under the target dealer.
//   cancelled:               admin rolled the transfer back before ack —
//     serials returned to the source dealer in 'available'.
export const inventoryTransfers = pgTable(
  "inventory_transfers",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    source_dealer_id: varchar("source_dealer_id", { length: 255 }).notNull(),
    target_dealer_id: varchar("target_dealer_id", { length: 255 }).notNull(),
    serials: jsonb("serials").notNull(), // string[]
    reason: text(),
    initiated_by: uuid("initiated_by").notNull(),
    initiated_at: timestamp("initiated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    acknowledged_by: uuid("acknowledged_by"),
    acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
    cancelled_by: uuid("cancelled_by"),
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    cancellation_reason: text("cancellation_reason"),
    status: varchar({ length: 30 })
      .default("pending_acknowledgement")
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    invXferSourceIdx: index("inventory_transfers_source_idx").on(
      table.source_dealer_id,
    ),
    invXferTargetIdx: index("inventory_transfers_target_idx").on(
      table.target_dealer_id,
    ),
    invXferStatusIdx: index("inventory_transfers_status_idx").on(table.status),
  }),
);

// BRD strict audit stream for every inventory status mutation.
export const inventoryEvents = pgTable(
  "inventory_events",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    serial_number: varchar("serial_number", { length: 255 }).notNull(),
    inventory_id: varchar("inventory_id", { length: 255 }),
    event_type: varchar("event_type", { length: 40 }).notNull(),
    from_status: varchar("from_status", { length: 30 }),
    to_status: varchar("to_status", { length: 30 }),
    lead_id: varchar("lead_id", { length: 255 }),
    performed_by: uuid("performed_by"),
    performed_at: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),
    notes: text("notes"),
    metadata: jsonb("metadata"),
  },
  (table) => ({
    inventoryEventsSerialIdx: index("inventory_events_serial_idx").on(
      table.serial_number,
      table.performed_at,
    ),
    inventoryEventsTypeIdx: index("inventory_events_type_idx").on(table.event_type),
  }),
);

export const inventoryWriteOffs = pgTable(
  "inventory_write_offs",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    inventory_id: varchar("inventory_id", { length: 255 }).notNull(),
    serial_number: varchar("serial_number", { length: 255 }).notNull(),
    reason: varchar("reason", { length: 50 }).notNull(),
    reason_notes: text("reason_notes"),
    supporting_doc_url: text("supporting_doc_url"),
    write_off_value: numeric("write_off_value", { precision: 12, scale: 2 }).notNull(),
    requires_second_approval: boolean("requires_second_approval").default(false).notNull(),
    approval_status: varchar("approval_status", { length: 30 }).default("completed").notNull(),
    second_approved_by: uuid("second_approved_by"),
    second_approved_at: timestamp("second_approved_at", { withTimezone: true }),
    written_off_by: uuid("written_off_by").notNull(),
    written_off_at: timestamp("written_off_at", { withTimezone: true }).defaultNow().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    writeOffsInventoryIdx: index("inventory_write_offs_inventory_idx").on(
      table.inventory_id,
    ),
    writeOffsSerialIdx: index("inventory_write_offs_serial_idx").on(
      table.serial_number,
    ),
  }),
);

// Quantity-tracked paraphernalia stock ledger (separate from serialized rows).
export const paraphernaliaStock = pgTable(
  "paraphernalia_stock",
  {
    id: varchar({ length: 64 }).primaryKey().notNull(),
    dealer_id: varchar("dealer_id", { length: 255 }).notNull(),
    item_type: varchar("item_type", { length: 50 }).notNull(),
    item_label: varchar("item_label", { length: 100 }).notNull(),
    compatible_categories: jsonb("compatible_categories").default([]).notNull(),
    available_qty: integer("available_qty").default(0).notNull(),
    reserved_qty: integer("reserved_qty").default(0).notNull(),
    sold_qty: integer("sold_qty").default(0).notNull(),
    unit_cost: numeric("unit_cost", { precision: 10, scale: 2 }).default("0").notNull(),
    last_upload_at: timestamp("last_upload_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    paraStockDealerTypeUnique: unique("paraphernalia_stock_dealer_type_unique").on(
      table.dealer_id,
      table.item_type,
    ),
    paraStockDealerIdx: index("paraphernalia_stock_dealer_idx").on(table.dealer_id),
  }),
);

// --- E-105: Zoho Invoice mirror + universal expense submissions ---

export const zohoInvoices = pgTable(
  "zoho_invoices",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    zoho_invoice_id: varchar("zoho_invoice_id", { length: 64 }).notNull(),
    // E-171 — which Zoho organization (entity) this invoice belongs to. The
    // sync pulls from multiple orgs (Haryana + Delhi) into this one table.
    organization_id: varchar("organization_id", { length: 64 }),
    invoice_number: varchar("invoice_number", { length: 64 }),
    customer_id: varchar("customer_id", { length: 64 }),
    customer_name: text("customer_name"),
    invoice_date: date("invoice_date"),
    due_date: date("due_date"),
    currency_code: varchar("currency_code", { length: 8 }),
    total: numeric("total", { precision: 14, scale: 2 }),
    balance: numeric("balance", { precision: 14, scale: 2 }),
    status: varchar({ length: 32 }),
    // E-174 — latest applied payment's reference (UTR / bank txn id), id and
    // date, pulled from Zoho /customerpayments so the CEO can see the txn id
    // behind a paid invoice.
    payment_reference: text("payment_reference"),
    payment_id: varchar("payment_id", { length: 64 }),
    last_payment_date: date("last_payment_date"),
    raw_json: jsonb("raw_json"),
    synced_at: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    zohoInvoicesZohoIdUnique: uniqueIndex("zoho_invoices_zoho_id_unique").on(
      table.zoho_invoice_id,
    ),
    zohoInvoicesInvoiceDateIdx: index("zoho_invoices_invoice_date_idx").on(
      table.invoice_date,
    ),
    zohoInvoicesStatusIdx: index("zoho_invoices_status_idx").on(table.status),
    zohoInvoicesOrganizationIdIdx: index(
      "zoho_invoices_organization_id_idx",
    ).on(table.organization_id),
  }),
);

export const expenseSubmissions = pgTable(
  "expense_submissions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    submitted_by: uuid("submitted_by").notNull(),
    category: varchar({ length: 64 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    description: text(),
    bill_url: text("bill_url"),
    bill_storage_path: text("bill_storage_path"),
    status: varchar({ length: 16 }).default("pending").notNull(),
    approved_by: uuid("approved_by"),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    rejection_reason: text("rejection_reason"),
    // E-106 — AI invoice tracker fields
    department: varchar("department", { length: 32 }),
    project_tag: varchar("project_tag", { length: 80 }),
    vendor: varchar("vendor", { length: 160 }),
    expense_date: date("expense_date"),
    source: varchar("source", { length: 16 }).default("manual"),
    ai_raw: jsonb("ai_raw"),
    // E-172 — invoice number (dedup key for AI rows) + original upload filename.
    invoice_number: varchar("invoice_number", { length: 120 }),
    file_name: varchar("file_name", { length: 255 }),
    // E-216 — Google Drive provenance. `source` stays 'ai' for Drive rows (all
    // four existing consumers filter on it); drive_file_id is what tells a
    // scanned row apart from a hand-uploaded one.
    drive_file_id: varchar("drive_file_id", { length: 128 }),
    // Identity of one row inside a costing spreadsheet, since sheet rows carry
    // no invoice number. NULL for invoices.
    drive_row_ref: varchar("drive_row_ref", { length: 64 }),
    // Imported but not fully trusted. Still counts towards dashboard totals —
    // the flag routes the row to a human, it does not withhold it.
    needs_attention: boolean("needs_attention").default(false).notNull(),
    attention_reason: text("attention_reason"),
    // E-218 — coarse spend bucket (tech | rm | misc | others), the layer the
    // CEO reads at a glance above `department`. NULL until the backfill runs;
    // the dashboard renders those as "Unclassified". `bucket_source` records
    // who decided it — rule | ai | manual | default — so the backfill can
    // never overwrite a human correction.
    bucket: varchar("bucket", { length: 24 }),
    bucket_source: varchar("bucket_source", { length: 16 }),
    // WHY `amount` IS ALREADY INR. schema.ts once omitted these columns, and two
    // independent readings of this codebase concluded expense_submissions has no
    // currency column — therefore foreign-currency invoices are summed as rupees,
    // therefore tech-spend is ~94x understated for USD vendors. Not true: a
    // $1,533.85 invoice is stored as amount = INR 143,648.65, converted at entry.
    // `amount` is INR for EVERY row. Never apply an FX rate to it a second time;
    // doing so once turned a $200 Anthropic bill into INR 1.7 lakh.
    // E-217 — multi-currency. `amount` above is ALWAYS INR because every
    // report SUMs it; these record what the document actually said and the
    // arithmetic that connects the two.
    currency: varchar("currency", { length: 8 }),
    original_amount: numeric("original_amount", { precision: 14, scale: 2 }),
    fx_rate: numeric("fx_rate", { precision: 18, scale: 8 }),
    fx_rate_date: date("fx_rate_date"),
    fx_source: varchar("fx_source", { length: 16 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    expenseSubmissionsStatusIdx: index("expense_submissions_status_idx").on(
      table.status,
    ),
    expenseSubmissionsSubmittedByIdx: index(
      "expense_submissions_submitted_by_idx",
    ).on(table.submitted_by),
    expenseSubmissionsApprovedAtIdx: index(
      "expense_submissions_approved_at_idx",
    ).on(table.approved_at),
    expenseSubmissionsDepartmentIdx: index(
      "expense_submissions_department_idx",
    ).on(table.department),
    expenseSubmissionsDepartmentProjectIdx: index(
      "expense_submissions_department_project_idx",
    ).on(table.department, table.project_tag),
    // E-172 — case-insensitive lookup for invoice-number dedup. The partial
    // unique index (AI rows, non-blank number) lives in the migration only.
    expenseSubmissionsInvoiceNumberIdx: index(
      "expense_submissions_invoice_number_idx",
    ).on(sql`lower(${table.invoice_number})`),
    // E-216 — the three indexes below are declared here for drizzle's benefit,
    // but their partial predicates (WHERE drive_file_id IS NOT NULL / WHERE
    // needs_attention / WHERE status = 'approved') live in the migration only:
    // drizzle has no partial-index syntax. The migration is the source of truth.
    expenseSubmissionsDriveRowUnique: uniqueIndex(
      "expense_submissions_drive_row_unique",
    ).on(table.drive_file_id, table.drive_row_ref),
    expenseSubmissionsNeedsAttentionIdx: index(
      "expense_submissions_needs_attention_idx",
    ).on(table.created_at),
    // NOT an expression index on COALESCE(expense_date, approved_at::date):
    // timestamptz::date is STABLE, so Postgres rejects that with 42P17. The
    // readers split it into an OR over two plain columns instead — this index
    // serves the expense_date branch, E-105's approved_at index the other.
    expenseSubmissionsApprovedExpenseDateIdx: index(
      "expense_submissions_approved_expense_date_idx",
    ).on(table.expense_date),
    // E-218 — bucket rollups on the CEO dashboard. Both carry partial
    // predicates (WHERE status = 'approved' / WHERE bucket_source IS NOT NULL)
    // that live in the migration only; declared plain here for drizzle.
    expenseSubmissionsBucketDateIdx: index(
      "expense_submissions_bucket_date_idx",
    ).on(table.bucket, table.expense_date),
    expenseSubmissionsBucketSourceIdx: index(
      "expense_submissions_bucket_source_idx",
    ).on(table.bucket_source),
  }),
);

// -----------------------------------------------------------------------------
// E-217 — cached FX rates, keyed by date.
// -----------------------------------------------------------------------------
// One row per (base, quote, date), populated on demand from the ECB daily
// reference rates. Keyed by date rather than "latest" so a given invoice always
// converts to the same rupee figure — otherwise last month's expense total
// would drift every time it was recomputed.
// -----------------------------------------------------------------------------

export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    base_currency: varchar("base_currency", { length: 8 }).notNull(),
    quote_currency: varchar("quote_currency", { length: 8 }).default("INR").notNull(),
    // The date the rate APPLIES to — the date the provider returned, which for
    // a weekend invoice is the preceding business day.
    rate_date: date("rate_date").notNull(),
    rate: numeric("rate", { precision: 18, scale: 8 }).notNull(),
    // 'ecb' (fetched) | 'fallback' (configured default) | 'manual' (typed in)
    source: varchar("source", { length: 16 }).default("ecb").notNull(),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fxRatesPairDateUnique: uniqueIndex("fx_rates_pair_date_unique").on(
      table.base_currency,
      table.quote_currency,
      table.rate_date,
    ),
  }),
);

// -----------------------------------------------------------------------------
// E-216 — Google Drive → CEO Expenses ingestion
// -----------------------------------------------------------------------------
// A scheduled scanner reads configured Drive folders, extracts each invoice or
// costing sheet, and writes the result into `expense_submissions` above as an
// ordinary source='ai' row. These three tables hold the state that ingestion
// needs: which folders to read, what each run did, and what happened to every
// individual file. See drizzle/E-216_drive_expense_ingestion.sql for the full
// rationale, including why Drive rows keep source='ai' and how the three dedup
// layers stack.
// -----------------------------------------------------------------------------

export const driveExpenseFolders = pgTable(
  "drive_expense_folders",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    drive_folder_id: varchar("drive_folder_id", { length: 128 }).notNull(),
    label: varchar("label", { length: 160 }),
    is_active: boolean("is_active").default(true).notNull(),
    recursive: boolean("recursive").default(true).notNull(),
    // ALLOWLIST — only files at or below a folder matching one of these are
    // imported, scope inherited by descendants. Defaults to 'purchase': only
    // the purchase side of an accounts folder is an expense, and an allowlist
    // fails closed where a denylist would fail open.
    include_names: text("include_names").default("purchase").notNull(),
    // Denylist, applied even inside an allowlisted branch — catches a sales
    // folder misfiled under Purchase.
    exclude_names: text("exclude_names").default("sale").notNull(),
    last_scanned_at: timestamp("last_scanned_at", { withTimezone: true }),
    // Also the fallback submitted_by/approved_by for ticker runs, which have
    // no human actor.
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    driveExpenseFoldersFolderIdUnique: uniqueIndex(
      "drive_expense_folders_folder_id_unique",
    ).on(table.drive_folder_id),
    // Partial (WHERE is_active) in the migration only.
    driveExpenseFoldersActiveIdx: index("drive_expense_folders_active_idx").on(
      table.is_active,
    ),
  }),
);

export const driveScanRuns = pgTable(
  "drive_scan_runs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // NULL = scanned every active folder.
    folder_id: uuid("folder_id"),
    // NULL = triggered by the in-process ticker rather than a person.
    triggered_by: uuid("triggered_by"),
    // text + CHECK, not pgEnum — ALTER TYPE on a shared drifting DB is what the
    // migration conventions exist to avoid. 'running' | 'success' | 'failed'.
    status: text().default("running").notNull(),
    started_at: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    duration_ms: integer("duration_ms"),
    files_seen: integer("files_seen").default(0).notNull(),
    // Files that got past the md5 check and actually cost a download + a model
    // call. files_seen minus files_new is what the dedup saved.
    files_new: integer("files_new").default(0).notNull(),
    imported: integer("imported").default(0).notNull(),
    skipped_duplicate: integer("skipped_duplicate").default(0).notNull(),
    needs_attention: integer("needs_attention").default(0).notNull(),
    unsupported: integer("unsupported").default(0).notNull(),
    failed: integer("failed").default(0).notNull(),
    // Set only when the RUN died. A single failing file increments `failed`
    // and the run still completes.
    error_message: text("error_message"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Partial (WHERE status = 'running') in the migration only — this is the
    // concurrency guard's index.
    driveScanRunsRunningIdx: index("drive_scan_runs_running_idx").on(
      table.started_at,
    ),
    driveScanRunsStartedIdx: index("drive_scan_runs_started_idx").on(
      table.started_at,
    ),
  }),
);

export const driveExpenseFiles = pgTable(
  "drive_expense_files",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    run_id: uuid("run_id"),
    folder_id: uuid("folder_id"),
    drive_file_id: varchar("drive_file_id", { length: 128 }).notNull(),
    drive_file_name: varchar("drive_file_name", { length: 512 }),
    // "2026 / March 2026 / Purchase / iTarang account / Trontek" — in an
    // accounts folder the path carries the month, the entity and the
    // purchase-vs-sale distinction, so it is the audit trail's best column.
    folder_path: text("folder_path"),
    mime_type: varchar("mime_type", { length: 160 }),
    // Google's content hash. Native Google Sheets/Docs have none — the code
    // stores the RFC3339 modifiedTime instead, so this is never null and the
    // unique index below actually bites.
    md5_checksum: varchar("md5_checksum", { length: 128 }),
    drive_modified_time: timestamp("drive_modified_time", { withTimezone: true }),
    // 'imported' | 'duplicate' | 'needs_attention' | 'unsupported' | 'failed'
    status: text().notNull(),
    // Shown verbatim in the needs-attention panel — write it for the person
    // who has to fix the row.
    reason: text(),
    // Array: a costing sheet yields many expense ids, an invoice yields one.
    expense_ids: jsonb("expense_ids").default([]).notNull(),
    storage_key: text("storage_key"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Dedup layer 1 — an unchanged file is never re-downloaded or re-sent to
    // the model. This is what makes re-scanning a folder free.
    driveExpenseFilesFileVersionUnique: uniqueIndex(
      "drive_expense_files_file_version_unique",
    ).on(table.drive_file_id, table.md5_checksum),
    driveExpenseFilesFileIdx: index("drive_expense_files_file_idx").on(
      table.drive_file_id,
    ),
    driveExpenseFilesRunIdx: index("drive_expense_files_run_idx").on(
      table.run_id,
      table.created_at,
    ),
    // Partial (WHERE status IN ('needs_attention','failed')) in the migration only.
    driveExpenseFilesAttentionIdx: index("drive_expense_files_attention_idx").on(
      table.created_at,
    ),
  }),
);

export const zohoSyncState = pgTable("zoho_sync_state", {
  id: integer().default(1).primaryKey().notNull(),
  last_invoice_modified_at: timestamp("last_invoice_modified_at", {
    withTimezone: true,
  }),
  last_run_at: timestamp("last_run_at", { withTimezone: true }),
  last_status: varchar("last_status", { length: 16 }),
  last_error: text("last_error"),
});

// E-176 — Manual / offline dealer sales bulk-uploaded by the CEO, surfaced
// alongside Zoho invoices in the "Sales to Dealer" drill-down.
export const manualDealerSales = pgTable(
  "manual_dealer_sales",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    sale_date: date("sale_date").notNull(),
    customer_name: text("customer_name"),
    product_name: text("product_name"),
    quantity: numeric("quantity", { precision: 12, scale: 2 }),
    amount: numeric("amount", { precision: 14, scale: 2 }).default("0").notNull(),
    invoice_number: text("invoice_number"),
    uploaded_by: text("uploaded_by"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    saleDateIdx: index("manual_dealer_sales_sale_date_idx").on(t.sale_date),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// Part 0 BRD support tables (E-113 .. E-124).
// dealer_lead_id columns are text — matches dealer_leads.id (legacy text PK,
// flagged for Phase 0 reconciliation in BRD §0.13). All other id columns are
// uuid. No `.references()` — follows the audit_logs / aiCallLogs convention;
// integrity is enforced at the app layer.
// ─────────────────────────────────────────────────────────────────────────

// E-113 — Per-interaction history. Single writer in src/lib/touchpoints/write.ts.
export const leadTouchpoints = pgTable(
  "lead_touchpoints",
  {
    touchpoint_id: uuid("touchpoint_id").primaryKey().defaultRandom(),
    dealer_lead_id: text("dealer_lead_id").notNull(),
    touchpoint_type: varchar("touchpoint_type", { length: 50 }).notNull(),
    performed_by: text("performed_by"),
    performed_at: timestamp("performed_at", { withTimezone: true }).notNull(),
    call_status: varchar("call_status", { length: 30 }),
    call_duration_sec: integer("call_duration_sec"),
    is_engaged: boolean("is_engaged").default(false),
    remarks: text(),
    attachments: jsonb().default([]),
    next_action: varchar("next_action", { length: 50 }),
    next_action_at: timestamp("next_action_at", { withTimezone: true }),
    external_system: varchar("external_system", { length: 50 }),
    external_event_id: text("external_event_id"),
    sync_method: varchar("sync_method", { length: 30 }).default("manual"),
    // E-226 added lead_touchpoints.recording_url and .external_agent_name and
    // they are DELIBERATELY ABSENT HERE. This is the one table in the family
    // written through Drizzle (db.insert below in touchpoints/write.ts), and
    // Drizzle names every column of the table object in its INSERT — so listing
    // them would break every touchpoint write (calls, status changes,
    // escalations, reactivations) on any DB without E-226 applied, which today
    // includes prod. They are written by a best-effort raw UPDATE in
    // src/lib/neodove/inbound.ts after the transaction commits, and read via
    // `to_jsonb(t) ->> '...'`. Same treatment, same reason, as E-224's two
    // dealer_leads columns.
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    leadPerfIdx: index("lead_touchpoints_lead_perf_idx").on(
      t.dealer_lead_id,
      t.performed_at,
    ),
    typeCallIdx: index("lead_touchpoints_type_call_idx").on(
      t.touchpoint_type,
      t.call_status,
    ),
    performerIdx: index("lead_touchpoints_performer_idx").on(
      t.performed_by,
      t.performed_at,
    ),
    externalUniq: uniqueIndex("lead_touchpoints_external_uniq").on(
      t.external_system,
      t.external_event_id,
    ),
  }),
);

// E-114 — ASM ground visits (BRD §0.8).
export const leadVisits = pgTable(
  "lead_visits",
  {
    visit_id: uuid("visit_id").primaryKey().defaultRandom(),
    dealer_lead_id: text("dealer_lead_id").notNull(),
    asm_id: text("asm_id").notNull(),
    scheduled_date: date("scheduled_date"),
    actual_visit_date: date("actual_visit_date"),
    visit_status: varchar("visit_status", { length: 30 }).notNull(),
    visit_outcome: varchar("visit_outcome", { length: 30 }),
    visit_remarks: text("visit_remarks"),
    // E-220 — how the meeting happened: ground | calling | whatsapp. Free text
    // (vocabulary in src/lib/admin/types.ts MEETING_MODES) per this family's
    // convention; see the migration for why it is not a CHECK or an enum.
    meeting_mode: varchar("meeting_mode", { length: 16 }).default("ground"),
    photos: jsonb().default([]),
    gps_check_in_lat: numeric("gps_check_in_lat", { precision: 10, scale: 6 }),
    gps_check_in_lng: numeric("gps_check_in_lng", { precision: 10, scale: 6 }),
    next_action: varchar("next_action", { length: 30 }),
    next_visit_date: date("next_visit_date"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    leadSchedIdx: index("lead_visits_lead_sched_idx").on(
      t.dealer_lead_id,
      t.scheduled_date,
    ),
    asmStatusIdx: index("lead_visits_asm_status_idx").on(
      t.asm_id,
      t.visit_status,
    ),
  }),
);

// E-115 — Escalation events + resolution (BRD §0.6).
export const leadEscalations = pgTable(
  "lead_escalations",
  {
    escalation_id: uuid("escalation_id").primaryKey().defaultRandom(),
    dealer_lead_id: text("dealer_lead_id").notNull(),
    raised_by: text("raised_by").notNull(),
    raised_at: timestamp("raised_at", { withTimezone: true }).notNull(),
    escalation_reason: varchar("escalation_reason", { length: 50 }).notNull(),
    escalation_notes: text("escalation_notes").notNull(),
    suggested_action: text("suggested_action"),
    urgency: varchar("urgency", { length: 20 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("pending_review"),
    ceo_comment: text("ceo_comment"),
    ceo_recommendation: text("ceo_recommendation"),
    ceo_recommended_at: timestamp("ceo_recommended_at", { withTimezone: true }),
    resolved_by: text("resolved_by"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    resolution_action: varchar("resolution_action", { length: 30 }),
    resolution_notes: text("resolution_notes"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    statusUrgIdx: index("lead_escalations_status_urg_idx").on(
      t.status,
      t.urgency,
      t.raised_at,
    ),
    leadRaisedIdx: index("lead_escalations_lead_raised_idx").on(
      t.dealer_lead_id,
      t.raised_at,
    ),
  }),
);

// E-116 — Versioned commercials (BRD §0.10).
export const dealerLeadCommercials = pgTable(
  "dealer_lead_commercials",
  {
    commercial_id: uuid("commercial_id").primaryKey().defaultRandom(),
    dealer_lead_id: text("dealer_lead_id").notNull(),
    version_no: integer("version_no").notNull(),
    is_current: boolean("is_current").default(false),
    event_type: varchar("event_type", { length: 30 }).notNull(),
    price_quoted: numeric("price_quoted", { precision: 14, scale: 2 }),
    quote_document_url: text("quote_document_url"),
    brochure_url: text("brochure_url"),
    brochure_sent_at: timestamp("brochure_sent_at", { withTimezone: true }),
    credit_terms: text("credit_terms"),
    delivery_terms: text("delivery_terms"),
    warranty_terms: text("warranty_terms"),
    final_price: numeric("final_price", { precision: 14, scale: 2 }),
    payment_method: varchar("payment_method", { length: 20 }),
    deal_notes: text("deal_notes"),
    // Structured product line-items (E-128): array of
    // { asset_type, product_id, product_name, model_id, unit_price, quantity }
    // sourced from the product_master_* tables.
    product_lines: jsonb("product_lines").default([]),
    notes: text(),
    created_by: text("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    withdrawn_at: timestamp("withdrawn_at", { withTimezone: true }),
    // E-221 — CEO approval gate. Only quote_issue / quote_revision are written
    // 'pending'; every other event type, and every pre-E-221 row, is
    // 'approved'. Vocabulary in src/lib/leads/quoteApproval.ts.
    approval_status: varchar("approval_status", { length: 16 }).default("approved"),
    approved_by: text("approved_by"),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    rejection_reason: text("rejection_reason"),
    // E-226 — how that status was reached, and the price check behind it.
    // 'auto' | 'manual'; NULL on pre-E-226 rows and on ungated events.
    // oem_evaluation snapshots the OEM prices used (incl. their price_id), so a
    // quote stays auditable after the price book moves on.
    approval_mode: varchar("approval_mode", { length: 16 }),
    oem_evaluation: jsonb("oem_evaluation"),
    // E-242 — the generated quotation draft. Distinct from quote_document_url,
    // which is whatever file the rep attached by hand; these are written only
    // by generateQuotationDraft() and only after approval. quote_snapshot is
    // the view the PDF was rendered from, kept for the same reason as
    // oem_evaluation: the masters and the price book move, the document must
    // not. quote_pdf_error records a render that failed after the approval
    // transaction had already committed.
    quote_number: varchar("quote_number", { length: 40 }),
    quote_pdf_url: text("quote_pdf_url"),
    quote_pdf_generated_at: timestamp("quote_pdf_generated_at", {
      withTimezone: true,
    }),
    quote_pdf_error: text("quote_pdf_error"),
    quote_snapshot: jsonb("quote_snapshot"),
    // E-243 — the DEALER's answer, orthogonal to approval_status above. That
    // column is iTarang's internal gate; this is what the dealer said about the
    // quotation we released. A quote can be approved by us and declined by
    // them, and both facts have to be readable at once. NULL = no answer yet.
    // `via` and `actor` carry the evidence, because this is a claim about
    // somebody outside the company.
    dealer_decision: varchar("dealer_decision", { length: 16 }),
    dealer_decision_at: timestamp("dealer_decision_at", { withTimezone: true }),
    dealer_decision_via: varchar("dealer_decision_via", { length: 20 }),
    dealer_decision_actor: text("dealer_decision_actor"),
    dealer_decision_note: text("dealer_decision_note"),
  },
  (t) => ({
    leadVersionUniq: uniqueIndex(
      "dealer_lead_commercials_lead_version_uniq",
    ).on(t.dealer_lead_id, t.version_no),
    leadVersionDescIdx: index(
      "dealer_lead_commercials_lead_version_desc_idx",
    ).on(t.dealer_lead_id, t.version_no),
    currentIdx: index("dealer_lead_commercials_current_idx").on(
      t.dealer_lead_id,
    ),
  }),
);

// E-242 — one row per channel per send attempt of a quotation draft.
//
// Append-only: a resend is a new row, never an update, so "we sent this three
// times and the first two bounced" stays answerable. The two channels are
// dispatched independently — WhatsApp failing must not undo a delivered email —
// so a single send can write one `sent` row and one `failed` row.
//
// Not buyback_notification_events, which is the closest existing thing but is
// NOT NULL on request_id with an FK to buyback_requests. No FKs here, matching
// dealer_lead_commercials.
export const quotationDispatches = pgTable(
  "quotation_dispatches",
  {
    dispatch_id: uuid("dispatch_id").primaryKey().defaultRandom(),
    commercial_id: uuid("commercial_id").notNull(),
    dealer_lead_id: text("dealer_lead_id").notNull(),
    // email | whatsapp — free text, vocabulary in src/lib/leads/quoteDispatch.ts
    channel: varchar("channel", { length: 20 }).notNull(),
    // The address or number actually used, snapshotted: the lead's email can be
    // corrected later, this stays what the message went to.
    recipient: text("recipient").notNull(),
    // sent | failed
    status: varchar("status", { length: 20 }).notNull(),
    provider_message_id: text("provider_message_id"),
    error: text("error"),
    sent_by: text("sent_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    commercialIdx: index("quotation_dispatches_commercial_idx").on(
      t.commercial_id,
      t.created_at,
    ),
    leadIdx: index("quotation_dispatches_lead_idx").on(
      t.dealer_lead_id,
      t.created_at,
    ),
  }),
);

// E-117 — Full status change audit (BRD §0.7).
export const dealerLeadStatusHistory = pgTable(
  "dealer_lead_status_history",
  {
    history_id: uuid("history_id").primaryKey().defaultRandom(),
    dealer_lead_id: text("dealer_lead_id").notNull(),
    from_status: varchar("from_status", { length: 50 }),
    to_status: varchar("to_status", { length: 50 }).notNull(),
    from_lost_reason: varchar("from_lost_reason", { length: 100 }),
    to_lost_reason: varchar("to_lost_reason", { length: 100 }),
    changed_by: text("changed_by").notNull(),
    changed_at: timestamp("changed_at", { withTimezone: true }).notNull(),
    reason_notes: text("reason_notes"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    leadChangedIdx: index(
      "dealer_lead_status_history_lead_changed_idx",
    ).on(t.dealer_lead_id, t.changed_at),
    changedAtIdx: index("dealer_lead_status_history_changed_at_idx").on(
      t.changed_at,
    ),
  }),
);

// E-118 — ASM territory mapping (BRD §0.8).
export const asmTerritories = pgTable(
  "asm_territories",
  {
    territory_id: uuid("territory_id").primaryKey().defaultRandom(),
    asm_id: text("asm_id").notNull(),
    state: varchar("state", { length: 100 }).notNull(),
    city: varchar("city", { length: 100 }),
    active_from: date("active_from"),
    active_to: date("active_to"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    stateCityIdx: index("asm_territories_state_city_idx").on(t.state, t.city),
    asmIdx: index("asm_territories_asm_idx").on(t.asm_id),
  }),
);

// E-119 — Bulk upload audit + 24h rollback (BRD §0.4).
export const uploadBatches = pgTable(
  "upload_batches",
  {
    batch_id: uuid("batch_id").primaryKey().defaultRandom(),
    uploaded_by: text("uploaded_by").notNull(),
    file_name: text("file_name").notNull(),
    total_rows: integer("total_rows").default(0),
    valid_rows: integer("valid_rows").default(0),
    errored_rows: integer("errored_rows").default(0),
    duplicate_rows: integer("duplicate_rows").default(0),
    routing_to_ai: boolean("routing_to_ai").default(false),
    source_label: text("source_label"),
    status: varchar("status", { length: 30 }).default("pending"),
    rollback_window_until: timestamp("rollback_window_until", {
      withTimezone: true,
    }),
    rolled_back_at: timestamp("rolled_back_at", { withTimezone: true }),
    rolled_back_by: text("rolled_back_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uploaderCreatedIdx: index("upload_batches_uploader_created_idx").on(
      t.uploaded_by,
      t.created_at,
    ),
    rollbackPendingIdx: index("upload_batches_rollback_pending_idx").on(
      t.rollback_window_until,
    ),
  }),
);

// E-120 — Admin-tunable assignment config (single-row table) (BRD §0.2, §0.1).
export const assignmentConfig = pgTable("assignment_config", {
  config_id: uuid("config_id").primaryKey().defaultRandom(),
  intent_score_threshold: integer("intent_score_threshold").default(60),
  working_hours_start: varchar("working_hours_start", { length: 8 }).default("09:00"),
  working_hours_end: varchar("working_hours_end", { length: 8 }).default("19:00"),
  working_days: jsonb("working_days").default([
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
  ]),
  updated_by: text("updated_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// E-121 — Working-day calendar (BRD §0.1 Glossary).
export const holidayCalendar = pgTable(
  "holiday_calendar",
  {
    holiday_id: uuid("holiday_id").primaryKey().defaultRandom(),
    holiday_date: date("holiday_date").notNull(),
    holiday_name: varchar("holiday_name", { length: 200 }).notNull(),
    is_active: boolean("is_active").default(true),
    created_by: text("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    dateUniq: uniqueIndex("holiday_calendar_date_uniq").on(t.holiday_date),
    activeIdx: index("holiday_calendar_active_idx").on(
      t.is_active,
      t.holiday_date,
    ),
  }),
);

// E-122 — Phone collision + address mismatch merge requests (BRD §0.4).
export const duplicateMergeRequests = pgTable(
  "duplicate_merge_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    request_type: varchar("request_type", { length: 50 }).notNull(),
    source_lead_id: text("source_lead_id"),
    target_lead_id: text("target_lead_id").notNull(),
    requested_by: text("requested_by"),
    request_notes: text("request_notes"),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    resolution_action: varchar("resolution_action", { length: 50 }),
    admin_resolution_notes: text("admin_resolution_notes"),
    resolved_by: text("resolved_by"),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    statusCreatedIdx: index("duplicate_merge_requests_status_created_idx").on(
      t.status,
      t.created_at,
    ),
    targetIdx: index("duplicate_merge_requests_target_idx").on(
      t.target_lead_id,
    ),
  }),
);

// E-123 — Manual interest_level override audit (BRD §0.7).
export const interestLevelOverrides = pgTable(
  "interest_level_overrides",
  {
    override_id: uuid("override_id").primaryKey().defaultRandom(),
    dealer_lead_id: text("dealer_lead_id").notNull(),
    from_value: varchar("from_value", { length: 20 }),
    to_value: varchar("to_value", { length: 20 }).notNull(),
    reason: text().notNull(),
    changed_by: text("changed_by").notNull(),
    changed_at: timestamp("changed_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    leadChangedIdx: index("interest_level_overrides_lead_changed_idx").on(
      t.dealer_lead_id,
      t.changed_at,
    ),
    changerIdx: index("interest_level_overrides_changer_idx").on(
      t.changed_by,
      t.changed_at,
    ),
  }),
);

// E-124 — Per-rep saved filters / defaults (BRD §0.13).
export const userPreferences = pgTable(
  "user_preferences",
  {
    pref_id: uuid("pref_id").primaryKey().defaultRandom(),
    user_id: text("user_id").notNull(),
    pref_key: varchar("pref_key", { length: 100 }).notNull(),
    pref_value: jsonb("pref_value").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    userKeyUniq: uniqueIndex("user_preferences_user_key_uniq").on(
      t.user_id,
      t.pref_key,
    ),
  }),
);

/* ══════════════════════════════════════════════════════════════════════════
 * LOAN CALCULATOR (dealer-portal EMI calculator + admin console)
 * Ported from the verified handoff schema. All tables prefixed calc_ to avoid
 * collision with existing project tables (leads/settings/schemes/nbfcs/...).
 * Money in PAISE (1 rupee = 100); rates as numeric. Config is effective-dated
 * (valid_from/valid_to) + versioned (calc_config_versions) for quote reproduction.
 * Guard constraints (partial-unique "one current row", checks) live in migration
 * drizzle/E-177_loan_calculator.sql. Engine: src/lib/calculator/engine.ts.
 * ══════════════════════════════════════════════════════════════════════════ */

export const calcEngineVariant = pgEnum("calc_engine_variant", ["A", "B"]);
export const calcRecordStatus = pgEnum("calc_record_status", ["active", "disabled"]);
export const calcAuditAction = pgEnum("calc_audit_action", ["create", "update", "delete"]);
export const calcCoverageType = pgEnum("calc_coverage_type", ["CITY", "PAN_INDIA"]);
export const calcComponentKind = pgEnum("calc_component_kind", [
  "battery",
  "charger",
  "harness",
  "soc",
  "iot",
]);
export const calcLeadFilterOutcome = pgEnum("calc_lead_filter_outcome", [
  "qualified",
  "stretch_only",
  "none",
]);

// One row per published state of config. Every admin save inserts a new version
// and stamps the changed rows' valid_from with it (config-as-of-version resolution).
export const calcConfigVersions = pgTable(
  "calc_config_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").notNull(),
    note: text("note"),
    changeSummary: jsonb("change_summary"),
  },
  (t) => ({
    createdAtIdx: index("calc_config_versions_created_at_idx").on(t.createdAt),
  }),
);

// One row per mutation on any config table (who/what/before->after) for the
// version-history & rollback screen.
export const calcAuditLog = pgTable(
  "calc_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    actorId: uuid("actor_id").notNull(),
    action: calcAuditAction("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    configVersionId: bigint("config_version_id", { mode: "number" }).references(
      () => calcConfigVersions.id,
    ),
  },
  (t) => ({
    entityIdx: index("calc_audit_log_entity_idx").on(t.entity, t.entityId),
    atIdx: index("calc_audit_log_at_idx").on(t.at),
    actorIdx: index("calc_audit_log_actor_idx").on(t.actorId),
  }),
);

// Global settings (effective-dated, single current row). dealer margin, near-best
// window, disclaimer, filter-required toggles, Card-2 footer contacts.
export const calcSettings = pgTable(
  "calc_settings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dealerMarginPaise: bigint("dealer_margin_paise", { mode: "number" }).notNull(),
    nearBestWindowPct: numeric("near_best_window_pct", { precision: 5, scale: 2 })
      .default("25")
      .notNull(),
    expectedEmiFilterRequired: boolean("expected_emi_filter_required").default(false).notNull(),
    upfrontFilterRequired: boolean("upfront_filter_required").default(false).notNull(),
    disclaimerText: text("disclaimer_text").notNull(),
    cardFooterDisclaimer: text("card_footer_disclaimer").notNull(),
    contactPhone: text("contact_phone").notNull(),
    contactEmail: text("contact_email").notNull(),
    contactWhatsapp: text("contact_whatsapp").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    configVersionId: bigint("config_version_id", { mode: "number" })
      .references(() => calcConfigVersions.id)
      .notNull(),
  },
  (t) => ({
    currentIdx: index("calc_settings_valid_to_idx").on(t.validTo),
  }),
);

export const calcBatteryModels = pgTable(
  "calc_battery_models",
  {
    id: serial("id").primaryKey(),
    skuCode: text("sku_code").notNull(),
    displayName: text("display_name").notNull(),
    voltage: numeric("voltage", { precision: 5, scale: 1 }),
    capacityAh: integer("capacity_ah"),
    chargerSku: text("charger_sku"),
    status: calcRecordStatus("status").default("active").notNull(),
  },
  (t) => ({
    skuUq: uniqueIndex("calc_battery_models_sku_uq").on(t.skuCode),
  }),
);

// price_with_gst = (battery+harness+soc+iot)*1.18 + charger*1.05 (per-component gst stored).
export const calcComponentPrices = pgTable(
  "calc_component_prices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    modelId: integer("model_id")
      .references(() => calcBatteryModels.id)
      .notNull(),
    component: calcComponentKind("component").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    gstMultiplier: numeric("gst_multiplier", { precision: 5, scale: 4 }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    configVersionId: bigint("config_version_id", { mode: "number" })
      .references(() => calcConfigVersions.id)
      .notNull(),
  },
  (t) => ({
    lookupIdx: index("calc_component_prices_lookup_idx").on(t.modelId, t.component, t.validTo),
  }),
);

// Optional per-model dealer-margin override. Precedence: model override -> settings.
export const calcDealerMarginOverrides = pgTable(
  "calc_dealer_margin_overrides",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    modelId: integer("model_id")
      .references(() => calcBatteryModels.id)
      .notNull(),
    dealerMarginPaise: bigint("dealer_margin_paise", { mode: "number" }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    configVersionId: bigint("config_version_id", { mode: "number" })
      .references(() => calcConfigVersions.id)
      .notNull(),
  },
  (t) => ({
    lookupIdx: index("calc_dealer_margin_overrides_lookup_idx").on(t.modelId, t.validTo),
  }),
);

// Variant A: flatMaxLoan + flatInterestRate used. Variant B: those are null; cap is
// per-model (calc_nbfc_model_caps), rate is per-scheme (calc_schemes).
export const calcNbfcs = pgTable(
  "calc_nbfcs",
  {
    id: serial("id").primaryKey(),
    nbfcCode: text("nbfc_code").notNull(),
    name: text("name").notNull(),
    variant: calcEngineVariant("variant").notNull(),
    maxLoanCapPaise: bigint("max_loan_cap_paise", { mode: "number" }),
    flatInterestRate: numeric("flat_interest_rate", { precision: 10, scale: 7 }),
    fileFeePaise: bigint("file_fee_paise", { mode: "number" }).notNull(),
    defaultProcessingFeePaise: bigint("default_processing_fee_paise", {
      mode: "number",
    }).notNull(),
    status: calcRecordStatus("status").default("active").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    configVersionId: bigint("config_version_id", { mode: "number" })
      .references(() => calcConfigVersions.id)
      .notNull(),
  },
  (t) => ({
    nameUq: uniqueIndex("calc_nbfcs_name_uq").on(t.name, t.validTo),
    statusIdx: index("calc_nbfcs_status_idx").on(t.status, t.validTo),
  }),
);

export const calcNbfcModelCaps = pgTable(
  "calc_nbfc_model_caps",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nbfcId: integer("nbfc_id")
      .references(() => calcNbfcs.id)
      .notNull(),
    modelId: integer("model_id")
      .references(() => calcBatteryModels.id)
      .notNull(),
    maxLoanCapPaise: bigint("max_loan_cap_paise", { mode: "number" }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    configVersionId: bigint("config_version_id", { mode: "number" })
      .references(() => calcConfigVersions.id)
      .notNull(),
  },
  (t) => ({
    lookupIdx: index("calc_nbfc_model_caps_lookup_idx").on(t.nbfcId, t.modelId, t.validTo),
  }),
);

// code "XbyY" derived from (tenure, advance). appliedInterestRate = the rate actually
// used in interest = loan*rate*tenure/12 (NOT a display/MBD rate). advance < tenure.
export const calcSchemes = pgTable(
  "calc_schemes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nbfcId: integer("nbfc_id")
      .references(() => calcNbfcs.id)
      .notNull(),
    tenureMonths: integer("tenure_months").notNull(),
    advanceMonths: integer("advance_months").notNull(),
    code: text("code").notNull(),
    appliedInterestRate: numeric("applied_interest_rate", { precision: 10, scale: 7 }),
    processingFeePaise: bigint("processing_fee_paise", { mode: "number" }),
    advanceInterestRate: numeric("advance_interest_rate", { precision: 10, scale: 7 }),
    status: calcRecordStatus("status").default("active").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    configVersionId: bigint("config_version_id", { mode: "number" })
      .references(() => calcConfigVersions.id)
      .notNull(),
  },
  (t) => ({
    nbfcIdx: index("calc_schemes_nbfc_idx").on(t.nbfcId, t.status, t.validTo),
    codeIdx: index("calc_schemes_code_idx").on(t.nbfcId, t.code),
  }),
);

// An NBFC is either PAN_INDIA (city_normalized NULL) or has explicit CITY rows.
// A city may map to multiple NBFCs (intended).
export const calcNbfcCoverage = pgTable(
  "calc_nbfc_coverage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nbfcId: integer("nbfc_id")
      .references(() => calcNbfcs.id)
      .notNull(),
    coverageType: calcCoverageType("coverage_type").notNull(),
    cityNormalized: text("city_normalized"),
    stateCode: text("state_code"),
    cityDisplay: text("city_display"),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    configVersionId: bigint("config_version_id", { mode: "number" })
      .references(() => calcConfigVersions.id)
      .notNull(),
  },
  (t) => ({
    cityIdx: index("calc_nbfc_coverage_city_idx").on(t.cityNormalized, t.validTo),
    nbfcIdx: index("calc_nbfc_coverage_nbfc_idx").on(t.nbfcId, t.validTo),
  }),
);

// E-178: WhatsApp OTP sessions for the calculator gate. Matched by
// (created_by, phone) — users.dealer_id can be NULL, so the user id is the key.
export const calcOtpVerifications = pgTable(
  "calc_otp_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").notNull(),
    dealerId: varchar("dealer_id", { length: 255 }),
    phone: text("phone").notNull(), // normalized digits: 91XXXXXXXXXX
    customerName: text("customer_name"),
    otpHash: text("otp_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sendCount: integer("send_count").default(1).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    waStatus: text("wa_status"), // 'sent' | 'dev_hardcoded' | 'failed'
  },
  (t) => ({
    lookupIdx: index("calc_otp_verif_lookup_idx").on(t.createdBy, t.phone, t.createdAt),
  }),
);

// Saved quotes - one row per dealer calculation. Stamped with the outcome, the
// exact config version used, and a snapshot of the cards shown (dispute reproduction).
export const calcLeads = pgTable(
  "calc_leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    dealerId: varchar("dealer_id", { length: 255 }),
    customerName: text("customer_name").notNull(),
    phone: text("phone").notNull(),
    pincode: text("pincode"),
    city: text("city"),
    state: text("state"),
    expectedEmiPaise: bigint("expected_emi_paise", { mode: "number" }),
    upfrontAbilityPaise: bigint("upfront_ability_paise", { mode: "number" }),
    tenureMonths: integer("tenure_months"),
    modelId: integer("model_id").references(() => calcBatteryModels.id),
    filterOutcome: calcLeadFilterOutcome("filter_outcome"),
    configVersionId: bigint("config_version_id", { mode: "number" }).references(
      () => calcConfigVersions.id,
    ),
    resultSnapshot: jsonb("result_snapshot"),
    crmLeadId: text("crm_lead_id"),
    crmSyncedAt: timestamp("crm_synced_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    // E-178: OTP gate + WhatsApp results delivery stamps
    otpVerificationId: uuid("otp_verification_id").references(() => calcOtpVerifications.id),
    otpVerifiedAt: timestamp("otp_verified_at", { withTimezone: true }),
    waResultsStatus: text("wa_results_status"), // 'sent' | 'failed' | 'skipped'
    waResultsSentAt: timestamp("wa_results_sent_at", { withTimezone: true }),
  },
  (t) => ({
    phoneIdx: index("calc_leads_phone_idx").on(t.phone),
    createdAtIdx: index("calc_leads_created_at_idx").on(t.createdAt),
    dealerIdx: index("calc_leads_dealer_idx").on(t.dealerId),
  }),
);

export const calcNbfcsRelations = relations(calcNbfcs, ({ many }) => ({
  schemes: many(calcSchemes),
  modelCaps: many(calcNbfcModelCaps),
  coverage: many(calcNbfcCoverage),
}));

export const calcSchemesRelations = relations(calcSchemes, ({ one }) => ({
  nbfc: one(calcNbfcs, { fields: [calcSchemes.nbfcId], references: [calcNbfcs.id] }),
}));

export const calcBatteryModelsRelations = relations(calcBatteryModels, ({ many }) => ({
  componentPrices: many(calcComponentPrices),
  modelCaps: many(calcNbfcModelCaps),
}));

export const calcComponentPricesRelations = relations(calcComponentPrices, ({ one }) => ({
  model: one(calcBatteryModels, {
    fields: [calcComponentPrices.modelId],
    references: [calcBatteryModels.id],
  }),
}));

// ── E-179 Central lead registry ──────────────────────────────────────────────
// One append-only row for EVERY new lead-like capture across the platform —
// customer leads (web + WhatsApp), dealer onboarding (web wizard + WhatsApp
// bot), NBFC onboarding, OEM. The originating record lives in its own table;
// source_table/source_id link back to it. Written best-effort via
// recordLeadCapture() in src/lib/leads/lead-registry.ts — never blocks the
// main flow. The partial unique index on (source_table, source_id) makes the
// helper idempotent on retries/double-submits.
export const leadRegistry = pgTable(
  "lead_registry",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    leadType: varchar("lead_type", { length: 16 }).notNull(), // 'dealer' | 'customer' | 'oem' | 'nbfc'
    name: text("name").notNull(),
    phone: varchar("phone", { length: 20 }),
    sourceChannel: varchar("source_channel", { length: 16 }).notNull(), // 'web' | 'whatsapp' | 'admin' | 'scraper'
    sourceTable: text("source_table"),
    sourceId: text("source_id"),
  },
  (t) => ({
    typeCreatedIdx: index("lead_registry_type_created_idx").on(t.leadType, t.createdAt),
    phoneIdx: index("lead_registry_phone_idx").on(t.phone),
  }),
);

// ---------------------------------------------------------------------------
// PEAKAMP BATTERY BUYBACK PORTAL (E-185)
//
// Mirrors drizzle/E-185_buyback_core.sql — that file is the source of truth.
// Spec: docs/peakAmp/DEVELOPMENT_BRD.md §3.
//
// Schema-level invariants (do not "fix" these by adding columns):
//   · buybackRequests carries NO pricing. Prices live on lines/offers/locks.
//   · negotiationRounds and finalOffers have NO amount column — every offer is
//     itemized per SKU on their *_lines children. Lump sums are unrepresentable.
//   · buybackActivityLog is INSERT-only (DB trigger blocks UPDATE/DELETE).
//   · buybackNotificationEvents.idempotencyKey is UNIQUE — exactly one event
//     per state change.
//
// Unrelated to nbfcBuybackRequests (E-118), which is NBFC recovery of financed
// batteries — a different domain that happens to share the word "buyback".
// ---------------------------------------------------------------------------

// The deal state machine (BRD §2). ALL states are declared up front so no later
// sprint needs an ALTER TYPE. Sprint 1 only transitions into the first eight.
// DEALER_REOPENED is declared but intentionally unreachable — `reopen` returns
// the deal to NEGOTIATING and bumps offerVersion, which carries that signal.
export const buybackDealStatus = pgEnum("buyback_deal_status", [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "INFO_REQUESTED",
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
  "DEALER_ACCEPTED",
  "MARGIN_SET",
  "VENDOR_ROUTED",
  "VENDOR_NEGOTIATING",
  "VENDOR_AGREED",
  "DEALER_REOPENED",
  "PO_EXCHANGED",
  "PICKUP_SCHEDULED",
  "PICKED_UP",
  "INVOICE_RAISED",
  "INVOICE_APPROVED",
  "SETTLED",
  "CLOSED",
  "REJECTED",
  "CANCELLED",
]);

export const buybackEntityRole = pgEnum("buyback_entity_role", [
  "BATTERY_DEALER",
  "SCRAP_SELLER",
  "SCRAP_VENDOR",
]);
export const buybackSourceChannel = pgEnum("buyback_source_channel", ["WEB", "WHATSAPP", "CSV"]);
export const buybackCondition = pgEnum("buyback_condition", ["WORKING", "DEAD"]);
export const buybackProvScope = pgEnum("buyback_prov_scope", ["LINE", "UNIT"]);
export const buybackProvSource = pgEnum("buyback_prov_source", ["PREV_OWNER_DOCS", "DEALER_STOCK"]);
export const buybackLeg = pgEnum("buyback_leg", ["DEALER", "VENDOR"]);
export const buybackFinalOfferStatus = pgEnum("buyback_final_offer_status", [
  "SENT",
  "ACCEPTED",
  "DECLINED",
]);
export const buybackMarginMode = pgEnum("buyback_margin_mode", ["FLAT", "PCT"]);
export const buybackNotifyParty = pgEnum("buyback_notify_party", ["DEALER", "ADMIN", "VENDOR"]);
export const buybackNotifyChannel = pgEnum("buyback_notify_channel", [
  "WHATSAPP",
  "EMAIL",
  "PORTAL",
]);
export const buybackNotifyStatus = pgEnum("buyback_notify_status", ["PENDING", "SENT", "FAILED"]);

// M16 — every V+Ah combo is its own variant (BRD P1), with separate Working and
// Dead buyback estimates.
export const catalogVariants = pgTable(
  "catalog_variants",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    type: text().notNull(), // display SKU name, e.g. '60V 120Ah Li-ion'
    chemistry: text(),
    voltage: numeric({ precision: 6, scale: 2 }).notNull(),
    ah: numeric({ precision: 7, scale: 2 }).notNull(),
    unit_price: numeric("unit_price", { precision: 12, scale: 2 }),
    est_buyback_price_working: numeric("est_buyback_price_working", { precision: 12, scale: 2 }),
    est_buyback_price_dead: numeric("est_buyback_price_dead", { precision: 12, scale: 2 }),
    price_book_version: integer("price_book_version").default(1).notNull(),
    active: boolean().default(true).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    typeVAhUnique: uniqueIndex("catalog_variants_type_v_ah_unique").on(t.type, t.voltage, t.ah),
  }),
);

// BRD §8 — the role layer on top of the existing `accounts` entity/KYC store.
export const businessEntityRoles = pgTable(
  "business_entity_roles",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    entity_id: varchar("entity_id", { length: 255 })
      .notNull()
      .references(() => accounts.id),
    role: buybackEntityRole().notNull(),
    status: text().default("PENDING").notNull(), // PENDING | ACTIVE | SUSPENDED
    agreement_id: text("agreement_id"), // Digio doc id — Sprint 4 (M19)
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    entityRoleUnique: uniqueIndex("business_entity_roles_entity_role_unique").on(
      t.entity_id,
      t.role,
    ),
  }),
);

// `accounts` holds only one address, but the dealer picks a pickup location at
// intake (M02). Sprint 1 is order-level; per-batch/per-line is Sprint 3 (M05).
export const buybackPickupAddresses = pgTable(
  "buyback_pickup_addresses",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    entity_id: varchar("entity_id", { length: 255 })
      .notNull()
      .references(() => accounts.id),
    label: text().notNull(), // 'Shop — Nashik'
    address_line1: text("address_line1").notNull(),
    address_line2: text("address_line2"),
    city: text(),
    state: text(),
    pincode: varchar({ length: 6 }),
    contact_name: text("contact_name"),
    contact_phone: varchar("contact_phone", { length: 20 }),
    is_default: boolean("is_default").default(false).notNull(),
    active: boolean().default(true).notNull(),
    // E-194 — DEALER | VENDOR | CUSTOMER. TEXT + CHECK (in SQL), not an enum:
    // same reasoning as buyback_lines.chemistry, the set may grow. entity_id
    // says which account this hangs off; this says what role it plays.
    owner_kind: text("owner_kind").default("DEALER").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    entityIdx: index("buyback_pickup_addresses_entity_idx").on(t.entity_id),
  }),
);

// INVARIANT 1: no pricing column here, ever. Totals are derived from lines/locks.
// Also NO status column — BRD §2 ("persist status as one enum on the deal; never
// scattered booleans"). buybackDeals.status is the single source of truth, and a
// deal row is created alongside every request (at DRAFT).
export const buybackRequests = pgTable(
  "buyback_requests",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // Human-readable reference shown in the UI and searchable in M23 ('BB-1024').
    request_no: text("request_no").notNull(),
    dealer_entity_id: varchar("dealer_entity_id", { length: 255 })
      .notNull()
      .references(() => accounts.id),
    source_channel: buybackSourceChannel("source_channel").default("WEB").notNull(),
    created_by: uuid("created_by"),
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    requestNoUnique: uniqueIndex("buyback_requests_request_no_unique").on(t.request_no),
    dealerCreatedIdx: index("buyback_requests_dealer_created_idx").on(
      t.dealer_entity_id,
      t.created_at,
    ),
    // E-192 — was the review queue's own sort. The queue moved to newest-first
    // in E-194 (below), but this stays: /reports and any FIFO reader still
    // want ascending, and dropping it would be a destructive change to a
    // shared DB for no gain.
    submittedCreatedIdx: index("buyback_requests_submitted_created_idx").on(
      t.submitted_at.nullsLast(),
      t.created_at,
    ),
    // E-194 — the review queue's sort now (queue/route.ts `ORDER BY
    // submitted_at DESC NULLS LAST, created_at DESC`). Not a duplicate of the
    // ASC index above: reverse-scanning that one gives DESC NULLS FIRST, which
    // would float every unsubmitted request to the top of the queue.
    submittedCreatedDescIdx: index("buyback_requests_submitted_created_desc_idx").on(
      t.submitted_at.desc().nullsLast(),
      t.created_at.desc(),
    ),
    // E-192 — GIN trigram, leading-wildcard admin/dealer search (M23).
    requestNoTrgmIdx: index("buyback_requests_request_no_trgm_idx").using(
      "gin",
      t.request_no.op("gin_trgm_ops"),
    ),
  }),
);

export const buybackBatches = pgTable(
  "buyback_batches",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => buybackRequests.id, { onDelete: "cascade" }),
    pickup_address_id: uuid("pickup_address_id").references(() => buybackPickupAddresses.id),
    status: text().default("OPEN").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    requestIdx: index("buyback_batches_request_idx").on(t.request_id),
  }),
);

export const buybackLines = pgTable(
  "buyback_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    batch_id: uuid("batch_id")
      .notNull()
      .references(() => buybackBatches.id, { onDelete: "cascade" }),
    variant_id: uuid("variant_id")
      .notNull()
      .references(() => catalogVariants.id),
    quantity: integer().notNull(),
    condition: buybackCondition().notNull(),
    measured_voltage: numeric("measured_voltage", { precision: 6, scale: 2 }),
    expected_price_per_unit: numeric("expected_price_per_unit", { precision: 12, scale: 2 }),
    // Snapshot of the price book, so a later catalog edit never moves an open
    // request's reference price (M16 AC).
    price_book_version_at_create: integer("price_book_version_at_create").default(1).notNull(),
    // E-191 — dealer-declared battery spec. All nullable: the intake autosaves
    // the line before the dealer has typed the spec; the REQUIRED subset
    // (brand, chemistry, nominal V/Ah, unit weight, IOT yes/no) is enforced by
    // the submit gate, not by NOT NULL. Chemistry/form_factor are TEXT
    // validated by zod (src/lib/buyback/line-spec.ts), not enums.
    brand: text(),
    chemistry: text(),
    form_factor: text("form_factor"),
    nominal_voltage: numeric("nominal_voltage", { precision: 8, scale: 2 }),
    nominal_ampere: numeric("nominal_ampere", { precision: 10, scale: 2 }),
    unit_weight_kg: numeric("unit_weight_kg", { precision: 10, scale: 3 }),
    warranty_cycles: integer("warranty_cycles"),
    functional_qty: integer("functional_qty"),
    non_functional_qty: integer("non_functional_qty"),
    iot_battery: boolean("iot_battery"),
    iot_brand_name: text("iot_brand_name"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    batchIdx: index("buyback_lines_batch_idx").on(t.batch_id),
    // E-192 — FK index; had none.
    variantIdx: index("buyback_lines_variant_id_idx").on(t.variant_id),
  }),
);

// qty N → Unit 1..N, auto-generated at line create (BRD P3).
export const buybackUnits = pgTable(
  "buyback_units",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id, { onDelete: "cascade" }),
    unit_no: integer("unit_no").notNull(),
    status: text().default("PENDING").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineUnitUnique: uniqueIndex("buyback_units_line_unit_unique").on(t.line_id, t.unit_no),
  }),
);

// Declared here, not down with the other buyback enums, because buybackPhotos below
// references it in a column initialiser. `const` is not hoisted: with the declaration
// further down the file, importing this module threw "Cannot access 'buybackPhotoFlag'
// before initialization" at load time and took every route that touches the schema with it.
// TypeScript does not catch that — it is a runtime temporal-dead-zone error, so `tsc` stays
// green while the app 500s. An enum must be declared above its first use.
export const buybackPhotoFlag = pgEnum("buyback_photo_flag", [
  "DUPLICATE_SAME_DEALER",
  "DUPLICATE_CROSS_DEALER",
]);

// M03 — min 5 photos per line at submit. phash/dedup is Sprint 3 (NULL for now).
export const buybackPhotos = pgTable(
  "buyback_photos",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id, { onDelete: "cascade" }),
    unit_id: uuid("unit_id").references(() => buybackUnits.id, { onDelete: "cascade" }),
    s3_key_original: text("s3_key_original").notNull(),
    s3_key_display: text("s3_key_display"),
    phash: text(),
    exif: jsonb(),
    taken_at: timestamp("taken_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    // --- M03 dedup (E-188) ---
    // DUPLICATE_CROSS_DEALER is the fraud case: the same battery photographed
    // once and sold to us by two different dealers. DUPLICATE_SAME_DEALER is
    // usually a careless re-upload. Flagged separately because they warrant
    // completely different responses.
    //
    // dup_of_photo_id is a self-reference; declared as a plain uuid (the FK lives
    // in E-188) to keep Drizzle out of a self-referential type cycle.
    phash_computed_at: timestamp("phash_computed_at", { withTimezone: true }),
    dup_of_photo_id: uuid("dup_of_photo_id"),
    dup_flag: buybackPhotoFlag("dup_flag"),
    dup_flagged_at: timestamp("dup_flagged_at", { withTimezone: true }),
    dup_cleared_at: timestamp("dup_cleared_at", { withTimezone: true }),
    dup_cleared_by: uuid("dup_cleared_by"),
  },
  (t) => ({
    lineIdx: index("buyback_photos_line_idx").on(t.line_id),
    // E-192 — FK index; had none.
    unitIdx: index("buyback_photos_unit_id_idx").on(t.unit_id),
  }),
);

// M04 — single owner identity per record (BRD P2). scope=LINE is the default;
// a per-unit override is a second row with scope=UNIT.
export const provenanceRecords = pgTable(
  "provenance_records",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    scope: buybackProvScope().notNull(),
    line_id: uuid("line_id").references(() => buybackLines.id, { onDelete: "cascade" }),
    unit_id: uuid("unit_id").references(() => buybackUnits.id, { onDelete: "cascade" }),
    source_type: buybackProvSource("source_type").notNull(),
    prev_owner_name: text("prev_owner_name"), // usually the driver
    prev_owner_phone: varchar("prev_owner_phone", { length: 20 }),
    vehicle_no: text("vehicle_no"),
    rc_number: text("rc_number"),
    id_proof_type: text("id_proof_type"),
    id_proof_s3: text("id_proof_s3"),
    payment_proof_ref: text("payment_proof_ref"),
    // --- E-197: who the previous owner is, and how to pay them ---------------
    /** Full. A tax identity (TDS/reporting), and not a credential. */
    prev_owner_pan: text("prev_owner_pan"),
    /**
     * LAST FOUR ONLY — a DB CHECK (`^[0-9]{4}$`) makes a full Aadhaar
     * unstorable. Under DPDP/UIDAI we have no need to hold the number; the
     * Decentro ref below is the actual evidence.
     */
    prev_owner_aadhaar_last4: varchar("prev_owner_aadhaar_last4", { length: 4 }),
    prev_owner_aadhaar_ref: text("prev_owner_aadhaar_ref"),
    prev_owner_aadhaar_verified_at: timestamp("prev_owner_aadhaar_verified_at", {
      withTimezone: true,
    }),
    /**
     * Full — you cannot pay a masked account. Held ONLY because
     * settlement_transactions.payee_provenance_id makes paying this person
     * expressible. Do not collect a bank account for someone we cannot pay.
     */
    payee_account_number: text("payee_account_number"),
    payee_ifsc: varchar("payee_ifsc", { length: 11 }),
    payee_bank_name: text("payee_bank_name"),
    /** Not always prev_owner_name — a driver may bank as their firm. */
    payee_beneficiary_name: text("payee_beneficiary_name"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineIdx: index("provenance_records_line_idx").on(t.line_id),
    unitIdx: index("provenance_records_unit_idx").on(t.unit_id),
    // E-192 — GIN trigram, leading-wildcard admin/dealer search (M23).
    vehicleNoTrgmIdx: index("provenance_records_vehicle_no_trgm_idx").using(
      "gin",
      t.vehicle_no.op("gin_trgm_ops"),
    ),
    rcNumberTrgmIdx: index("provenance_records_rc_number_trgm_idx").using(
      "gin",
      t.rc_number.op("gin_trgm_ops"),
    ),
    prevOwnerNameTrgmIdx: index("provenance_records_prev_owner_name_trgm_idx").using(
      "gin",
      t.prev_owner_name.op("gin_trgm_ops"),
    ),
  }),
);

// M06 / BRD P4 — unit-targeted, so the dealer's banner names exactly the
// batteries in question ("Unit 2"), not the whole request.
export const infoRequests = pgTable(
  "info_requests",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => buybackRequests.id, { onDelete: "cascade" }),
    target_line_ids: uuid("target_line_ids").array().default(sql`'{}'`).notNull(),
    target_unit_ids: uuid("target_unit_ids").array().default(sql`'{}'`).notNull(),
    checklist: jsonb().default([]).notNull(),
    note: text(),
    raised_by: uuid("raised_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    requestIdx: index("info_requests_request_idx").on(t.request_id, t.created_at),
  }),
);

// The state machine's row. One deal per request.
export const buybackDeals = pgTable(
  "buyback_deals",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => buybackRequests.id, { onDelete: "cascade" }),
    status: buybackDealStatus().default("DRAFT").notNull(),
    // Bumped by every reopen (U5). Final offers and lock generations are stamped
    // with the version they belong to.
    offer_version: integer("offer_version").default(1).notNull(),
    floor_total: numeric("floor_total", { precision: 14, scale: 2 }),
    locked_at: timestamp("locked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    requestUnique: uniqueIndex("buyback_deals_request_unique").on(t.request_id),
    statusCreatedIdx: index("buyback_deals_status_created_idx").on(t.status, t.created_at),
  }),
);

// M07 — INVARIANT 2: no amount column. Every counter is itemized per SKU in
// negotiationRoundLines. A lump-sum offer cannot be written to this schema.
export const negotiationRounds = pgTable(
  "negotiation_rounds",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    leg: buybackLeg().default("DEALER").notNull(),
    counterparty_id: varchar("counterparty_id", { length: 255 }),
    round_no: integer("round_no").notNull(),
    offered_by: uuid("offered_by"),
    offered_by_role: text("offered_by_role").notNull(), // 'dealer' | 'admin'
    note: text(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dealLegRoundUnique: uniqueIndex("negotiation_rounds_deal_leg_round_unique").on(
      t.deal_id,
      t.leg,
      t.round_no,
    ),
  }),
);

export const negotiationRoundLines = pgTable(
  "negotiation_round_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    round_id: uuid("round_id")
      .notNull()
      .references(() => negotiationRounds.id, { onDelete: "cascade" }),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id, { onDelete: "cascade" }),
    offered_price_per_unit: numeric("offered_price_per_unit", {
      precision: 12,
      scale: 2,
    }).notNull(),
  },
  (t) => ({
    roundLineUnique: uniqueIndex("negotiation_round_lines_round_line_unique").on(
      t.round_id,
      t.line_id,
    ),
  }),
);

// M07 / U5 — itemized per SKU, ONE overall accept/decline, versioned.
export const finalOffers = pgTable(
  "final_offers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    version_no: integer("version_no").notNull(),
    status: buybackFinalOfferStatus().default("SENT").notNull(),
    note: text(),
    sent_by: uuid("sent_by"),
    sent_at: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    responded_at: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => ({
    dealVersionUnique: uniqueIndex("final_offers_deal_version_unique").on(t.deal_id, t.version_no),
  }),
);

export const finalOfferLines = pgTable(
  "final_offer_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    final_offer_id: uuid("final_offer_id")
      .notNull()
      .references(() => finalOffers.id, { onDelete: "cascade" }),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id, { onDelete: "cascade" }),
    price_per_unit: numeric("price_per_unit", { precision: 12, scale: 2 }).notNull(),
  },
  (t) => ({
    offerLineUnique: uniqueIndex("final_offer_lines_offer_line_unique").on(
      t.final_offer_id,
      t.line_id,
    ),
  }),
);

// M08 — the immutable per-SKU snapshot EVERY document and report reads from.
// Written once at MARGIN_SET; never updated. A reopen inserts a new
// offer_version generation. Margin never drifts.
export const dealLineLocks = pgTable(
  "deal_line_locks",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id, { onDelete: "cascade" }),
    offer_version: integer("offer_version").notNull(),
    dealer_price: numeric("dealer_price", { precision: 12, scale: 2 }).notNull(),
    margin_value: numeric("margin_value", { precision: 12, scale: 2 }).notNull(), // resolved rupees
    margin_mode: buybackMarginMode("margin_mode").notNull(),
    vendor_ask: numeric("vendor_ask", { precision: 12, scale: 2 }),
    vendor_price: numeric("vendor_price", { precision: 12, scale: 2 }),
    locked_by: uuid("locked_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dealLineVersionUnique: uniqueIndex("deal_line_locks_deal_line_version_unique").on(
      t.deal_id,
      t.line_id,
      t.offer_version,
    ),
  }),
);

// M21 — INSERT-only (a DB trigger blocks UPDATE/DELETE, which binds even the
// table owner). Written in the SAME transaction as the change it records.
export const buybackActivityLog = pgTable(
  "buyback_activity_log",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => buybackRequests.id, { onDelete: "cascade" }),
    deal_id: uuid("deal_id").references(() => buybackDeals.id, { onDelete: "cascade" }),
    actor_id: uuid("actor_id"),
    role: text().notNull(), // 'dealer' | 'admin' | 'system'
    action: text().notNull(), // the state-machine action, e.g. 'send_final_offer'
    before: jsonb(),
    after: jsonb(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    requestIdx: index("buyback_activity_log_request_idx").on(t.request_id, t.created_at),
    // E-192 — deal-scoped activity views had no index of their own.
    dealIdx: index("buyback_activity_log_deal_id_idx").on(t.deal_id),
  }),
);

// M20 / U4 — the outbound dispatch log. NOT the CRM's in-app `notifications`
// table (that one is a per-user bell). INVARIANT 6: idempotency_key is UNIQUE,
// so a retried transition cannot double-emit, and a missing row means a silent
// transition — i.e. a bug.
export const buybackNotificationEvents = pgTable(
  "buyback_notification_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id").references(() => buybackDeals.id, { onDelete: "cascade" }),
    request_id: uuid("request_id")
      .notNull()
      .references(() => buybackRequests.id, { onDelete: "cascade" }),
    event_type: text("event_type").notNull(),
    recipient_party: buybackNotifyParty("recipient_party").notNull(),
    channel: buybackNotifyChannel().notNull(),
    payload: jsonb().default({}).notNull(),
    idempotency_key: text("idempotency_key").notNull(), // '{deal_id}:{action}:{offer_version}'
    delivery_status: buybackNotifyStatus("delivery_status").default("PENDING").notNull(),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    error: text(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    // --- Dispatch (E-186) ---
    // Sprint 1 recorded events and nothing drained them. The dispatcher
    // (src/lib/buyback/dispatch.ts) claims due rows oldest-first, with backoff.
    attempts: integer().default(0).notNull(),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    // Snapshotted at emit time, never re-derived: a vendor's address may be
    // edited between the transition and the send, and the audit trail must say
    // where the message actually went — not where it would go if sent today.
    recipient_ref: text("recipient_ref"),
    attachment_s3_key: text("attachment_s3_key"),
    /**
     * E-198 — extra files beyond the primary one (the battery photos on a
     * vendor quotation). A missing key here is skipped at send; a missing
     * attachment_s3_key above throws, because the quotation IS the email.
     */
    attachment_s3_keys: text("attachment_s3_keys").array(),
  },
  (t) => ({
    idemUnique: uniqueIndex("buyback_notification_events_idem_unique").on(t.idempotency_key),
    dueIdx: index("buyback_notification_events_due_idx").on(t.next_attempt_at),
  }),
);

// ---------------------------------------------------------------------------
// --- PEAKAMP BUYBACK — VENDOR LEG & FULFILMENT (E-186, Sprint 2A) ---
//
// Carries a deal from MARGIN_SET to PICKED_UP:
//   VENDOR_ROUTED → VENDOR_NEGOTIATING → VENDOR_AGREED → PO_EXCHANGED
//                 → PICKUP_SCHEDULED → PICKED_UP
// Money (invoices, settlement, ledger) is Sprint 2B.
// Source of truth: drizzle/E-186_buyback_vendor_leg.sql.
// ---------------------------------------------------------------------------

export const buybackVendorThreadStatus = pgEnum("buyback_vendor_thread_status", [
  "SENT",
  "COUNTERED",
  "AGREED",
  "LOST",
]);
export const buybackPoDirection = pgEnum("buyback_po_direction", ["ISSUED", "RECEIVED"]);
export const buybackPoStatus = pgEnum("buyback_po_status", [
  "GENERATED",
  "SENT",
  "ACKNOWLEDGED",
]);
export const buybackPickupScope = pgEnum("buyback_pickup_scope", ["ORDER", "BATCH", "LINE"]);

// M09/M18 — a vendor IS an `accounts` row + a business_entity_roles row with
// role='SCRAP_VENDOR'. This table holds only what is vendor-specific.
export const scrapVendors = pgTable(
  "scrap_vendors",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    entity_id: varchar("entity_id", { length: 255 })
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    categories: jsonb().default([]).notNull(), // e.g. ["LI_ION","LFP"]
    regions: text().array().default([]).notNull(),
    payment_terms: text("payment_terms"),
    credit_limit: numeric("credit_limit", { precision: 14, scale: 2 }),
    active: boolean().default(true).notNull(),
    // E-223 — captured by the admin onboarding form. The registered ADDRESS
    // lives on `accounts` (address_line1/2, city, state, pincode already exist
    // there); only these three are vendor-specific.
    udyam_number: text("udyam_number"),
    /**
     * Reference on the MANUALLY signed vendor agreement (E-223). Deliberately
     * NOT business_entity_roles.agreement_id, which is reserved for the Digio
     * document id (M19): "we hold a scan" and "eSign completed" are different
     * assurances, and one column would let the weaker satisfy a check written
     * for the stronger.
     */
    agreement_ref: text("agreement_ref"),
    agreement_signed_on: date("agreement_signed_on"),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    entityUnique: uniqueIndex("scrap_vendors_entity_unique").on(t.entity_id),
  }),
);

/**
 * E-223 — the documents captured at vendor onboarding: GSTIN certificate, PAN
 * card, Udyam certificate (all three mandatory) and an optional manually
 * signed agreement.
 *
 * `entity_id` IS NULLABLE ON PURPOSE. The files are picked before the vendor
 * exists, so the upload route inserts an UNCLAIMED row and hands back its id;
 * submitting the form claims it (entity_id + claimed_at). The alternative —
 * letting the browser hand a storage key back at submit — would make a
 * client-supplied string a storage path, which is exactly what
 * src/lib/buyback/storage.ts refuses to allow.
 *
 * `doc_type` is free text (GSTIN | PAN | UDYAM | AGREEMENT), per this family's
 * convention; the vocabulary lives in src/lib/buyback/vendor-docs.ts and is
 * enforced by zod at the write path.
 */
export const scrapVendorDocuments = pgTable(
  "scrap_vendor_documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    entity_id: varchar("entity_id", { length: 255 }).references(() => accounts.id, {
      onDelete: "cascade",
    }),
    doc_type: text("doc_type").notNull(),
    s3_key: text("s3_key").notNull(),
    file_name: text("file_name"),
    content_type: text("content_type"),
    uploaded_by: uuid("uploaded_by"),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    entityIdx: index("scrap_vendor_documents_entity_idx").on(t.entity_id),
    // The two partial indexes from E-223 (one current doc per type; unclaimed
    // sweep) cannot be expressed here — Drizzle has no partial index. They
    // live only in the migration.
  }),
);

/**
 * E-223 — the record of emailing a vendor their generated portal password.
 * Modelled on nbfcPortalCredentials (E-002), including its most important
 * property: NO PASSWORD COLUMN. The plaintext is emailed and never persisted.
 *
 * One row per dispatch ATTEMPT. A retry after a bounced email is the normal
 * case this table exists to make visible, and overwriting the failed row would
 * erase the only evidence the first send was tried. Latest by created_at is
 * the current state.
 */
export const vendorPortalCredentials = pgTable(
  "vendor_portal_credentials",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    entity_id: varchar("entity_id", { length: 255 })
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    supabase_user_id: uuid("supabase_user_id").notNull(),
    /** pending | dispatched | credential_dispatch_failed */
    dispatch_status: varchar("dispatch_status", { length: 32 }).notNull(),
    /** The mailer's own sentence — shown to the admin beside the retry button. */
    last_error: text("last_error"),
    email_dispatched_at: timestamp("email_dispatched_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    entityIdx: index("vendor_portal_credentials_entity_idx").on(t.entity_id, t.created_at),
    statusIdx: index("vendor_portal_credentials_status_idx").on(t.dispatch_status),
  }),
);

// M09/M10 — one vendor's conversation about one deal.
//
// INVARIANT (P5): NO amount column. Every ask, counter and agreement is
// itemized on vendorThreadLines. A lump-sum vendor quote is unrepresentable.
//
// INVARIANT (M10): the partial unique index vendor_threads_one_agreed_per_deal
// (in E-186; Drizzle cannot express a partial index, so it lives only in SQL)
// permits at most ONE AGREED thread per deal. That is what makes "first AGREED
// wins, others auto-LOST" atomic rather than a read-then-write race.
export const vendorThreads = pgTable(
  "vendor_threads",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    vendor_id: uuid("vendor_id")
      .notNull()
      .references(() => scrapVendors.id),
    status: buybackVendorThreadStatus().default("SENT").notNull(),
    quotation_pdf_s3: text("quotation_pdf_s3"),
    quotation_no: text("quotation_no"),
    email_message_id: text("email_message_id"), // proof of dispatch (U6)
    sent_at: timestamp("sent_at", { withTimezone: true }),
    responded_at: timestamp("responded_at", { withTimezone: true }),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    close_reason: text("close_reason"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dealVendorUnique: uniqueIndex("vendor_threads_deal_vendor_unique").on(t.deal_id, t.vendor_id),
    dealIdx: index("vendor_threads_deal_idx").on(t.deal_id),
  }),
);

// The itemization (P5). ask = what we asked, counter = their latest per-SKU
// counter, agreed = what was struck.
export const vendorThreadLines = pgTable(
  "vendor_thread_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    thread_id: uuid("thread_id")
      .notNull()
      .references(() => vendorThreads.id, { onDelete: "cascade" }),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id, { onDelete: "cascade" }),
    ask_price: numeric("ask_price", { precision: 12, scale: 2 }).notNull(),
    counter_price: numeric("counter_price", { precision: 12, scale: 2 }),
    agreed_price: numeric("agreed_price", { precision: 12, scale: 2 }),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    threadLineUnique: uniqueIndex("vendor_thread_lines_thread_line_unique").on(
      t.thread_id,
      t.line_id,
    ),
  }),
);

// M11 — two per deal, one per leg. Both present ⇒ PO_EXCHANGED.
// Impossible before VENDOR_AGREED (gated by the state machine).
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    leg: buybackLeg().notNull(),
    direction: buybackPoDirection().notNull(),
    number: text().notNull(),
    pdf_s3: text("pdf_s3"),
    status: buybackPoStatus().default("GENERATED").notNull(),
    counterparty_entity_id: varchar("counterparty_entity_id", { length: 255 }).references(
      () => accounts.id,
    ),
    issued_at: timestamp("issued_at", { withTimezone: true }),
    acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dealLegUnique: uniqueIndex("purchase_orders_deal_leg_unique").on(t.deal_id, t.leg),
    dealIdx: index("purchase_orders_deal_idx").on(t.deal_id),
  }),
);

// Prices are COPIED from deal_line_locks at generation, so a later lock
// generation cannot retro-change a PO that has already gone out.
//
// The tax columns are modelled but unpopulated: GST/HSN/reverse-charge is an
// open item (BRD §10) that gates the first live deal and is Chirag's call.
// Documents render tax-exclusive until then; his ruling is a data change, not a
// migration.
export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    po_id: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id, { onDelete: "cascade" }),
    quantity: integer().notNull(),
    price_per_unit: numeric("price_per_unit", { precision: 12, scale: 2 }).notNull(),
    hsn_code: text("hsn_code"),
    taxable_value: numeric("taxable_value", { precision: 14, scale: 2 }),
    cgst: numeric({ precision: 12, scale: 2 }),
    sgst: numeric({ precision: 12, scale: 2 }),
    igst: numeric({ precision: 12, scale: 2 }),
    reverse_charge: boolean("reverse_charge"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    poLineUnique: uniqueIndex("purchase_order_lines_po_line_unique").on(t.po_id, t.line_id),
  }),
);

// M05 — the full BRD shape, but Sprint 2A only writes schedule/contact/
// completion, which is enough for a deal to legitimately reach PICKED_UP rather
// than teleport past two states it never entered. The BWM 2022 fields are
// declared so Sprint 3 needs no DDL.
export const pickups = pgTable(
  "pickups",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    batch_id: uuid("batch_id").references(() => buybackBatches.id, { onDelete: "cascade" }),
    scope: buybackPickupScope().default("BATCH").notNull(),
    scheduled_at: timestamp("scheduled_at", { withTimezone: true }),
    address: text(),
    contact_name: text("contact_name"),
    contact_phone: varchar("contact_phone", { length: 20 }),
    // M05 / BWM 2022 — declared in E-186, populated from Sprint 3 (E-188).
    eway_bill_no: text("eway_bill_no"),
    eway_bill_s3: text("eway_bill_s3"),
    weighbridge_slip_s3: text("weighbridge_slip_s3"),
    expected_counts: jsonb("expected_counts"),
    actual_counts: jsonb("actual_counts"),
    variance_flag: boolean("variance_flag").default(false).notNull(),
    variance_note: text("variance_note"),
    // THE GATE (M05 AC): the dealer must acknowledge a count variance BEFORE
    // payout. Making the obligation an explicit column — rather than inferring it
    // from `variance_flag AND dealer_ack_at IS NULL` in several places — is what
    // lets the settlement route refuse a dealer payout while it is unmet. Paying
    // out before the dealer agrees to the count means arguing about money we have
    // already sent.
    variance_ack_required: boolean("variance_ack_required").default(false).notNull(),
    dealer_ack_at: timestamp("dealer_ack_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dealIdx: index("pickups_deal_idx").on(t.deal_id),
    // E-192 — FK index; had none.
    batchIdx: index("pickups_batch_id_idx").on(t.batch_id),
  }),
);

// ---------------------------------------------------------------------------
// --- PEAKAMP BUYBACK — INVOICES, SETTLEMENT, LEDGER (E-187, Sprint 2B) ---
//
// PICKED_UP → INVOICE_RAISED → INVOICE_APPROVED → SETTLED → CLOSED.
// Source of truth: drizzle/E-187_buyback_money.sql.
// ---------------------------------------------------------------------------

export const buybackInvoiceStatus = pgEnum("buyback_invoice_status", [
  "RAISED",
  "APPROVED",
  "RETURNED",
]);
export const buybackInvoiceParty = pgEnum("buyback_invoice_party", ["DEALER", "ITARANG"]);
export const buybackSettleMethod = pgEnum("buyback_settle_method", [
  "MANUAL",
  "STATEMENT",
  "API",
]);
export const buybackSettleDirection = pgEnum("buyback_settle_direction", ["OUT", "IN"]);

// E-193 — PAYOUT (RazorpayX, dealer leg) vs PAYMENT_LINK (Razorpay, vendor leg).
export const buybackGatewayKind = pgEnum("buyback_gateway_kind", ["PAYOUT", "PAYMENT_LINK"]);
// E-193 — in-flight: INITIATED/PENDING/QUEUED/PROCESSING. Terminal success:
// PROCESSED (payout) / PAID (link) — the ONLY states that mint a
// settlementTransactions row. Terminal failure: FAILED/REJECTED/CANCELLED/
// EXPIRED. REVERSED is terminal-AFTER-success (bank bounced it after
// processed) — never auto-unwound, a human is alerted.
export const buybackGatewayStatus = pgEnum("buyback_gateway_status", [
  "INITIATED",
  "PENDING",
  "QUEUED",
  "PROCESSING",
  "PROCESSED",
  "PAID",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "REVERSED",
]);

// M12 — two per deal, facing opposite ways: the dealer bills iTarang (we approve
// or return it), and iTarang bills the vendor.
//
// INVARIANT (P5): NO amount column. Amounts live on invoiceLines. That is what
// makes M12's AC expressible at all — "one edited line blocks approval EVEN IF
// THE TOTAL MATCHES". You cannot compare line-by-line against a lump sum.
//
// A RETURNED invoice is kept, with its reason. The partial unique index
// invoices_one_live_per_deal_leg (SQL-only — Drizzle cannot express a partial
// index) allows exactly one LIVE invoice per leg while letting the rejected one
// survive as evidence of what was wrong.
export const invoices = pgTable(
  "invoices",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    leg: buybackLeg().notNull(),
    raised_by_party: buybackInvoiceParty("raised_by_party").notNull(),
    // The DEALER's own number on their own GST series; or ours (INV-5001-V) on
    // the vendor leg. You may not issue a number on someone else's series.
    number: text().notNull(),
    pdf_s3: text("pdf_s3"),
    status: buybackInvoiceStatus().default("RAISED").notNull(),
    approved_by: uuid("approved_by"),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    returned_reason: text("returned_reason"),
    returned_at: timestamp("returned_at", { withTimezone: true }),
    raised_by: uuid("raised_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dealIdx: index("invoices_deal_idx").on(t.deal_id),
  }),
);

// The rows approval compares, ONE AT A TIME, against deal_line_locks.
// `matched` records the verdict per line, so the failing line is still
// identifiable months later.
export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    invoice_id: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id, { onDelete: "cascade" }),
    quantity: integer().notNull(),
    price_per_unit: numeric("price_per_unit", { precision: 12, scale: 2 }).notNull(),
    matched: boolean(),
    // Chirag gate (BRD §10) — modelled, not yet ruled on.
    hsn_code: text("hsn_code"),
    taxable_value: numeric("taxable_value", { precision: 14, scale: 2 }),
    cgst: numeric({ precision: 12, scale: 2 }),
    sgst: numeric({ precision: 12, scale: 2 }),
    igst: numeric({ precision: 12, scale: 2 }),
    reverse_charge: boolean("reverse_charge"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    invoiceLineUnique: uniqueIndex("invoice_lines_invoice_line_unique").on(
      t.invoice_id,
      t.line_id,
    ),
  }),
);

// --- E-196: the Proforma Invoice ------------------------------------------
// A SEPARATE table from `invoices`, which is the TAX slot. A proforma answers
// the vendor's PO before payment; a tax invoice follows payment and needs the
// GST treatment nobody has ruled on. Distinct series, distinct lifecycle, no
// tax columns. See drizzle/E-196.
export const buybackProformaStatus = pgEnum("buyback_proforma_status", [
  "ISSUED",
  "SUPERSEDED",
  "CANCELLED",
]);

export const proformaInvoices = pgTable(
  "proforma_invoices",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    /** The vendor PO this answers. NOT NULL — no PO, no PI. */
    po_id: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id),
    number: text().notNull(), // 'PI-1001-V'
    pdf_s3: text("pdf_s3"),
    status: buybackProformaStatus().default("ISSUED").notNull(),
    /** Server-derived from deal_line_locks.vendor_price (vendorReceipt), never the client. */
    total: numeric({ precision: 14, scale: 2 }).notNull(),
    issued_at: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
    valid_until: timestamp("valid_until", { withTimezone: true }),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    numberUnique: uniqueIndex("proforma_invoices_number_unique").on(t.number),
    poIdx: index("proforma_invoices_po_idx").on(t.po_id),
    // One-live-per-deal is a PARTIAL unique index (WHERE status = 'ISSUED') and
    // lives in the SQL migration — drizzle cannot express the predicate.
  }),
);

export const proformaInvoiceLines = pgTable(
  "proforma_invoice_lines",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    proforma_id: uuid("proforma_id")
      .notNull()
      .references(() => proformaInvoices.id, { onDelete: "cascade" }),
    line_id: uuid("line_id")
      .notNull()
      .references(() => buybackLines.id),
    quantity: integer().notNull(),
    price_per_unit: numeric("price_per_unit", { precision: 12, scale: 2 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineUnique: uniqueIndex("proforma_invoice_lines_unique").on(t.proforma_id, t.line_id),
  }),
);

// M13/U10 — TXN-{n}-D (OUT, dealer payout) + TXN-{n}-V (IN, vendor receipt).
// Both closed ⇒ SETTLED. The difference between them IS the realised margin,
// which is what M14's reconciliation invariant checks against the locks.
//
// INVARIANT (M13 AC): the settlement_manual_needs_proof CHECK constraint (in
// E-187) makes an unevidenced MANUAL payout impossible at the DATABASE level —
// not merely rejected by a route that a script or a backfill could bypass. A
// payment with no proof is not a payment; it is a claim.
//
// Payouts are RECORDED here, never EXECUTED (BRD §10). Razorpay in this codebase
// is inbound-collection-only and cannot pay anyone out.
export const settlementTransactions = pgTable(
  "settlement_transactions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    group_txn_id: text("group_txn_id").notNull(), // 'TXN-1024'
    leg_sub_id: text("leg_sub_id").notNull(), // 'TXN-1024-D' — UNIQUE
    leg: buybackLeg().notNull(),
    direction: buybackSettleDirection().notNull(),
    method: buybackSettleMethod().default("MANUAL").notNull(),
    txn_ref: text("txn_ref"),
    amount: numeric({ precision: 14, scale: 2 }).notNull(),
    txn_date: date("txn_date").notNull(),
    proof_s3: text("proof_s3"),
    note: text(),
    recorded_by: uuid("recorded_by"),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    // --- E-188 ---
    // Traces a STATEMENT settlement back to the bank-statement row that evidenced
    // it. Declared WITHOUT a Drizzle .references(): bank_statement_rows points at
    // settlement_transactions and this points back, which is a genuine circular
    // FK. Both directions exist in the SQL (E-188); expressing only one of them
    // here keeps the TS module free of a cycle.
    statement_row_id: uuid("statement_row_id"),
    /**
     * E-197 — who received this OUT payment, when it was not the dealer.
     *
     * NULL means the dealer (every existing row, and still the default). Set
     * means the battery's previous owner was paid directly, because the dealer
     * brokered a battery they never owned.
     *
     * NOT a new leg: same leg, same amount (the locked dealer_price), different
     * beneficiary — which is why M14 still holds. A driver-AND-dealer SPLIT is a
     * different thing entirely and is deliberately not modelled. A DB CHECK
     * confines this to the DEALER leg: the vendor leg is money IN, so there is
     * no beneficiary to redirect.
     */
    payee_provenance_id: uuid("payee_provenance_id"),
  },
  (t) => ({
    legSubUnique: uniqueIndex("settlement_transactions_leg_sub_unique").on(t.leg_sub_id),
    dealIdx: index("settlement_transactions_deal_idx").on(t.deal_id),
    // E-192 — the ledger route's own filter+sort (ledger/route.ts
    // `WHERE closed_at IS NOT NULL … ORDER BY txn_date DESC`). Partial: open
    // legs are never queried this way.
    txnDateIdx: index("settlement_transactions_txn_date_idx")
      .on(t.txn_date.desc())
      .where(sql`${t.closed_at} is not null`),
    // E-192 — GIN trigram, leading-wildcard admin search (M23).
    legSubIdTrgmIdx: index("settlement_transactions_leg_sub_id_trgm_idx").using(
      "gin",
      t.leg_sub_id.op("gin_trgm_ops"),
    ),
    groupTxnIdTrgmIdx: index("settlement_transactions_group_txn_id_trgm_idx").using(
      "gin",
      t.group_txn_id.op("gin_trgm_ops"),
    ),
    txnRefTrgmIdx: index("settlement_transactions_txn_ref_trgm_idx").using(
      "gin",
      t.txn_ref.op("gin_trgm_ops"),
    ),
  }),
);

// E-193 — the ATTEMPT, not the fact. Holds an in-flight RazorpayX payout or
// Razorpay Payment Link; only a terminal SUCCESS (PROCESSED/PAID) mints a
// settlementTransactions row (method='API'). A FAILED/REJECTED/CANCELLED/
// EXPIRED attempt leaves no settlement — retrying is a NEW row here, never an
// update of this one. REVERSED is terminal-AFTER-success (bank bounced an
// already-processed payout) and is never auto-unwound; a human is alerted.
//
// gatewayTxnOneInflightPerLeg is the race guard: a double-clicked "Pay via
// RazorpayX" cannot create two in-flight attempts for the same (deal, leg).
// The `gateway_amount_positive` CHECK constraint lives on the DB side only
// (E-193 SQL), same as settlement_transactions' CHECKs.
// Source of truth: drizzle/E-193_buyback_gateway_payments.sql.
export const buybackGatewayTransactions = pgTable(
  "buyback_gateway_transactions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    deal_id: uuid("deal_id")
      .notNull()
      .references(() => buybackDeals.id, { onDelete: "cascade" }),
    leg: buybackLeg().notNull(),
    direction: buybackSettleDirection().notNull(),
    kind: buybackGatewayKind().notNull(),
    provider: text().notNull(), // 'RAZORPAYX' | 'RAZORPAY'
    amount: numeric({ precision: 14, scale: 2 }).notNull(), // rupees, server-derived from locks
    status: buybackGatewayStatus().default("INITIATED").notNull(),
    provider_ref: text("provider_ref"), // 'pout_...' / 'plink_...'
    payment_id: text("payment_id"), // 'pay_...' (link leg)
    utr: text(),
    short_url: text("short_url"), // link leg only
    failure_reason: text("failure_reason"),
    raw_payload: jsonb("raw_payload"), // last provider snapshot
    settlement_id: uuid("settlement_id").references(() => settlementTransactions.id), // set on success
    initiated_by: uuid("initiated_by"), // the admin who clicked; audit + webhook actor
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Webhook correlation + the DB-level "same payout applied twice" guard.
    providerRefUnique: uniqueIndex("gateway_txn_provider_ref_unique")
      .on(t.provider_ref)
      .where(sql`${t.provider_ref} is not null`),
    // THE race guard: at most ONE in-flight gateway transaction per (deal, leg).
    oneInflightPerLeg: uniqueIndex("gateway_txn_one_inflight_per_leg")
      .on(t.deal_id, t.leg)
      .where(sql`${t.status} in ('INITIATED','PENDING','QUEUED','PROCESSING')`),
    dealIdx: index("gateway_txn_deal_idx").on(t.deal_id),
    // The poller's scan.
    inflightIdx: index("gateway_txn_inflight_idx")
      .on(t.updated_at)
      .where(sql`${t.status} in ('INITIATED','PENDING','QUEUED','PROCESSING')`),
  }),
);

// ---------------------------------------------------------------------------
// --- PEAKAMP BUYBACK — COMPLIANCE & TRUST (E-188, Sprints 3–4) ---
//
// M03 photo dedup · M05 BWM variance gate · M13 STATEMENT reconcile ·
// M16 versioned price books · M19 Digio agreements.
// Source of truth: drizzle/E-188_buyback_compliance_trust.sql.
// ---------------------------------------------------------------------------

export const buybackAgreementStatus = pgEnum("buyback_agreement_status", [
  "DRAFT",
  "SENT",
  "SIGNED",
  "DECLINED",
  "EXPIRED",
]);
export const buybackStmtRowStatus = pgEnum("buyback_stmt_row_status", [
  "UNMATCHED",
  "SUGGESTED",
  "MATCHED",
  "IGNORED",
]);

// M19/U12 — Digio eSign for dealers AND vendors. The signed webhook flips
// business_entity_roles.status to ACTIVE, which is what actually unlocks
// anything: an entity with no ACTIVE role cannot trade.
//
// An existing dealer of the same firm does NOT redo KYC — they confirm the firm
// registration number and sign. That is why firm_registration_no lives here, on
// the agreement, and there is no second onboarding table.
export const agreements = pgTable(
  "agreements",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    entity_id: varchar("entity_id", { length: 255 })
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: buybackEntityRole().notNull(),
    digio_doc_id: text("digio_doc_id"),
    firm_registration_no: text("firm_registration_no"),
    status: buybackAgreementStatus().default("DRAFT").notNull(),
    pdf_s3: text("pdf_s3"),
    signed_pdf_s3: text("signed_pdf_s3"),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    signed_at: timestamp("signed_at", { withTimezone: true }),
    declined_reason: text("declined_reason"),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    digioIdx: index("agreements_digio_doc_idx").on(t.digio_doc_id),
  }),
);

// M16 — what the price WAS at a given price-book version. The AC ("catalog edits
// never change open requests' reference price") already holds via
// buyback_lines.price_book_version_at_create; this answers the question that
// snapshot alone cannot — what was the price at version 3?
export const catalogPriceHistory = pgTable(
  "catalog_price_history",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    variant_id: uuid("variant_id")
      .notNull()
      .references(() => catalogVariants.id, { onDelete: "cascade" }),
    price_book_version: integer("price_book_version").notNull(),
    unit_price: numeric("unit_price", { precision: 12, scale: 2 }),
    est_buyback_price_working: numeric("est_buyback_price_working", {
      precision: 12,
      scale: 2,
    }),
    est_buyback_price_dead: numeric("est_buyback_price_dead", { precision: 12, scale: 2 }),
    changed_by: uuid("changed_by"),
    note: text(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    variantVersionUnique: uniqueIndex("catalog_price_history_variant_version_unique").on(
      t.variant_id,
      t.price_book_version,
    ),
  }),
);

// When the business last reviewed prices. M16 wants a weekly nudge; without a
// recorded review date, "weekly" is unenforceable.
export const catalogPriceReviews = pgTable("catalog_price_reviews", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  reviewed_by: uuid("reviewed_by"),
  note: text(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// M13/U9 — the STATEMENT method. A matched row becomes a settlement with
// method=STATEMENT, which legitimately carries no uploaded proof FILE: the bank
// statement IS the proof. E-187's CHECK demands a file only for MANUAL, precisely
// so this path does not have to fake one to satisfy a constraint.
export const bankStatementImports = pgTable("bank_statement_imports", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  filename: text().notNull(),
  s3_key: text("s3_key"),
  account_label: text("account_label"),
  row_count: integer("row_count").default(0).notNull(),
  matched_count: integer("matched_count").default(0).notNull(),
  imported_by: uuid("imported_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const bankStatementRows = pgTable(
  "bank_statement_rows",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    import_id: uuid("import_id")
      .notNull()
      .references(() => bankStatementImports.id, { onDelete: "cascade" }),
    txn_date: date("txn_date").notNull(),
    // SIGNED: credits positive, debits negative. Storing the sign rather than a
    // separate direction column means a row cannot claim to be a credit while
    // carrying a debit's amount.
    amount: numeric({ precision: 14, scale: 2 }).notNull(),
    txn_ref: text("txn_ref"),
    description: text(),
    status: buybackStmtRowStatus().default("UNMATCHED").notNull(),
    // What the matcher THINKS this is. Not applied until a human confirms.
    suggested_deal_id: uuid("suggested_deal_id").references(() => buybackDeals.id, {
      onDelete: "set null",
    }),
    suggested_leg: buybackLeg("suggested_leg"),
    matched_settlement_id: uuid("matched_settlement_id").references(
      () => settlementTransactions.id,
      { onDelete: "set null" },
    ),
    matched_by: uuid("matched_by"),
    matched_at: timestamp("matched_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    importIdx: index("bank_statement_rows_import_idx").on(t.import_id),
    refIdx: index("bank_statement_rows_ref_idx").on(t.txn_ref),
  }),
);

// --- E-212: FORGOT PASSWORD ---
//
// Single-use, sha256-hashed password-reset tokens backing the "Forgot
// password?" flow on /login. See drizzle/E-212_password_reset_tokens.sql for
// the full rationale (two password stores, why we don't use Supabase's own
// recovery link). A token is usable iff:
//   used_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // users.id === Supabase auth user id.
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Audit only. NEVER look a user up by this — Supabase lower-cases emails
    // while users.email may be mixed-case and Postgres `=` is case-sensitive.
    email: text().notNull(),
    token_hash: varchar("token_hash", { length: 64 }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    used_at: timestamp("used_at", { withTimezone: true }),
    invalidated_at: timestamp("invalidated_at", { withTimezone: true }),
    requested_ip: varchar("requested_ip", { length: 64 }),
    requested_ua: text("requested_ua"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    hashKey: uniqueIndex("password_reset_tokens_hash_key").on(t.token_hash),
    userCreatedIdx: index("password_reset_tokens_user_created_idx").on(
      t.user_id,
      t.created_at,
    ),
    // password_reset_tokens_live_idx is partial — migration-only, drizzle's
    // builder has no partial-index syntax (same note as E-211).
  }),
);

// --- E-213: IN-APP CHANGE PASSWORD (OTP) ---
//
// 4-digit email OTP sessions for the Change Password modal. See
// drizzle/E-213_password_change_otps.sql for why this is a new table rather
// than a reuse of consent_otp_verifications / calc_otp_verifications /
// otp_confirmations (all three are lead-scoped, and one stores an email in a
// column named `phone`).
//
// A session is usable for verify iff:
//   verified_at IS NULL AND consumed_at IS NULL AND expires_at > now()
// and usable for confirm iff:
//   verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > now()
export const passwordChangeOtps = pgTable(
  "password_change_otps",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // users.id === Supabase auth user id.
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Audit only. NEVER look a user up by this — users.email can be mixed-case.
    email: text().notNull(),
    otp_hash: varchar("otp_hash", { length: 64 }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    send_count: integer("send_count").default(1).notNull(),
    attempt_count: integer("attempt_count").default(0).notNull(),
    locked_until: timestamp("locked_until", { withTimezone: true }),
    verified_at: timestamp("verified_at", { withTimezone: true }),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    delivery_status: varchar("delivery_status", { length: 20 })
      .default("sent")
      .notNull(),
    requested_ip: varchar("requested_ip", { length: 64 }),
    requested_ua: text("requested_ua"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    userCreatedIdx: index("password_change_otps_user_created_idx").on(
      t.user_id,
      t.created_at,
    ),
    // password_change_otps_open_idx and _verified_idx are partial —
    // migration-only, drizzle's builder has no partial-index syntax (same note
    // as E-211/E-212).
  }),
);

// --- E-215: CRM SECURITY SCANNER (standalone agent) ---
//
// A NEW, self-contained security-testing agent: it drives Playwright through
// the CRM (starting at dealer onboarding), actively probes for vulnerabilities,
// and records findings. INDEPENDENT of the NBFC risk engine (risk_hypotheses /
// risk_card_runs / the Python sandbox) — shares no tables, no code. Do not join
// these to the risk_* family. See drizzle/E-215_security_scanner.sql.

// One row per scan. The partial unique index (target_env) WHERE status='running'
// is the single-flight lock (migration-only) — see src/lib/security/scan-run.ts.
export const securityScanRuns = pgTable(
  "security_scan_runs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    target_base_url: text("target_base_url").notNull(),
    // 'local' | 'sandbox' | 'prod' — derived from the URL host.
    target_env: varchar("target_env", { length: 16 }).notNull(),
    // 'safe' | 'aggressive'. safe skips state-mutating probes.
    mode: varchar({ length: 12 }).default("safe").notNull(),
    // 'manual' | 'cron' | 'cli'
    triggered_by: varchar("triggered_by", { length: 12 }).notNull(),
    actor_user_id: uuid("actor_user_id"),
    // 'running' | 'completed' | 'failed'
    status: varchar({ length: 16 }).default("running").notNull(),
    started_at: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    surfaces_walked: integer("surfaces_walked").default(0).notNull(),
    findings_total: integer("findings_total").default(0).notNull(),
    findings_critical: integer("findings_critical").default(0).notNull(),
    findings_high: integer("findings_high").default(0).notNull(),
    findings_medium: integer("findings_medium").default(0).notNull(),
    findings_low: integer("findings_low").default(0).notNull(),
    findings_info: integer("findings_info").default(0).notNull(),
    prompt_tokens: integer("prompt_tokens").default(0).notNull(),
    completion_tokens: integer("completion_tokens").default(0).notNull(),
    error: text("error"),
  },
  (t) => ({
    startedIdx: index("security_scan_runs_started_idx").on(t.started_at),
    // security_scan_runs_env_running_uidx is partial — migration-only.
  }),
);

// Catalogue of checks the agent knows how to run, keyed by slug. Seeded by the
// app on first run.
export const securityChecks = pgTable(
  "security_checks",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: varchar({ length: 64 }).notNull(),
    // 'authz' | 'exposure' | 'injection' | 'upload_headers'
    category: varchar({ length: 24 }).notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    // critical | high | medium | low | info
    default_severity: varchar("default_severity", { length: 12 }).default("medium").notNull(),
    owasp_ref: varchar("owasp_ref", { length: 32 }),
    cwe_ref: varchar("cwe_ref", { length: 16 }),
    // Whether running this check mutates server state (skipped in safe mode).
    mutating: boolean().default(false).notNull(),
    retired_at: timestamp("retired_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugUidx: uniqueIndex("security_checks_slug_uidx").on(t.slug),
  }),
);

// One row per vulnerability the scan surfaced. severity/confidence are set by
// deterministic probe rules, never by the LLM. Open findings are deduped by
// fingerprint (partial unique WHERE status <> 'resolved', migration-only).
export const securityFindings = pgTable(
  "security_findings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    run_id: uuid("run_id")
      .notNull()
      .references(() => securityScanRuns.id, { onDelete: "cascade" }),
    check_slug: varchar("check_slug", { length: 64 }).notNull(),
    category: varchar({ length: 24 }).notNull(),
    // critical | high | medium | low | info
    severity: varchar({ length: 12 }).notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    target_url: text("target_url").notNull(),
    http_method: varchar("http_method", { length: 8 }),
    evidence_json: jsonb("evidence_json"),
    reproduction: text("reproduction"),
    remediation: text("remediation"),
    owasp_ref: varchar("owasp_ref", { length: 32 }),
    cwe_ref: varchar("cwe_ref", { length: 16 }),
    // 'confirmed' | 'likely' | 'possible'
    confidence: varchar({ length: 10 }).default("possible").notNull(),
    // 'open' | 'acknowledged' | 'resolved' | 'false_positive'
    status: varchar({ length: 16 }).default("open").notNull(),
    fingerprint: varchar({ length: 64 }).notNull(),
    acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    llm_model: varchar("llm_model", { length: 64 }),
    prompt_tokens: integer("prompt_tokens"),
    completion_tokens: integer("completion_tokens"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // E-218: resolution bookkeeping — filled when a finding is resolved via the
    // AI resolution chat (auto-apply) or the manual triage buttons.
    resolution_summary: text("resolution_summary"),
    resolution_report: jsonb("resolution_report"),
    resolved_by: uuid("resolved_by"),
    // 'auto_apply' | 'manual'
    resolution_method: varchar("resolution_method", { length: 16 }),
    // E-219: denormalised origin of the LATEST resolution, so the History tab
    // renders "resolved by X from IP Y" without a join. The full append-only
    // trail lives in security_finding_actions.
    resolved_ip: varchar("resolved_ip", { length: 64 }),
    resolved_user_agent: text("resolved_user_agent"),
    resolved_by_email: text("resolved_by_email"),
  },
  (t) => ({
    runIdx: index("security_findings_run_idx").on(t.run_id),
    severityIdx: index("security_findings_severity_idx").on(t.severity),
    statusIdx: index("security_findings_status_idx").on(t.status),
    // security_findings_open_fingerprint_uidx is partial — migration-only.
  }),
);

// E-218 — per-finding AI remediation chat. One row per turn (mirrors
// conversation_messages). An assistant turn that proposes an applyable edit
// carries proposed_fix = { file, search, replace, explanation }; the Resolve
// step applies it to disk as a deterministic single-occurrence replacement.
export const securityFindingMessages = pgTable(
  "security_finding_messages",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    finding_id: uuid("finding_id")
      .notNull()
      .references(() => securityFindings.id, { onDelete: "cascade" }),
    // 'user' | 'assistant' | 'system'
    role: text().notNull(),
    message: text().notNull(),
    proposed_fix: jsonb("proposed_fix"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    findingIdx: index("security_finding_messages_finding_idx").on(t.finding_id, t.created_at),
  }),
);

// E-219 — append-only triage/resolution audit trail per finding. One row per
// action (acknowledged | resolved | false_positive | reopened | auto_apply) with
// the actor AND the request origin it came from (ip/user_agent). A reopen adds a
// row rather than erasing history, so the History tab can show the full story.
export const securityFindingActions = pgTable(
  "security_finding_actions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    finding_id: uuid("finding_id")
      .notNull()
      .references(() => securityFindings.id, { onDelete: "cascade" }),
    // 'acknowledged' | 'resolved' | 'false_positive' | 'reopened' | 'auto_apply'
    action: varchar({ length: 24 }).notNull(),
    // 'auto_apply' | 'manual' | null
    method: varchar({ length: 16 }),
    actor_user_id: uuid("actor_user_id"),
    actor_email: text("actor_email"),
    actor_role: varchar("actor_role", { length: 32 }),
    ip: varchar({ length: 64 }),
    user_agent: text("user_agent"),
    summary: text("summary"),
    detail: jsonb("detail"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    findingIdx: index("security_finding_actions_finding_idx").on(t.finding_id, t.created_at),
    actionIdx: index("security_finding_actions_action_idx").on(t.action, t.created_at),
    ipIdx: index("security_finding_actions_ip_idx").on(t.ip),
  }),
);

// --- E-216: LIVE-ATTACK EVENT LOG (runtime intrusion detection) ---
//
// Companion to E-215's scanner. One row per suspicious request caught in real
// time by the detection layer in src/middleware.ts. Written via the Node route
// POST /api/internal/security-events (Edge middleware can't reach Postgres).
// See drizzle/E-216_security_events.sql.
export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    // Payload rules (src/lib/security/detect.ts):
    //   'sql_injection' | 'xss' | 'path_traversal' | 'null_byte' | 'scanner_ua'
    //   | 'sensitive_unauth' | 'command_injection' | 'ssrf' | 'lfi_rfi'
    //   | 'jndi_injection' | 'nosql_injection' | 'crlf_injection'
    //   | 'proto_pollution' | 'xxe' | 'open_redirect' | 'sensitive_file_probe'
    //   | 'method_abuse'
    // Volumetric rules (src/lib/security/rate-watch.ts):
    //   'rate_flood' | 'path_enumeration' | 'auth_bruteforce'
    // Auto-block (src/lib/security/blocklist.ts):
    //   'ip_blocked' — a request refused because its source IP is under a ban
    // Legacy: 'burst'
    event_type: varchar("event_type", { length: 32 }).notNull(),
    // critical | high | medium | low | info
    severity: varchar({ length: 12 }).notNull(),
    // 'blocked' | 'logged'
    action: varchar({ length: 12 }).default("logged").notNull(),
    ip: varchar({ length: 64 }),
    actor_user_id: uuid("actor_user_id"),
    actor_role: varchar("actor_role", { length: 32 }),
    method: varchar({ length: 8 }),
    path: text("path").notNull(),
    query: text("query"),
    user_agent: text("user_agent"),
    matched_rule: varchar("matched_rule", { length: 64 }),
    // The rule's matched payload, plus request context under fixed keys:
    //   net (source-IP provenance + proxy chain) | client (sender fingerprint)
    //   | geo | request | flags | ban | body_sample | provenance (detector-raised
    //   vs hand-POSTed — decides whether `ip` is observed or merely claimed).
    // Written by src/middleware.ts via src/lib/security/fingerprint.ts.
    evidence: jsonb("evidence"),
    // 'new' | 'reviewed' | 'ignored'
    status: varchar({ length: 16 }).default("new").notNull(),
    alerted_at: timestamp("alerted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    occurredIdx: index("security_events_occurred_idx").on(t.occurred_at),
    severityIdx: index("security_events_severity_idx").on(t.severity),
    ipOccurredIdx: index("security_events_ip_occurred_idx").on(t.ip, t.occurred_at),
    statusIdx: index("security_events_status_idx").on(t.status),
    // E-217 — the volumetric rules grow this table much faster, and the
    // dashboard filters by attack type.
    typeOccurredIdx: index("security_events_type_occurred_idx").on(t.event_type, t.occurred_at),
  }),
);

// ── E-224: NeoDove ⇄ iTarang two-way lead sync ─────────────────────────────
//
// NeoDove has no read API. Its whole programmable surface is a per-campaign
// "Custom Integration" endpoint we POST leads to (the URL *is* the credential —
// no key or header auth exists) plus Workflows → Send Webhook firing back at us
// on lead created / call connected / call not connected. Nothing can be queried.
//
// Deliberately NOT folded into dialer_campaigns: that table drives the AI voice
// dialer (advanceCampaign claims rows FOR UPDATE SKIP LOCKED and places real
// Bolna calls; /api/cron/ai-dialer sweeps for status='running'). A NeoDove row
// parked there would eventually be robot-dialled against an audience meant for
// human agents. The two are UNIONed at the API layer instead.
//
// See drizzle/E-224_neodove_integration.sql.

export const neodoveCampaigns = pgTable(
  "neodove_campaigns",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    // The campaign's name in the NeoDove UI. Free text because NeoDove exposes
    // no campaign id over any API — this is the only human-checkable link.
    neodove_campaign_name: text("neodove_campaign_name"),
    // NAME of the env var holding the Custom Integration URL, never the URL.
    // That URL is the only credential NeoDove issues, so a DB read must not
    // confer write access to their system.
    push_endpoint_ref: text("push_endpoint_ref"),
    update_endpoint_ref: text("update_endpoint_ref"),
    // Same RegionSelection shape the AI-dialer start modal already emits, so
    // the existing audience builder is reused unchanged.
    audience_filter: jsonb("audience_filter"),
    // E-225: human-recorded mirror of the campaign's settings INSIDE NeoDove
    // (pipeline, managing user, agents, lead distribution). DESCRIPTIVE ONLY —
    // NeoDove has neither a campaign-creation nor a read API, so this can only
    // ever be what somebody observed in their UI. Writing it changes nothing on
    // their side, and the form says so on every field.
    // Safe to mirror here despite E-225 possibly being unapplied: every access
    // to this table is raw `sql`, so no bare db.select().from() can break.
    mirror_config: jsonb("mirror_config"),
    // E-226: marks the ONE campaign the per-lead "Call now" action pushes into.
    // A partial unique index (not expressible here) enforces the "at most one"
    // half. NeoDove has no dial API — what makes such a lead urgent is the
    // NeoDove-side lead distribution on that campaign, not anything we send.
    // Safe to mirror despite E-226 possibly being unapplied for the same reason
    // mirror_config is: every access to this table is raw `sql`.
    is_priority_dial: boolean("is_priority_dial").default(false).notNull(),
    // E-237: the CRM user who should own leads pushed into this campaign — the
    // CRM-side counterpart of the NeoDove campaign-member assignment, which has
    // no API and can be neither read nor written from here. ACTED ON (a push
    // assigns to it), unlike the purely descriptive mirror_config above.
    // text, matching dealer_leads.current_owner_id, so the two owner columns
    // compare directly; users.id is uuid, hence every join's ::text cast.
    // Safe to mirror despite E-237 possibly being unapplied for the same reason
    // mirror_config is: every access to this table is raw `sql`. Reads still go
    // through to_jsonb, because a missing column fails at PARSE time.
    crm_owner_user_id: text("crm_owner_user_id"),
    // draft | pushing | active | paused | completed
    status: varchar({ length: 20 }).default("draft").notNull(),
    total_pushed: integer("total_pushed").default(0).notNull(),
    push_failed: integer("push_failed").default(0).notNull(),
    dispositions_received: integer("dispositions_received").default(0).notNull(),
    created_by: uuid("created_by"),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index("neodove_campaigns_status_idx").on(t.status, t.created_at),
    createdByIdx: index("neodove_campaigns_created_by_idx").on(t.created_by, t.created_at),
  }),
);

// One row per (lead, campaign). A lead can legitimately sit in several NeoDove
// campaigns over time, so this cannot be columns on dealer_leads without
// collapsing to the most recent push and destroying the per-campaign counters.
// dealer_lead_id is a soft FK, matching the dialer_campaign_leads precedent.
export const neodoveLeadLinks = pgTable(
  "neodove_lead_links",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    dealer_lead_id: text("dealer_lead_id").notNull(),
    neodove_campaign_id: text("neodove_campaign_id")
      .notNull()
      .references(() => neodoveCampaigns.id, { onDelete: "cascade" }),
    // NeoDove's own lead id, IF its create response returns one — unknown until
    // the contract is probed. When absent the inbound handler falls back to
    // matching on normalised phone.
    neodove_lead_id: text("neodove_lead_id"),
    // pending | pushed | failed | skipped_dedup | skipped_excluded
    push_status: varchar("push_status", { length: 24 }).default("pending").notNull(),
    push_error: text("push_error"),
    pushed_at: timestamp("pushed_at", { withTimezone: true }),
    // E-237: who this push assigned the lead to in the CRM, and when.
    // Historical by design — NOT kept in step with dealer_leads.current_owner_id
    // if the lead is reassigned later, because the question these answer is
    // "what did this campaign hand over", which a later reassignment must not
    // rewrite. Also the only place the outcome survives: push-batch acks before
    // its drain runs, so the count cannot travel in the HTTP response.
    assigned_owner_id: text("assigned_owner_id"),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),
    last_event_at: timestamp("last_event_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    campaignStatusIdx: index("neodove_lead_links_campaign_status_idx").on(
      t.neodove_campaign_id,
      t.push_status,
    ),
    leadIdx: index("neodove_lead_links_lead_idx").on(t.dealer_lead_id, t.last_event_at),
  }),
);

// Append-only ledger, both directions. NOT a debug log: because NeoDove cannot
// be queried, a dropped webhook is unrecoverable — this table is what a NeoDove
// CSV export is diffed against to find and backfill the gap.
// The partial unique index on external_event_id (inbound only) is the
// idempotency guard; see the migration.
export const neodoveSyncEvents = pgTable(
  "neodove_sync_events",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    // 'outbound' (we pushed) | 'inbound' (NeoDove called us)
    direction: varchar({ length: 10 }).notNull(),
    event_type: varchar("event_type", { length: 50 }),
    neodove_campaign_id: text("neodove_campaign_id"),
    dealer_lead_id: text("dealer_lead_id"),
    // NeoDove's event id. Idempotency key for inbound deliveries, and the value
    // written to lead_touchpoints.external_event_id — whose own partial unique
    // index (E-113) is the second, independent line of defence against replay.
    external_event_id: text("external_event_id"),
    http_status: integer("http_status"),
    request_payload: jsonb("request_payload"),
    response_payload: jsonb("response_payload"),
    error: text("error"),
    attempts: integer("attempts").default(0).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    campaignIdx: index("neodove_sync_events_campaign_idx").on(
      t.neodove_campaign_id,
      t.created_at,
    ),
    leadIdx: index("neodove_sync_events_lead_idx").on(t.dealer_lead_id, t.created_at),
  }),
);

// module_usage_user_daily is declared ONCE, further down with the ops-console
// tables (E-216_module_usage_user_daily). The E-251 mirror that used to sit here
// was written when nothing referenced the table; the /operations/usage drill-down
// now reads and writes it, so the live declaration is the authoritative one.

// ---------------------------------------------------------------------------
// E-255 — Google Drive mirror ledger.
//
// One row per S3 object (logical bucket + key), written the moment an object
// lands in S3 (see src/lib/storage/s3.ts → drive-mirror.ts) and by the backfill
// sweep for objects that pre-date the feature. Nothing in the app READS
// documents through this table — the S3 copy remains the served one; this is
// the queue + receipt for the Drive backup copy.
// ---------------------------------------------------------------------------
export const storageDriveMirror = pgTable(
  "storage_drive_mirror",
  {
    id: bigserial("id", { mode: "number" }).primaryKey().notNull(),
    bucket: varchar("bucket", { length: 64 }).notNull(),
    object_key: text("object_key").notNull(),
    content_type: varchar("content_type", { length: 255 }),
    size_bytes: bigint("size_bytes", { mode: "number" }),
    // pending | uploading | done | failed | source_deleted
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    drive_file_id: text("drive_file_id"),
    drive_folder_id: text("drive_folder_id"),
    drive_web_view_link: text("drive_web_view_link"),
    drive_md5: text("drive_md5"),
    last_error: text("last_error"),
    mirrored_at: timestamp("mirrored_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bucketKeyUq: uniqueIndex("storage_drive_mirror_bucket_key_uq").on(t.bucket, t.object_key),
    dueIdx: index("storage_drive_mirror_due_idx").on(t.status, t.next_attempt_at),
    statusIdx: index("storage_drive_mirror_status_idx").on(t.status),
  }),
);

/**
 * [E-259] Per-NBFC scrap payment term — WHEN iTarang pays for a consignment.
 *
 * 'pre_lot' pays before the batteries arrive, 'post_lot' only once they are
 * marked received. Absence of a row is meaningful and is NOT backfilled: an
 * NBFC nobody has decided about is read as post_lot, the safer of the two.
 *
 * The CHECK constraint on payment_timing lives in the migration; the
 * vocabulary that mirrors it is SCRAP_PAYMENT_TIMINGS in
 * src/lib/nbfc/scrap/payment-settings.ts.
 */
export const nbfcScrapPaymentSettings = pgTable(
  "nbfc_scrap_payment_settings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenant_id: uuid("tenant_id").notNull(),
    payment_timing: varchar("payment_timing", { length: 16 })
      .notNull()
      .default("post_lot"),
    note: text("note"),
    updated_by: uuid("updated_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantUnique: uniqueIndex("nbfc_scrap_payment_settings_tenant_uidx").on(
      table.tenant_id,
    ),
  }),
);

// --- OPS CONSOLE (E-210) ---
//
// The monitoring spine behind /operations. Mirrors
// drizzle/E-210_ops_monitoring.sql — that file is the source of truth; these
// declarations exist so type-checking matches the DB.
//
// The partial unique indexes below are load-bearing concurrency control, not
// decoration:
//   · ops_collector_runs (collector_id) WHERE status='running'  — single-flight lock
//   · ops_alerts (metric_key, source) WHERE resolved_at IS NULL — alert dedup

export const opsMetricSamples = pgTable(
  "ops_metric_samples",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // Stable, dot-namespaced, e.g. "host.prod.disk_used_pct". Matches a
    // MetricDef.key in src/lib/operations/registry.ts.
    metric_key: varchar("metric_key", { length: 120 }).notNull(),
    // "host:prod" | "rds:crm" | "vendor:elevenlabs" | …
    source: varchar({ length: 80 }).notNull(),
    captured_at: timestamp("captured_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // numeric throughout: money is INR paise, bytes are bytes, percents 0-100.
    value_num: numeric("value_num", { precision: 20, scale: 4 }),
    value_text: text("value_text"),
    meta: jsonb(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    keyCapturedIdx: index("ops_metric_samples_key_captured_idx").on(
      table.metric_key,
      table.captured_at,
    ),
    capturedIdx: index("ops_metric_samples_captured_idx").on(table.captured_at),
  }),
);

export const opsDailySnapshots = pgTable(
  "ops_daily_snapshots",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    snapshot_date: date("snapshot_date").notNull(),
    metric_key: varchar("metric_key", { length: 120 }).notNull(),
    source: varchar({ length: 80 }).notNull(),
    // Representative value for the day (last sample); min/max/avg describe the
    // spread, so a disk that spiked at 03:00 and settled is still visible.
    value_num: numeric("value_num", { precision: 20, scale: 4 }),
    value_min: numeric("value_min", { precision: 20, scale: 4 }),
    value_max: numeric("value_max", { precision: 20, scale: 4 }),
    value_avg: numeric("value_avg", { precision: 20, scale: 4 }),
    sample_count: integer("sample_count").default(0).notNull(),
    meta: jsonb(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // What makes runDailySnapshot() re-runnable for the same date.
    dateKeySourceUniq: uniqueIndex(
      "ops_daily_snapshots_date_key_source_uniq",
    ).on(table.snapshot_date, table.metric_key, table.source),
    keyDateIdx: index("ops_daily_snapshots_key_date_idx").on(
      table.metric_key,
      table.snapshot_date,
    ),
  }),
);

export const opsCollectorRuns = pgTable(
  "ops_collector_runs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    collector_id: varchar("collector_id", { length: 80 }).notNull(),
    // 'ticker' | 'manual'. NOT named "trigger" — reserved word in Postgres.
    triggered_by: varchar("triggered_by", { length: 16 }).notNull(),
    actor_user_id: uuid("actor_user_id"),
    status: varchar({ length: 16 }).default("running").notNull(), // running|completed|failed
    started_at: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    duration_ms: integer("duration_ms"),
    samples_written: integer("samples_written").default(0).notNull(),
    error: text(),
  },
  (table) => ({
    // THE LOCK. At most one running row per collector — see E-210 and
    // src/lib/operations/runner.ts, which catches the 23505 this raises.
    oneActiveIdx: uniqueIndex("ops_collector_runs_one_active_idx")
      .on(table.collector_id)
      .where(sql`status = 'running'`),
    collectorStartedIdx: index("ops_collector_runs_collector_started_idx").on(
      table.collector_id,
      table.started_at,
    ),
    startedIdx: index("ops_collector_runs_started_idx").on(table.started_at),
  }),
);

export const opsLogEvents = pgTable(
  "ops_log_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    host: varchar({ length: 32 }).notNull(), // prod | sandbox | iot
    service: varchar({ length: 120 }).notNull(), // pm2 process name, or 'nginx'
    level: varchar({ length: 16 }).notNull(), // error | warn | info
    message: text().notNull(), // truncated to 2000 chars at ingest
    logged_at: timestamp("logged_at", { withTimezone: true }).notNull(),
    // Hash of service + level + normalised message, so the UI groups repeats.
    fingerprint: varchar({ length: 64 }).notNull(),
    meta: jsonb(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    loggedIdx: index("ops_log_events_logged_idx").on(table.logged_at),
    levelLoggedIdx: index("ops_log_events_level_logged_idx").on(
      table.level,
      table.logged_at,
    ),
    fingerprintIdx: index("ops_log_events_fingerprint_idx").on(
      table.fingerprint,
    ),
    hostLoggedIdx: index("ops_log_events_host_logged_idx").on(
      table.host,
      table.logged_at,
    ),
  }),
);

export const opsAlertRules = pgTable(
  "ops_alert_rules",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    metric_key: varchar("metric_key", { length: 120 }).notNull(),
    // '*' = any source, so one rule covers prod/sandbox/iot.
    source: varchar({ length: 80 }).default("*").notNull(),
    // 'gt' = breach when value > threshold (lower_is_better metrics);
    // 'lt' = breach when value < threshold (higher_is_better metrics).
    comparator: varchar({ length: 4 }).default("gt").notNull(),
    warn_threshold: numeric("warn_threshold", { precision: 20, scale: 4 }),
    crit_threshold: numeric("crit_threshold", { precision: 20, scale: 4 }),
    enabled: boolean().default(true).notNull(),
    cooldown_minutes: integer("cooldown_minutes").default(60).notNull(),
    notify_channels: jsonb("notify_channels")
      .default(sql`'["inapp"]'::jsonb`)
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    keySourceUniq: uniqueIndex("ops_alert_rules_key_source_uniq").on(
      table.metric_key,
      table.source,
    ),
  }),
);

export const opsAlerts = pgTable(
  "ops_alerts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    rule_id: uuid("rule_id"),
    metric_key: varchar("metric_key", { length: 120 }).notNull(),
    source: varchar({ length: 80 }).notNull(),
    severity: varchar({ length: 8 }).notNull(), // warn | crit
    value_num: numeric("value_num", { precision: 20, scale: 4 }),
    threshold: numeric({ precision: 20, scale: 4 }),
    message: text().notNull(),
    opened_at: timestamp("opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),
    notified_at: timestamp("notified_at", { withTimezone: true }),
    acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledged_by: uuid("acknowledged_by"),
    status: varchar({ length: 16 }).default("open").notNull(), // open|acknowledged|resolved
  },
  (table) => ({
    // Dedup: only one OPEN alert per (metric_key, source). Same trick
    // telemetry_alerts uses — a flapping metric cannot spawn duplicate rows.
    openUniq: uniqueIndex("ops_alerts_open_uniq")
      .on(table.metric_key, table.source)
      .where(sql`resolved_at IS NULL`),
    openedIdx: index("ops_alerts_opened_idx").on(table.opened_at),
    statusOpenedIdx: index("ops_alerts_status_opened_idx").on(
      table.status,
      table.opened_at,
    ),
  }),
);

// --- USAGE ANALYTICS (E-214) ---
//
// The storage behind /operations/usage. Mirrors drizzle/E-214_usage_analytics.sql
// — that file is the source of truth; these declarations exist so type-checking
// matches the DB.
//
// SCOPE, because these are the only per-person tables in the codebase:
// what is recorded is that somebody signed in, and that a session was alive at a
// point in time. NOT recorded, deliberately: IP, user-agent, page paths, search
// terms, or failed attempts. Retention is 90 days (logins) / 30 days (sessions),
// enforced by runDailySnapshot(). Only AGGREGATES survive in ops_daily_snapshots
// — no per-person row is ever written to the metric series. See the migration
// header for the full reasoning, and route-guard.ts for who may read it.
//
// user_activity_sessions also carries storage parameters (fillfactor 80 +
// autovacuum tuning) that Drizzle cannot express. Their absence here is
// expected, not drift — see the migration.

export const userLoginEvents = pgTable(
  "user_login_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // No .references(): follows the audit_logs.performed_by convention so a
    // deleted user cannot cascade away or block on historical rows.
    user_id: uuid("user_id").notNull(),
    /** Role AT THE TIME — a promotion must not rewrite history. */
    role_at_login: varchar("role_at_login", { length: 50 }),
    /** 'password' today; reserved for sso | magic_link | impersonation. */
    method: varchar({ length: 24 }).default("password").notNull(),
    occurred_at: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    occurredIdx: index("user_login_events_occurred_idx").on(table.occurred_at),
    userOccurredIdx: index("user_login_events_user_occurred_idx").on(
      table.user_id,
      table.occurred_at,
    ),
  }),
);

export const userActivitySessions = pgTable(
  "user_activity_sessions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    user_id: uuid("user_id").notNull(),
    /** Client-minted, held in localStorage. The unique index below is what
     *  makes the heartbeat an idempotent upsert rather than an append. */
    session_id: uuid("session_id").notNull(),
    role_at_start: varchar("role_at_start", { length: 50 }),
    started_at: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Heartbeats received. engaged = LEAST(ping_count*300, span+300). */
    ping_count: integer("ping_count").default(1).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sessionUniq: uniqueIndex("user_activity_sessions_session_uniq").on(
      table.session_id,
    ),
    lastSeenIdx: index("user_activity_sessions_last_seen_idx").on(
      table.last_seen_at,
    ),
    userStartedIdx: index("user_activity_sessions_user_started_idx").on(
      table.user_id,
      table.started_at,
    ),
  }),
);

/**
 * E-215. Per-module usage counters.
 *
 * NOTE THE ABSENCE OF user_id. It is not an oversight and it is not a column
 * waiting to be added — the whole design of E-215 rests on this table being
 * incapable of answering "which modules does this person use". Anyone reaching
 * for a `.user_id` here should read the migration header first.
 *
 * `module` intentionally carries no CHECK/enum: an unrecognised label must land
 * as 'other' and be visible rather than fail a heartbeat. The allow-list is
 * enforced in normaliseModule() in src/lib/usage/track.ts.
 *
 * Storage parameters (fillfactor 70 + autovacuum tuning) are set by the
 * migration and cannot be expressed in Drizzle. Their absence here is expected
 * and is NOT drift — same situation as user_activity_sessions above.
 */
export const moduleUsageDaily = pgTable(
  "module_usage_daily",
  {
    /** IST, matching every other day boundary in the console. */
    day: date().notNull(),
    /** One of MODULES in src/lib/usage/constants.ts, or 'other'. */
    module: varchar({ length: 32 }).notNull(),
    /** 'internal' | 'external' — never the role. See the E-215 header. */
    role_bucket: varchar("role_bucket", { length: 16 }).notNull(),
    /** Heartbeats attributed here. pings * 300 ≈ engaged seconds. */
    pings: integer().default(0).notNull(),
    /** Distinct sessions, deduped via moduleVisitKeys. */
    sessions: integer().default(0).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.day, table.module, table.role_bucket],
    }),
    dayIdx: index("module_usage_daily_day_idx").on(table.day),
  }),
);

/**
 * E-216. Per-user module usage — grain (day, module, user_id).
 *
 * The per-person counterpart to moduleUsageDaily, which it does NOT replace:
 * the aggregate is permanent, this is pruned to 30 days, so only the aggregate
 * can answer a question about last quarter. Both are written by ONE statement in
 * recordModuleUsage() so they cannot disagree.
 *
 * This reverses E-215's no-user_id design by explicit product decision — read
 * the E-216 header before extending it. It is read-audited via recordUsageView()
 * and pruned by runDailySnapshot(), matching the userActivitySessions
 * conventions rather than the aggregate's.
 *
 * Storage parameters (fillfactor 70 + autovacuum tuning) are set by the
 * migration and cannot be expressed in Drizzle — expected, not drift.
 */
export const moduleUsageUserDaily = pgTable(
  "module_usage_user_daily",
  {
    /** IST, matching moduleUsageDaily so the two join on `day` directly. */
    day: date().notNull(),
    /** One of MODULES in src/lib/usage/constants.ts, or 'other'. */
    module: varchar({ length: 32 }).notNull(),
    /** No FK — same convention as auditLogs.performed_by. */
    user_id: uuid("user_id").notNull(),
    /** Role AT PING TIME, so a later promotion cannot rewrite history. */
    role_at_ping: varchar("role_at_ping", { length: 48 }),
    /** 'internal' | 'external', stored so it cannot drift from the aggregate. */
    role_bucket: varchar("role_bucket", { length: 16 }).notNull(),
    /** Heartbeats attributed to this person here. pings * 300 ≈ seconds. */
    pings: integer().default(0).notNull(),
    /** Distinct sessions, deduped via moduleVisitKeys. */
    sessions: integer().default(0).notNull(),
    /** Anchor for the 240s guard that E-215's write path lacked. */
    last_ping_at: timestamp("last_ping_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.day, table.module, table.user_id] }),
    dayIdx: index("module_usage_user_daily_day_idx").on(table.day),
    moduleIdx: index("module_usage_user_daily_module_idx").on(
      table.module,
      table.day,
    ),
    userIdx: index("module_usage_user_daily_user_idx").on(
      table.user_id,
      table.day,
    ),
  }),
);

/**
 * E-215. Two-day dedupe behind moduleUsageDaily.sessions.
 *
 * Holds md5(session_id, module, day) and nothing else. Not anonymised — see the
 * "RESIDUAL EXPOSURE" note in the migration header before describing it as
 * such. Pruned by runDailySnapshot().
 *
 * NOT an attribution source. It resolves only to a session's owner, which on
 * live data was wrong for every row tested — see the E-216 header.
 */
export const moduleVisitKeys = pgTable(
  "module_visit_keys",
  {
    visit_key: char("visit_key", { length: 32 }).primaryKey().notNull(),
    /** In the clear only so the prune can range-scan. */
    day: date().notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    dayIdx: index("module_visit_keys_day_idx").on(table.day),
  }),
);
