import {
  pgTable,
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
  date,
  serial,
  bigserial,
  primaryKey,
  unique,
  customType,
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

export const inventory = pgTable("inventory", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  oem_id: varchar("oem_id", { length: 255 }),
  oem_name: text("oem_name"),
  product_catalog_id: varchar("product_catalog_id", { length: 255 }),
  hsn_code: varchar("hsn_code", { length: 8 }),
  asset_category: varchar("asset_category", { length: 20 }).notNull(),
  asset_type: varchar("asset_type", { length: 50 }).notNull(),
  model_type: text("model_type").notNull(),
  serial_number: varchar("serial_number", { length: 255 }),
  is_serialized: boolean("is_serialized").default(true).notNull(),
  warranty_months: integer("warranty_months").default(0).notNull(),
  status: varchar({ length: 30 }).default('in_stock').notNull(),
  batch_number: varchar("batch_number", { length: 100 }),
  received_date: timestamp("received_date", { withTimezone: true }),
  pdi_status: varchar("pdi_status", { length: 20 }).default('pending'),
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
  inventory_amount: numeric("inventory_amount", { precision: 12, scale:  2 }),
  gst_percent: numeric("gst_percent", { precision: 5, scale:  2 }),
  gst_amount: numeric("gst_amount", { precision: 12, scale:  2 }),
  final_amount: numeric("final_amount", { precision: 12, scale:  2 }),
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
  linked_lead_id: varchar("linked_lead_id", { length: 255 }),
  dispatch_date: timestamp("dispatch_date", { withTimezone: true }),
  soc_percent: numeric("soc_percent", { precision: 5, scale:  2 }),
  soc_last_sync_at: timestamp("soc_last_sync_at", { withTimezone: true }),
});

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
  interim_step_status: varchar("interim_step_status", { length: 20 }).default('pending'),
  kyc_draft_data: jsonb("kyc_draft_data"),
  step_status: jsonb("step_status"),
  source: varchar({ length: 50 }),
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
});

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

export const accounts = pgTable("accounts", {
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
  dealer_code: varchar("dealer_code", { length: 50 }),
  contact_name: text("contact_name"),
  contact_email: text("contact_email"),
  contact_phone: varchar("contact_phone", { length: 20 }),
  status: varchar({ length: 20 }).default('active').notNull(),
  onboarding_status: varchar("onboarding_status", { length: 30 }).default('pending').notNull(),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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
    call_id: varchar("call_id", { length: 255 }).notNull(),
  },
  (table) => {
    return {
      aiCallLogsLeadIdIdx: index("ai_call_logs_lead_id_idx").on(table.lead_id),
      aiCallLogsCallIdIdx: index("ai_call_logs_call_id_idx").on(table.call_id),
    };
  },
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
  consent_link_expires_at: timestamp("consent_link_expires_at", { withTimezone: true }),
  consent_delivery_channel: varchar("consent_delivery_channel", { length: 20 }),
  sign_method: varchar("sign_method", { length: 30 }),
  esign_transaction_id: varchar("esign_transaction_id", { length: 255 }),
  esign_certificate_id: varchar("esign_certificate_id", { length: 255 }),
  esign_provider: varchar("esign_provider", { length: 50 }),
  esign_error_code: varchar("esign_error_code", { length: 50 }),
  esign_error_message: text("esign_error_message"),
  signer_aadhaar_masked: varchar("signer_aadhaar_masked", { length: 20 }),
  rejected_by: uuid("rejected_by"),
  rejected_at: timestamp("rejected_at", { withTimezone: true }),
  rejection_reason: varchar("rejection_reason", { length: 255 }),
  reviewer_notes: text("reviewer_notes"),
  consent_attempt_count: integer("consent_attempt_count").default(0),
  esign_retry_count: integer("esign_retry_count").default(0),
  admin_viewed_by: uuid("admin_viewed_by"),
  admin_viewed_at: timestamp("admin_viewed_at", { withTimezone: true }),
});

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
  document_name: text("document_name"),
  document_url: text("document_url"),
  status: varchar({ length: 20 }).default('pending'),
});

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
  status: varchar({ length: 20 }).default('active'),
  installed_at: timestamp("installed_at", { withTimezone: true }),
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
    gst_number: text("gst_number"),
    pan_number: text("pan_number"),
    cin_number: text("cin_number"),
    finance_enabled: boolean("finance_enabled").default(false),
    onboarding_status: varchar("onboarding_status", { length: 30 }).default('draft').notNull(),
    review_status: varchar("review_status", { length: 30 }).default('pending'),
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
    provider_raw_response: jsonb("provider_raw_response"),
    signed_agreement_url: text("signed_agreement_url"),
    audit_trail_url: text("audit_trail_url"),
    owner_landline: varchar("owner_landline", { length: 20 }),
    agreement_language: varchar("agreement_language", { length: 30 }).default('english').notNull(),
    is_branch_dealer: boolean("is_branch_dealer").default(false).notNull(),
    stamp_certificate_ids: jsonb("stamp_certificate_ids").default([]),
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
  },
  (table) => ({
    applicationIdIdx: index("dealer_onboarding_documents_application_id_idx").on(
      table.application_id,
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
});

export const scraperRunChunks = pgTable("scraper_run_chunks", {
  id: text().primaryKey().notNull(),
  run_id: text("run_id").notNull(),
  combination_query: text("combination_query").notNull(),
  status: text().default('pending').notNull(),
  leads_count: integer("leads_count").default(0),
  error_message: text("error_message"),
  created_at: timestamp("created_at").defaultNow(),
  completed_at: timestamp("completed_at"),
});

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
  phone: text(),
  language: text(),
  follow_up_history: jsonb("follow_up_history").default([]),
  current_status: text("current_status"),
  total_attempts: integer("total_attempts").default(0),
  final_intent_score: integer("final_intent_score").default(0),
  created_at: timestamp("created_at").defaultNow(),
  location: text(),
  memory: jsonb(),
  next_call_at: timestamp("next_call_at"),
  shop_name: text("shop_name"),
  overall_summary: text("overall_summary"),
  assigned_to: text("assigned_to"),
  approved_by: text("approved_by"),
  rejected_by: text("rejected_by"),
  dealer_id: text("dealer_id"),
  provider: text("provider").default("bolna"),
});

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

export const notifications = pgTable("notifications", {
  id: text().primaryKey().notNull(),
  user_id: uuid("user_id"),
  dealer_id: varchar("dealer_id", { length: 255 }),
  lead_id: varchar("lead_id", { length: 100 }),
  type: varchar({ length: 50 }).notNull(),
  title: text().notNull(),
  message: text().notNull(),
  data: jsonb(),
  read: boolean().default(false),
  read_at: timestamp("read_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

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
  admin_decision: varchar("admin_decision", { length: 30 }).default("pending"), // pending, dealer_confirmed, sanctioned, rejected
  submitted_by: uuid("submitted_by"),
  submitted_at: timestamp("submitted_at", { withTimezone: true }).defaultNow(),

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
    notification_prefs: jsonb("notification_prefs").default({}).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userTenantIdx: index("nbfc_users_user_tenant_idx").on(table.user_id, table.tenant_id),
    tenantIdx: index("nbfc_users_tenant_idx").on(table.tenant_id),
  }),
);

// Bridges existing loan_applications to a tenant + the IoT vehicleno that loan
// is financing. One loan belongs to one NBFC.
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
    severity: varchar({ length: 16 }).notNull(),
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
    loan_sanction_id: uuid("loan_sanction_id").notNull(),
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
  },
  (table) => ({
    tenantIdx: index("nbfc_recovery_pipeline_tenant_idx").on(table.tenant_id),
    stageIdx: index("nbfc_recovery_pipeline_stage_idx").on(table.stage),
    tenantStageIdx: index("nbfc_recovery_pipeline_tenant_stage_idx").on(table.tenant_id, table.stage),
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
  },
  (table) => ({
    tenantIdx: index("nbfc_battery_evaluations_tenant_idx").on(table.tenant_id),
    pipelineIdx: index("nbfc_battery_evaluations_pipeline_idx").on(table.recovery_pipeline_id),
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
    status: varchar({ length: 16 }).notNull(),
    days_overdue: integer("days_overdue"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    loanIdx: index("emi_schedules_loan_idx").on(table.loan_sanction_id),
    loanDueIdx: index("emi_schedules_loan_due_idx").on(
      table.loan_sanction_id,
      table.due_date,
    ),
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
  // E-002 — activation timestamp. Distinct from approved_at: approved_at fires
  // when the final-approval gate releases (status='approved'); activated_at
  // fires when portal credentials are dispatched (status='active').
  activated_at: timestamp("activated_at", { withTimezone: true }),
  // E-026B — bridge to the portal tenant scope. Nullable because legacy NBFC
  // rows may not have a corresponding nbfc_tenants entry yet; backfilled by
  // legal_name match in the E-026B migration.
  tenant_id: uuid("tenant_id").references(() => nbfcTenants.id),
  created_by: integer("created_by").notNull(),
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
  },
  (table) => ({
    statusIdx: index("auction_lots_status_idx").on(table.status),
    endsAtIdx: index("auction_lots_ends_at_idx").on(table.ends_at),
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
  },
  (table) => ({
    lotIdx: index("auction_bids_lot_idx").on(table.lot_id),
    tenantIdx: index("auction_bids_tenant_idx").on(table.tenant_id),
    placedAtIdx: index("auction_bids_placed_at_idx").on(table.placed_at),
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
    loan_sanction_id: uuid("loan_sanction_id").notNull(),
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
  },
  (table) => ({
    lotIdx: index("auction_settlements_lot_idx").on(table.lot_id),
    sellerTenantIdx: index("auction_settlements_seller_tenant_idx").on(
      table.seller_tenant_id,
    ),
    winnerTenantIdx: index("auction_settlements_winner_tenant_idx").on(
      table.winner_tenant_id,
    ),
    statusIdx: index("auction_settlements_status_idx").on(table.status),
  }),
);

// =============================================================================
// E-104 — Inventory Transfers — bundled base table + rejection extension
// (Sync Audit G-06; BRD §6.S.5 reject-transfer workflow)
// =============================================================================
// `inventory_transfers` was referenced by Section 6.S.5's reject-transfer API
// but never created in the iTarang baseline schema. This unit creates the
// full table from scratch in one migration:
//   1. base columns Aditya's V2-Feb spec listed (id, transfer_id, source/
//      target dealer, serials JSON, reason, status, initiated_by, initiated_at,
//      acknowledged_by, acknowledged_at);
//   2. the three NEW rejection columns (rejected_by, rejected_at,
//      rejection_reason);
//   3. status implemented as varchar(32) (NOT a Postgres ENUM type) with a
//      CHECK constraint that admits all four states from the BRD —
//      'pending_acknowledgement' | 'completed' | 'rejected_by_target' |
//      'cancelled_by_admin'. Using varchar avoids ALTER TYPE migrations when
//      future states are added.
//
// CHECK constraint `inventory_transfers_rejection_triplet_check` enforces the
// all-or-nothing invariant on (rejected_by, rejected_at, rejection_reason):
// when status='rejected_by_target' the dealer-side reject API must populate
// all three; otherwise all three remain NULL. This guarantees that any row
// with a rejection cause carries who-rejected-it, when, and why — and
// prevents partial-rejection states that the audit workflow can't reason
// about.
//
// Transfer_id is the human-readable code (TRF-YYYYMMDD-SEQ) and carries a
// UNIQUE constraint so the dealer-portal UI can dedupe on it.
//
// The reject API itself ships in a separate Sec6.S.5 unit; this unit only
// delivers the storage layer.
// =============================================================================
export const inventoryTransfers = pgTable(
  "inventory_transfers",
  {
    id: serial("id").primaryKey().notNull(),
    transfer_id: varchar("transfer_id", { length: 50 }).notNull().unique(),
    source_dealer_id: integer("source_dealer_id").notNull(),
    target_dealer_id: integer("target_dealer_id").notNull(),
    serials: jsonb("serials").notNull(),
    reason: text("reason"),
    // pending_acknowledgement | completed | rejected_by_target | cancelled_by_admin
    status: varchar("status", { length: 32 }).notNull(),
    initiated_by: integer("initiated_by").notNull(),
    initiated_at: timestamp("initiated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    acknowledged_by: integer("acknowledged_by"),
    acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
    // NEW (G-06): the three rejection-cause columns. Populated together by
    // the Sec6.S.5 reject-transfer API; enforced as a triplet by the CHECK
    // constraint emitted in the migration SQL.
    rejected_by: integer("rejected_by"),
    rejected_at: timestamp("rejected_at", { withTimezone: true }),
    rejection_reason: text("rejection_reason"),
  },
  (table) => ({
    sourceDealerIdx: index("inventory_transfers_source_dealer_idx").on(
      table.source_dealer_id,
    ),
    targetDealerIdx: index("inventory_transfers_target_dealer_idx").on(
      table.target_dealer_id,
    ),
    statusIdx: index("inventory_transfers_status_idx").on(table.status),
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
    uploaded_by: uuid("uploaded_by").notNull(),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    total_rows: integer("total_rows").default(0).notNull(),
    inserted_rows: integer("inserted_rows").default(0).notNull(),
    skipped_rows: integer("skipped_rows").default(0).notNull(),
    errors_json: jsonb("errors_json"),
    inserted_inventory_ids: jsonb("inserted_inventory_ids"),
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
