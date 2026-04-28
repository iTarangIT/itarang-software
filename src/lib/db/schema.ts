import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  varchar,
  decimal,
  jsonb,
  uuid,
  index,
  bigint,
  json,
  customType,
} from "drizzle-orm/pg-core";

import { relations } from "drizzle-orm";

// Postgres bytea column backed by Node Buffer. Used for binary blobs like
// the DigiLocker eAadhaar PDF.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// --- FOUNDATION ---

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: varchar("role", { length: 50 }).notNull(),
  dealer_id: varchar("dealer_id", { length: 255 }),
  phone: text("phone"),
  avatar_url: text("avatar_url"),

  // ADD THESE 2 FIELDS
  password_hash: text("password_hash"),
  must_change_password: boolean("must_change_password")
    .notNull()
    .default(false),

  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- PHASE 0: MVP ---

export const productCategories = pgTable("product_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category_id: uuid("category_id")
      .references(() => productCategories.id, { onDelete: "restrict" })
      .notNull(),
    name: text("name").notNull(), // e.g. "51V 105AH"
    slug: text("slug").notNull(), // e.g. "51v-105ah"
    voltage_v: integer("voltage_v"), // 51 / 61 / 64 / 72 (null for non-battery)
    capacity_ah: integer("capacity_ah"), // 105 / 132 / 153 / 232 (null for non-battery)
    sku: text("sku").notNull().unique(), // e.g. "3W-51V-105AH"
    hsn_code: varchar("hsn_code", { length: 8 }),
    price: integer("price"),
    asset_type: varchar("asset_type", { length: 50 }), // Battery, Charger, SOC, Harness, Inverter
    is_serialized: boolean("is_serialized").notNull().default(true),
    warranty_months: integer("warranty_months").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    sort_order: integer("sort_order").notNull().default(0),
    is_active: boolean("is_active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
  id: varchar("id", { length: 255 }).primaryKey(), // OEM-YYYYMMDD-SEQ
  business_entity_name: text("business_entity_name").notNull(),
  gstin: varchar("gstin", { length: 15 }).notNull().unique(),
  pan: varchar("pan", { length: 10 }),
  address_line1: text("address_line1"),
  address_line2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  pincode: varchar("pincode", { length: 6 }),
  bank_name: text("bank_name"),
  bank_account_number: text("bank_account_number").notNull(),
  ifsc_code: varchar("ifsc_code", { length: 11 }).notNull(),
  bank_proof_url: text("bank_proof_url"),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  created_by: uuid("created_by").references(() => users.id),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const oemContacts = pgTable("oem_contacts", {
  id: varchar("id", { length: 255 }).primaryKey(), // OEM_ID-ROLE_SEQ
  oem_id: varchar("oem_id", { length: 255 })
    .references(() => oems.id, { onDelete: "cascade" })
    .notNull(),
  contact_role: varchar("contact_role", { length: 50 }).notNull(), // sales_head, sales_manager, finance_manager
  contact_name: text("contact_name").notNull(),
  contact_phone: varchar("contact_phone", { length: 20 }).notNull(),
  contact_email: text("contact_email").notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const inventory = pgTable("inventory", {
  id: varchar("id", { length: 255 }).primaryKey(), // INV-YYYYMMDD-XXX
  product_id: uuid("product_id").references(() => products.id),
  oem_id: varchar("oem_id", { length: 255 })
    .references(() => oems.id)
    .notNull(),

  // Denormalized Product Details (SOP 7.4)
  oem_name: text("oem_name").notNull(),
  asset_category: text("asset_category").notNull(),
  asset_type: text("asset_type").notNull(),
  model_type: text("model_type").notNull(),

  // Serialization
  is_serialized: boolean("is_serialized").default(true).notNull(),
  serial_number: varchar("serial_number", { length: 255 }).unique(),
  batch_number: varchar("batch_number", { length: 255 }),
  iot_imei_no: varchar("iot_imei_no", { length: 255 }),
  quantity: integer("quantity"),

  // Dates
  manufacturing_date: timestamp("manufacturing_date", {
    withTimezone: true,
  }).notNull(),
  expiry_date: timestamp("expiry_date", { withTimezone: true }).notNull(),

  // Financials
  inventory_amount: decimal("inventory_amount", {
    precision: 12,
    scale: 2,
  }).notNull(),
  gst_percent: decimal("gst_percent", { precision: 5, scale: 2 }).notNull(),
  gst_amount: decimal("gst_amount", { precision: 12, scale: 2 }).notNull(),
  final_amount: decimal("final_amount", { precision: 12, scale: 2 }).notNull(),

  // Invoicing
  oem_invoice_number: text("oem_invoice_number").notNull(),
  oem_invoice_date: timestamp("oem_invoice_date", {
    withTimezone: true,
  }).notNull(),
  oem_invoice_url: text("oem_invoice_url"),

  // Documents
  product_manual_url: text("product_manual_url"),
  warranty_document_url: text("warranty_document_url"),

  // Status
  status: varchar("status", { length: 20 }).default("in_transit").notNull(), // in_transit, pdi_pending, pdi_failed, available, reserved, sold, damaged, returned
  warehouse_location: text("warehouse_location"),

  // Step 4/5 integration: reservation/dispatch tracking (BRD V2)
  dealer_id: varchar("dealer_id", { length: 255 }),
  linked_lead_id: varchar("linked_lead_id", { length: 255 }),
  dispatch_date: timestamp("dispatch_date", { withTimezone: true }),
  soc_percent: decimal("soc_percent", { precision: 5, scale: 2 }),
  soc_last_sync_at: timestamp("soc_last_sync_at", { withTimezone: true }),

  // Metadata
  created_by: uuid("created_by")
    .references(() => users.id)
    .notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- DEALER SALES ---
export const leads = pgTable("leads", {
  id: varchar("id", { length: 255 }).primaryKey(),
  owner_name: text("owner_name"),
  owner_contact: varchar("owner_contact", { length: 20 }),
  full_name: text("full_name"),
  phone: varchar("phone", { length: 20 }),
  mobile: varchar("mobile", { length: 20 }),
  business_name: text("business_name"),
  owner_email: text("owner_email"),
  state: varchar("state", { length: 100 }),
  city: varchar("city", { length: 100 }),
  shop_address: text("shop_address"),
  local_address: text("local_address"),
  permanent_address: text("permanent_address"),
  current_address: text("current_address"),
  vehicle_rc: varchar("vehicle_rc", { length: 50 }),
  dob: timestamp("dob", { withTimezone: true }),
  father_or_husband_name: text("father_or_husband_name"),
  status: varchar("status", { length: 50 }),
  kyc_status: varchar("kyc_status", { length: 30 }),
  payment_method: varchar("payment_method", { length: 20 }),
  consent_status: varchar("consent_status", { length: 30 }),
  dealer_id: varchar("dealer_id", { length: 255 }),

  // Lead source / classification
  lead_source: varchar("lead_source", { length: 50 }),
  lead_type: varchar("lead_type", { length: 20 }),
  lead_status: varchar("lead_status", { length: 50 }),
  lead_score: integer("lead_score"),
  interest_level: varchar("interest_level", { length: 20 }),
  reference_id: varchar("reference_id", { length: 255 }),
  uploader_id: uuid("uploader_id"),

  // Product / vehicle / asset
  vehicle_ownership: varchar("vehicle_ownership", { length: 50 }),
  vehicle_owner_name: text("vehicle_owner_name"),
  vehicle_owner_phone: varchar("vehicle_owner_phone", { length: 20 }),
  battery_type: varchar("battery_type", { length: 50 }),
  asset_model: text("asset_model"),
  asset_price: decimal("asset_price", { precision: 12, scale: 2 }),
  family_members: integer("family_members"),
  driving_experience: integer("driving_experience"),
  is_current_same: boolean("is_current_same").default(false),
  product_category_id: varchar("product_category_id", { length: 255 }),
  product_type_id: varchar("product_type_id", { length: 255 }),
  primary_product_id: uuid("primary_product_id"),

  // Business
  interested_in: jsonb("interested_in"),
  battery_order_expected: integer("battery_order_expected"),
  investment_capacity: decimal("investment_capacity", { precision: 12, scale: 2 }),
  business_type: varchar("business_type", { length: 50 }),

  // Qualification
  qualified_by: uuid("qualified_by"),
  qualified_at: timestamp("qualified_at", { withTimezone: true }),
  qualification_notes: text("qualification_notes"),

  // Conversion
  converted_deal_id: varchar("converted_deal_id", { length: 255 }),
  converted_at: timestamp("converted_at", { withTimezone: true }),

  // AI call tracking
  total_ai_calls: integer("total_ai_calls").default(0),
  last_ai_call_at: timestamp("last_ai_call_at", { withTimezone: true }),
  last_call_outcome: text("last_call_outcome"),
  last_call_status: text("last_call_status"),
  conversation_summary: text("conversation_summary"),
  ai_priority_score: decimal("ai_priority_score", { precision: 5, scale: 2 }),
  next_call_after: timestamp("next_call_after", { withTimezone: true }),
  next_call_at: timestamp("next_call_at", { withTimezone: true }),
  do_not_call: boolean("do_not_call").default(false),

  // AI dialer (Bolna)
  ai_managed: boolean("ai_managed").default(false),
  ai_owner: text("ai_owner"),
  manual_takeover: boolean("manual_takeover").default(false),
  last_ai_action_at: timestamp("last_ai_action_at", { withTimezone: true }),
  intent_score: integer("intent_score"),
  intent_reason: text("intent_reason"),
  call_priority: integer("call_priority").default(0),

  // V2 workflow
  workflow_step: integer("workflow_step").default(1),
  auto_filled: boolean("auto_filled").default(false),
  ocr_status: varchar("ocr_status", { length: 20 }),
  ocr_error: text("ocr_error"),

  // Coupon
  coupon_code: varchar("coupon_code", { length: 20 }),
  coupon_status: varchar("coupon_status", { length: 20 }),

  // KYC
  kyc_score: integer("kyc_score"),
  kyc_completed_at: timestamp("kyc_completed_at", { withTimezone: true }),
  has_co_borrower: boolean("has_co_borrower").default(false),
  has_additional_docs_required: boolean("has_additional_docs_required").default(false),
  interim_step_status: varchar("interim_step_status", { length: 20 }),
  kyc_draft_data: jsonb("kyc_draft_data"),

  // SM workflow
  sm_review_status: varchar("sm_review_status", { length: 30 }),
  submitted_to_sm_at: timestamp("submitted_to_sm_at", { withTimezone: true }),
  sm_assigned_to: uuid("sm_assigned_to"),

  // Step 4/5 lifecycle (BRD V2 Parts E & F)
  // kyc_status extended values: pending_itarang_reverification, pending_final_approval,
  // loan_sanctioned, loan_rejected, sold, closed_loan_rejected
  sold_at: timestamp("sold_at", { withTimezone: true }),

  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
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
//       leadsSourceIdx: index("leads_source_idx").on(table.lead_source),
//       leadsInterestIdx: index("leads_interest_idx").on(table.interest_level),
//       leadsStatusIdx: index("leads_status_idx").on(table.lead_status),
//     };
//   },
// );

export const loanDetails = pgTable("loan_details", {
  id: uuid("id").defaultRandom().primaryKey(),
  lead_id: varchar("lead_id", { length: 255 }).references(
    () => dealerLeads.id,
    {
      onDelete: "cascade",
    },
  ),
  loan_required: boolean("loan_required").default(false),
  loan_amount: decimal("loan_amount", { precision: 12, scale: 2 }),
  interest_rate: decimal("interest_rate", { precision: 5, scale: 2 }),
  tenure_months: integer("tenure_months"),
  processing_fee: decimal("processing_fee", { precision: 10, scale: 2 }),
  emi: decimal("emi", { precision: 10, scale: 2 }),
  down_payment: decimal("down_payment", { precision: 12, scale: 2 }),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const personalDetails = pgTable("personal_details", {
  id: uuid("id").defaultRandom().primaryKey(),
  lead_id: varchar("lead_id", { length: 255 }).references(
    () => dealerLeads.id,
    {
      onDelete: "cascade",
    },
  ),
  aadhaar_no: varchar("aadhaar_no", { length: 20 }),
  pan_no: varchar("pan_no", { length: 20 }),
  dob: timestamp("dob", { withTimezone: true }), // Using timestamp for date
  email: text("email"),
  income: decimal("income", { precision: 12, scale: 2 }),
  finance_type: varchar("finance_type", { length: 50 }),
  financier: varchar("financier", { length: 100 }),
  asset_type: varchar("asset_type", { length: 50 }), // 2W, 3W
  vehicle_rc: varchar("vehicle_rc", { length: 50 }),
  loan_type: varchar("loan_type", { length: 100 }),
  father_husband_name: text("father_husband_name"),
  marital_status: varchar("marital_status", { length: 20 }),
  spouse_name: text("spouse_name"),
  local_address: text("local_address"),

  // Bank Details (from OCR / manual entry)
  bank_account_number: text("bank_account_number"),
  bank_ifsc: varchar("bank_ifsc", { length: 11 }),
  bank_name: text("bank_name"),
  bank_branch: text("bank_branch"),

  // OCR Confidence
  dob_confidence: decimal("dob_confidence", { precision: 5, scale: 2 }),
  name_confidence: decimal("name_confidence", { precision: 5, scale: 2 }),
  address_confidence: decimal("address_confidence", { precision: 5, scale: 2 }),
  ocr_processed_at: timestamp("ocr_processed_at", { withTimezone: true }),

  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const documents = pgTable("documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  lead_id: varchar("lead_id", { length: 255 }).references(
    () => dealerLeads.id,
    {
      onDelete: "cascade",
    },
  ),
  document_type: varchar("document_type", { length: 50 }).notNull(),
  file_url: text("file_url").notNull(),
  uploaded_at: timestamp("uploaded_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const leadDocuments = pgTable("lead_documents", {
  id: varchar("id", { length: 255 }).primaryKey(),
  lead_id: varchar("lead_id", { length: 255 }).references(
    () => dealerLeads.id,
    {
      onDelete: "cascade",
    },
  ),
  dealer_id: varchar("dealer_id", { length: 255 }).references(
    () => accounts.id,
  ),
  user_id: uuid("user_id").references(() => users.id),
  doc_type: varchar("doc_type", { length: 100 }).notNull(),
  storage_path: text("storage_path").notNull(), // private/dealer_id/lead_id/filename
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const leadAssignments = pgTable("lead_assignments", {
  id: varchar("id", { length: 255 }).primaryKey(),
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => dealerLeads.id)
    .notNull(),
  lead_owner: uuid("lead_owner")
    .references(() => users.id)
    .notNull(), // Sales Head MUST assign
  assigned_by: uuid("assigned_by")
    .references(() => users.id)
    .notNull(),
  assigned_at: timestamp("assigned_at", { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Lead Actor (Owner or Sales Head can assign)
  lead_actor: uuid("lead_actor").references(() => users.id),
  actor_assigned_by: uuid("actor_assigned_by").references(() => users.id),
  actor_assigned_at: timestamp("actor_assigned_at", { withTimezone: true }),

  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const assignmentChangeLogs = pgTable("assignment_change_logs", {
  id: varchar("id", { length: 255 }).primaryKey(),
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => dealerLeads.id)
    .notNull(),
  change_type: varchar("change_type", { length: 50 }).notNull(), // owner_assigned, owner_changed, actor_assigned, actor_changed, actor_removed
  old_user_id: uuid("old_user_id").references(() => users.id),
  new_user_id: uuid("new_user_id").references(() => users.id),
  changed_by: uuid("changed_by")
    .references(() => users.id)
    .notNull(),
  change_reason: text("change_reason"),
  changed_at: timestamp("changed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const deals = pgTable("deals", {
  id: varchar("id", { length: 255 }).primaryKey(), // DEAL-YYYYMMDD-XXX
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => dealerLeads.id)
    .notNull(),

  // Products & Pricing
  products: jsonb("products").notNull(), // Array of { product_id, quantity, unit_price, gst_percent }
  line_total: decimal("line_total", { precision: 12, scale: 2 }).notNull(),
  gst_amount: decimal("gst_amount", { precision: 12, scale: 2 }).notNull(),
  transportation_cost: decimal("transportation_cost", {
    precision: 10,
    scale: 2,
  })
    .default("0")
    .notNull(),
  transportation_gst_percent: integer("transportation_gst_percent")
    .default(18)
    .notNull(),
  total_payable: decimal("total_payable", {
    precision: 12,
    scale: 2,
  }).notNull(),

  // Payment Terms
  payment_term: varchar("payment_term", { length: 20 }).notNull(), // cash, credit
  credit_period_months: integer("credit_period_months"),

  // Status
  deal_status: varchar("deal_status", { length: 50 })
    .default("pending_approval_l1")
    .notNull(), // pending_approval_l1, pending_approval_l2, pending_approval_l3, approved, rejected, payment_awaited, converted, expired

  // Immutability (after invoice)
  is_immutable: boolean("is_immutable").default(false).notNull(),
  invoice_number: text("invoice_number"),
  invoice_url: text("invoice_url"),
  invoice_issued_at: timestamp("invoice_issued_at", { withTimezone: true }),

  // Expiry
  expires_at: timestamp("expires_at", { withTimezone: true }),
  expired_by: uuid("expired_by").references(() => users.id),
  expired_at: timestamp("expired_at", { withTimezone: true }),
  expiry_reason: text("expiry_reason"),

  // Rejection
  rejected_by: uuid("rejected_by").references(() => users.id),
  rejected_at: timestamp("rejected_at", { withTimezone: true }),
  rejection_reason: text("rejection_reason"),

  created_by: uuid("created_by")
    .references(() => users.id)
    .notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const approvals = pgTable("approvals", {
  id: varchar("id", { length: 255 }).primaryKey(),
  entity_type: varchar("entity_type", { length: 50 }).notNull(), // deal, order, provision
  entity_id: varchar("entity_id", { length: 255 }).notNull(),

  level: integer("level").notNull(), // 1, 2, 3
  approver_role: varchar("approver_role", { length: 50 }).notNull(), // sales_head, business_head, finance_controller

  status: varchar("status", { length: 20 }).default("pending").notNull(), // pending, approved, rejected

  approver_id: uuid("approver_id").references(() => users.id),
  decision_at: timestamp("decision_at", { withTimezone: true }),
  rejection_reason: text("rejection_reason"),
  comments: text("comments"),

  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const orderDisputes = pgTable("order_disputes", {
  id: varchar("id", { length: 255 }).primaryKey(), // DISP-YYYYMMDD-SEQ
  order_id: varchar("order_id", { length: 255 })
    .references(() => orders.id)
    .notNull(),
  dispute_type: varchar("dispute_type", { length: 50 }).notNull(), // damage, shortage, delivery_failure
  description: text("description").notNull(),
  photos_urls: jsonb("photos_urls"), // Array of photo URLs
  assigned_to: uuid("assigned_to")
    .references(() => users.id)
    .notNull(),
  resolution_status: varchar("resolution_status", { length: 50 })
    .default("open")
    .notNull(), // open, investigating, resolved, closed
  resolution_details: text("resolution_details"), // Added from SOP 9.6
  action_taken: text("action_taken"), // Added from SOP 9.6
  resolved_by: uuid("resolved_by").references(() => users.id),
  resolved_at: timestamp("resolved_at"),
  created_by: uuid("created_by")
    .references(() => users.id)
    .notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const slas = pgTable("slas", {
  id: varchar("id", { length: 255 }).primaryKey(),
  workflow_step: varchar("workflow_step", { length: 100 }).notNull(),
  entity_type: varchar("entity_type", { length: 50 }).notNull(),
  entity_id: varchar("entity_id", { length: 255 }).notNull(),
  assigned_to: uuid("assigned_to").references(() => users.id),
  sla_deadline: timestamp("sla_deadline").notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(), // active, completed, breached
  completed_at: timestamp("completed_at"),
  escalated_to: uuid("escalated_to").references(() => users.id),
  escalated_at: timestamp("escalated_at"),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- PDI ---

export const oemInventoryForPDI = pgTable("oem_inventory_for_pdi", {
  id: varchar("id", { length: 255 }).primaryKey(), // PDIREQ-YYYYMMDD-XXX
  provision_id: varchar("provision_id", { length: 255 }).notNull(),
  inventory_id: varchar("inventory_id", { length: 255 })
    .references(() => inventory.id)
    .notNull(),
  serial_number: varchar("serial_number", { length: 255 }),
  oem_id: varchar("oem_id", { length: 255 })
    .references(() => oems.id)
    .notNull(),
  pdi_status: varchar("pdi_status", { length: 20 })
    .default("pending")
    .notNull(), // pending, in_progress, completed
  pdi_record_id: varchar("pdi_record_id", { length: 255 }),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const pdiRecords = pgTable("pdi_records", {
  id: varchar("id", { length: 255 }).primaryKey(), // PDI-YYYYMMDD-XXX
  oem_inventory_id: varchar("oem_inventory_id", { length: 255 })
    .references(() => oemInventoryForPDI.id)
    .notNull(),
  provision_id: varchar("provision_id", { length: 255 }).notNull(),
  service_engineer_id: uuid("service_engineer_id")
    .references(() => users.id)
    .notNull(),

  // Physical Inspection
  iot_imei_no: varchar("iot_imei_no", { length: 255 }),
  physical_condition: text("physical_condition").notNull(), // OK - No issues, Minor scratches, Damaged exterior, Severely damaged
  discharging_connector: varchar("discharging_connector", {
    length: 20,
  }).notNull(), // SB75, SB50
  charging_connector: varchar("charging_connector", { length: 20 }).notNull(), // SB75, SB50
  productor_sticker: varchar("productor_sticker", { length: 50 }).notNull(), // Available - damage, Available - OK, Unavailable

  // Technical Fields
  voltage: decimal("voltage", { precision: 5, scale: 2 }),
  soc: integer("soc"),
  capacity_ah: decimal("capacity_ah", { precision: 6, scale: 2 }),
  resistance_mohm: decimal("resistance_mohm", { precision: 6, scale: 2 }),
  temperature_celsius: decimal("temperature_celsius", {
    precision: 5,
    scale: 2,
  }),

  // GPS
  latitude: decimal("latitude", { precision: 10, scale: 8 }).notNull(),
  longitude: decimal("longitude", { precision: 11, scale: 8 }).notNull(),
  location_address: text("location_address"),

  // Documents
  product_manual_url: text("product_manual_url"),
  warranty_document_url: text("warranty_document_url"),
  pdi_photos: jsonb("pdi_photos"),

  // Result
  pdi_status: varchar("pdi_status", { length: 20 }).notNull(), // pass, fail
  failure_reason: text("failure_reason"),

  inspected_at: timestamp("inspected_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const auditLogs = pgTable("audit_logs", {
  id: varchar("id", { length: 255 }).primaryKey(), // AUDIT-YYYYMMDD-SEQ
  entity_type: varchar("entity_type", { length: 50 }).notNull(),
  entity_id: varchar("entity_id", { length: 255 }).notNull(),
  action: varchar("action", { length: 50 }).notNull(), // create, update, delete, approve, reject, assign, complete
  changes: jsonb("changes"),
  performed_by: uuid("performed_by")
    .references(() => users.id)
    .notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

// --- ACCOUNTS ---

export const accounts = pgTable("accounts", {
  id: varchar("id", { length: 255 }).primaryKey(), // ACC-YYYYMMDD-XXX
  business_entity_name: text("business_entity_name"),
  gstin: varchar("gstin", { length: 15 }),
  pan: varchar("pan", { length: 20 }),
  address_line1: text("address_line1"),
  address_line2: text("address_line2"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 100 }),
  pincode: varchar("pincode", { length: 10 }),
  bank_name: text("bank_name"),
  bank_account_number: text("bank_account_number"),
  ifsc_code: varchar("ifsc_code", { length: 11 }),
  bank_proof_url: text("bank_proof_url"),
  dealer_code: text("dealer_code"),
  contact_name: text("contact_name"),
  contact_email: text("contact_email"),
  contact_phone: varchar("contact_phone", { length: 20 }),
  status: varchar("status", { length: 20 }).default("active"),
  onboarding_status: varchar("onboarding_status", { length: 30 }),
  created_by: uuid("created_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// --- PROCUREMENT ---

export const provisions = pgTable("provisions", {
  id: varchar("id", { length: 255 }).primaryKey(), // PROV-YYYYMMDD-XXX
  oem_id: varchar("oem_id", { length: 255 })
    .references(() => oems.id)
    .notNull(),
  oem_name: text("oem_name").notNull(),
  products: jsonb("products").notNull(), // Array of { product_id, quantity }
  expected_delivery_date: timestamp("expected_delivery_date", {
    withTimezone: true,
  }).notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(), // pending, acknowledged, in_production, ready_for_pdi, completed, cancelled
  remarks: text("remarks"),
  created_by: uuid("created_by")
    .references(() => users.id)
    .notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const orders = pgTable(
  "orders",
  {
    id: varchar("id", { length: 255 }).primaryKey(), // ORD-YYYYMMDD-XXX
    provision_id: varchar("provision_id", { length: 255 })
      .references(() => provisions.id)
      .notNull(),
    oem_id: varchar("oem_id", { length: 255 })
      .references(() => oems.id)
      .notNull(),
    account_id: varchar("account_id", { length: 255 }).references(
      () => accounts.id,
    ),

    // Order items
    order_items: jsonb("order_items").notNull(), // Array of { inventory_id, serial_number, amount }
    total_amount: decimal("total_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),

    payment_term: varchar("payment_term", { length: 20 }).notNull(), // advance, credit
    credit_period_days: integer("credit_period_days"),

    // Documents
    pi_url: text("pi_url"),
    pi_amount: decimal("pi_amount", { precision: 12, scale: 2 }),
    invoice_url: text("invoice_url"),
    grn_id: text("grn_id"),
    grn_date: timestamp("grn_date", { withTimezone: true }),

    // Payment Tracking
    payment_status: varchar("payment_status", { length: 20 })
      .default("unpaid")
      .notNull(), // unpaid, partial, paid
    payment_amount: decimal("payment_amount", { precision: 12, scale: 2 })
      .default("0")
      .notNull(),
    payment_mode: varchar("payment_mode", { length: 50 }),
    transaction_id: text("transaction_id"),
    payment_date: timestamp("payment_date", { withTimezone: true }),

    // Status
    order_status: varchar("order_status", { length: 50 })
      .default("pi_awaited")
      .notNull(), // pi_awaited, pi_approval_pending, pi_approved, pi_rejected, payment_made, in_transit, delivered, cancelled
    delivery_status: varchar("delivery_status", { length: 20 })
      .default("pending")
      .notNull(), // pending, in_transit, delivered, failed

    // Dates
    expected_delivery_date: timestamp("expected_delivery_date", {
      withTimezone: true,
    }),
    actual_delivery_date: timestamp("actual_delivery_date", {
      withTimezone: true,
    }),

    reorder_tat_days: integer("reorder_tat_days"),

    created_by: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(),
    bolna_call_id: varchar("bolna_call_id", { length: 255 }).notNull().unique(),
    lead_id: varchar("lead_id", { length: 255 }).references(
      () => dealerLeads.id,
    ),
    status: varchar("status", { length: 20 }).default("initiated").notNull(),
    current_phase: varchar("current_phase", { length: 100 }),
    started_at: timestamp("started_at", { withTimezone: true }),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    transcript_chunk: text("transcript_chunk"),
    chunk_received_at: timestamp("chunk_received_at", { withTimezone: true }),
    full_transcript: text("full_transcript"),
    transcript_fetched_at: timestamp("transcript_fetched_at", {
      withTimezone: true,
    }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: uuid("id").primaryKey().defaultRandom(),
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id)
      .notNull(),
    call_id: varchar("call_id", { length: 255 }).notNull().unique(),
    agent_id: varchar("agent_id", { length: 255 }),
    phone_number: varchar("phone_number", { length: 20 }),
    transcript: text("transcript"),
    summary: text("summary"),
    recording_url: text("recording_url"),
    call_duration: integer("call_duration"), // in seconds
    status: varchar("status", { length: 50 }),
    provider: varchar("provider", { length: 50 }),
    started_at: timestamp("started_at", { withTimezone: true }),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    model_used: varchar("model_used", { length: 100 }),
    intent_score: integer("intent_score"),
    intent_reason: text("intent_reason"),
    next_action: text("next_action"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
  id: uuid("id").primaryKey().defaultRandom(),
  session_id: text("session_id").unique(), // External ID
  status: text("status").default("active"), // active, completed
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  ended_at: timestamp("ended_at", { withTimezone: true }),
});

export const callRecords = pgTable("call_records", {
  id: varchar("id", { length: 255 }).primaryKey(),
  session_id: text("session_id").references(() => callSessions.session_id),
  lead_id: varchar("lead_id", { length: 255 }).references(() => dealerLeads.id),
  bolna_call_id: varchar("bolna_call_id", { length: 255 }).unique(),
  status: text("status").default("queued"), // queued, ringing, completed, failed
  duration_seconds: integer("duration_seconds"),
  recording_url: text("recording_url"),
  summary: text("summary"),
  transcript: text("transcript"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  ended_at: timestamp("ended_at", { withTimezone: true }),
});

export const conversationMessages = pgTable("conversation_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  call_record_id: varchar("call_record_id", { length: 255 }).references(
    () => callRecords.id,
  ), // Link to record
  role: text("role"), // 'user', 'assistant'
  message: text("message"),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow(),
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

export const pdiRecordsRelations = relations(pdiRecords, ({ one }) => ({
  oemInventory: one(oemInventoryForPDI, {
    fields: [pdiRecords.oem_inventory_id],
    references: [oemInventoryForPDI.id],
  }),
  serviceEngineer: one(users, {
    fields: [pdiRecords.service_engineer_id],
    references: [users.id],
    relationName: "pdi_service_engineer",
  }),
}));

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
  creator: one(users, {
    fields: [orderDisputes.created_by],
    references: [users.id],
  }),
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
  id: varchar("id", { length: 255 }).primaryKey(), // CAMP-YYYYMMDD-XXX
  name: text("name").notNull(),
  type: varchar("type", { length: 50 }).notNull(), // sms, whatsapp, email
  status: varchar("status", { length: 20 }).default("draft").notNull(), // draft, scheduled, running, completed
  audience_filter: jsonb("audience_filter"), // Logic for segments
  message_content: text("message_content"),
  total_audience: integer("total_audience"),
  cost: decimal("cost", { precision: 10, scale: 2 }),
  created_by: uuid("created_by")
    .references(() => users.id)
    .notNull(),
  started_at: timestamp("started_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// For "Process Loan" workflow tracking
export const loanApplications = pgTable("loan_applications", {
  id: varchar("id", { length: 255 }).primaryKey(), // LOAN-APP-XXX
  // FK references `leads.id` (the borrower), matching both the live DB
  // constraint loan_applications_lead_id_fkey and how application code uses
  // it (e.g. dealer/loan-facilitation/queue COALESCEs leads.owner_name into
  // applicant_name). Earlier this said `dealerLeads.id` — that was a stale
  // refactor; dealer_leads is the AI-dialer prospecting table, unrelated.
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => leads.id)
    .notNull(),
  applicant_name: text("applicant_name"), // De-normalized for list views
  loan_amount: decimal("loan_amount", { precision: 12, scale: 2 }),

  // Status Flow
  documents_uploaded: boolean("documents_uploaded").default(false),
  company_validation_status: varchar("company_validation_status", {
    length: 20,
  })
    .default("pending")
    .notNull(), // pending, passed, failed
  facilitation_fee_status: varchar("facilitation_fee_status", { length: 20 })
    .default("pending")
    .notNull(), // pending, paid
  application_status: varchar("application_status", { length: 20 })
    .default("new")
    .notNull(), // new, processing, approved, disbursed, rejected

  facilitation_fee_amount: decimal("facilitation_fee_amount", {
    precision: 10,
    scale: 2,
  }),

  created_by: uuid("created_by").references(() => users.id),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- KYC MODULE ---

export const kycDocuments = pgTable(
  "kyc_documents",
  {
    id: varchar("id", { length: 255 }).primaryKey(), // KYCDOC-YYYYMMDD-SEQ
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    doc_for: varchar("doc_for", { length: 20 }).default("customer").notNull(), // customer, borrower
    doc_type: varchar("doc_type", { length: 50 }).notNull(), // aadhaar_front, aadhaar_back, pan_card, passport_photo, address_proof, rc_copy, bank_statement, cheque_1, cheque_2, cheque_3, cheque_4
    file_url: text("file_url").notNull(),
    file_name: text("file_name"),
    file_size: integer("file_size"), // bytes
    verification_status: varchar("verification_status", { length: 30 })
      .default("pending")
      .notNull(), // pending, in_progress, success, failed, awaiting_action
    failed_reason: text("failed_reason"),
    ocr_data: jsonb("ocr_data"), // Extracted data from OCR
    api_response: jsonb("api_response"), // Third-party verification API response
    verified_at: timestamp("verified_at", { withTimezone: true }),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // KYCVER-YYYYMMDD-SEQ
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    verification_type: varchar("verification_type", { length: 50 }).notNull(), // aadhaar, pan, bank, address, rc, mobile, cibil, photo
    applicant: varchar("applicant", { length: 20 }).default("primary").notNull(), // primary, co_borrower
    status: varchar("status", { length: 30 }).default("pending").notNull(), // pending, initiating, awaiting_action, in_progress, success, failed
    api_provider: varchar("api_provider", { length: 50 }), // decentro, surepass, vahan
    api_request: jsonb("api_request"),
    api_response: jsonb("api_response"),
    failed_reason: text("failed_reason"),
    match_score: decimal("match_score", { precision: 5, scale: 2 }), // Fuzzy match percentage
    retry_count: integer("retry_count").default(0),
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    admin_action: varchar("admin_action", { length: 30 }), // accepted, rejected, request_more_docs
    admin_action_by: uuid("admin_action_by").references(() => users.id),
    admin_action_at: timestamp("admin_action_at", { withTimezone: true }),
    admin_action_notes: text("admin_action_notes"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // DIGI-YYYYMMDD-SEQ
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    verification_id: varchar("verification_id", { length: 255 }).references(
      () => kycVerifications.id,
    ),
    reference_id: varchar("reference_id", { length: 255 }).notNull(),
    decentro_txn_id: varchar("decentro_txn_id", { length: 255 }),
    session_id: varchar("session_id", { length: 255 }),
    status: varchar("status", { length: 30 }).default("initiated").notNull(), // initiated, link_sent, link_opened, consent_given, document_fetched, failed, expired
    customer_phone: varchar("customer_phone", { length: 20 }).notNull(),
    customer_email: varchar("customer_email", { length: 255 }),
    digilocker_url: text("digilocker_url"),
    short_url: text("short_url"),
    notification_channel: varchar("notification_channel", { length: 10 })
      .default("sms")
      .notNull(), // sms, email, both
    link_sent_at: timestamp("link_sent_at", { withTimezone: true }),
    link_opened_at: timestamp("link_opened_at", { withTimezone: true }),
    customer_authorized_at: timestamp("customer_authorized_at", {
      withTimezone: true,
    }),
    digilocker_raw_response: jsonb("digilocker_raw_response"),
    aadhaar_extracted_data: jsonb("aadhaar_extracted_data"),
    cross_match_result: jsonb("cross_match_result"),
    // Binary PDF of the eAadhaar returned by Decentro when we call the
    // eAadhaar endpoint with generate_pdf=true. Stored alongside the
    // structured data so admin review has everything in one row.
    aadhaar_pdf: bytea("aadhaar_pdf"),
    // Decentro SMS delivery tracking (migration 0030)
    sms_message_id: varchar("sms_message_id", { length: 255 }),
    sms_delivered_at: timestamp("sms_delivered_at", { withTimezone: true }),
    sms_failed_reason: text("sms_failed_reason"),
    sms_attempts: integer("sms_attempts").default(0).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // KYCAUD-YYYYMMDD-SEQ
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    field_name: varchar("field_name", { length: 50 }).notNull(),
    field_value: varchar("field_value", { length: 200 }),
    data_source: varchar("data_source", { length: 20 }).notNull(), // ocr, api, manual
    entered_by: uuid("entered_by")
      .references(() => users.id)
      .notNull(),
    entered_at: timestamp("entered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reason: text("reason"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    kycDataAuditLeadIdx: index("kyc_data_audit_lead_idx").on(table.lead_id),
  }),
);

export const consentRecords = pgTable("consent_records", {
  id: varchar("id", { length: 255 }).primaryKey(), // CONSENT-YYYYMMDD-SEQ
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => dealerLeads.id, { onDelete: "cascade" })
    .notNull(),
  consent_for: varchar("consent_for", { length: 20 })
    .default("primary")
    .notNull(), // primary, co_borrower
  consent_type: varchar("consent_type", { length: 30 }), // digital, manual, sms, whatsapp
  consent_status: varchar("consent_status", { length: 30 })
    .default("awaiting_signature")
    .notNull(), // awaiting_signature, link_sent, digitally_signed, manual_uploaded, verified
  consent_token: varchar("consent_token", { length: 255 }),
  consent_link_url: text("consent_link_url"),
  consent_link_sent_at: timestamp("consent_link_sent_at", {
    withTimezone: true,
  }),
  consent_delivery_channel: varchar("consent_delivery_channel", { length: 20 }),
  esign_transaction_id: varchar("esign_transaction_id", { length: 255 }),
  signed_consent_url: text("signed_consent_url"),
  generated_pdf_url: text("generated_pdf_url"),
  signed_at: timestamp("signed_at", { withTimezone: true }),
  signer_aadhaar_masked: varchar("signer_aadhaar_masked", { length: 20 }),
  esign_retry_count: integer("esign_retry_count").default(0),
  esign_error_message: text("esign_error_message"),
  verified_by: uuid("verified_by").references(() => users.id),
  verified_at: timestamp("verified_at", { withTimezone: true }),
  admin_viewed_by: uuid("admin_viewed_by").references(() => users.id),
  admin_viewed_at: timestamp("admin_viewed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const couponCodes = pgTable("coupon_codes", {
  id: varchar("id", { length: 255 }).primaryKey(), // COUPON-SEQ
  code: varchar("code", { length: 20 }).notNull().unique(),
  dealer_id: varchar("dealer_id", { length: 255 })
    .references(() => accounts.id)
    .notNull(),
  status: varchar("status", { length: 20 }).default("available").notNull(), // available, validated, used, expired
  credits_available: integer("credits_available").default(1),
  discount_type: varchar("discount_type", { length: 20 }).default("flat"), // flat, percentage
  discount_value: decimal("discount_value", {
    precision: 10,
    scale: 2,
  }).default("0"),
  max_discount_cap: decimal("max_discount_cap", { precision: 10, scale: 2 }),
  min_amount: decimal("min_amount", { precision: 10, scale: 2 }),
  used_by_lead_id: varchar("used_by_lead_id", { length: 255 }).references(
    () => dealerLeads.id,
  ),
  used_by: uuid("used_by").references(() => users.id),
  validated_at: timestamp("validated_at", { withTimezone: true }),
  used_at: timestamp("used_at", { withTimezone: true }),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- COUPON BATCHES ---

export const couponBatches = pgTable(
  "coupon_batches",
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    dealer_id: varchar("dealer_id", { length: 255 })
      .references(() => accounts.id)
      .notNull(),
    prefix: varchar("prefix", { length: 20 }).notNull(),
    coupon_value: decimal("coupon_value", { precision: 10, scale: 2 })
      .default("0")
      .notNull(),
    total_quantity: integer("total_quantity").notNull(),
    expiry_date: timestamp("expiry_date", { withTimezone: true }),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    created_by: uuid("created_by").references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(),
    coupon_id: varchar("coupon_id", { length: 255 })
      .references(() => couponCodes.id)
      .notNull(),
    action: varchar("action", { length: 20 }).notNull(),
    old_status: varchar("old_status", { length: 20 }),
    new_status: varchar("new_status", { length: 20 }),
    lead_id: varchar("lead_id", { length: 255 }).references(() => leads.id),
    performed_by: uuid("performed_by"),
    ip_address: varchar("ip_address", { length: 45 }),
    notes: text("notes"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(),
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    payment_method: varchar("payment_method", { length: 30 }),

    facilitation_fee_base_amount: decimal("facilitation_fee_base_amount", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("1500.00"),
    coupon_code: varchar("coupon_code", { length: 50 }),
    coupon_id: varchar("coupon_id", { length: 255 }),
    coupon_discount_type: varchar("coupon_discount_type", { length: 20 }),
    coupon_discount_value: decimal("coupon_discount_value", {
      precision: 10,
      scale: 2,
    }),
    coupon_discount_amount: decimal("coupon_discount_amount", {
      precision: 10,
      scale: 2,
    }).default("0"),
    facilitation_fee_final_amount: decimal("facilitation_fee_final_amount", {
      precision: 10,
      scale: 2,
    }).notNull(),

    razorpay_qr_id: varchar("razorpay_qr_id", { length: 255 }),
    razorpay_qr_status: varchar("razorpay_qr_status", { length: 30 }),
    razorpay_qr_image_url: text("razorpay_qr_image_url"),
    razorpay_qr_short_url: text("razorpay_qr_short_url"),
    razorpay_qr_expires_at: timestamp("razorpay_qr_expires_at", {
      withTimezone: true,
    }),

    razorpay_payment_id: varchar("razorpay_payment_id", { length: 255 }),
    razorpay_order_id: varchar("razorpay_order_id", { length: 255 }),
    razorpay_payment_status: varchar("razorpay_payment_status", { length: 30 }),
    utr_number_manual: varchar("utr_number_manual", { length: 100 }),
    payment_screenshot_url: text("payment_screenshot_url"),

    facilitation_fee_status: varchar("facilitation_fee_status", { length: 30 })
      .notNull()
      .default("UNPAID"),
    // UNPAID, QR_GENERATED, PAYMENT_PENDING_CONFIRMATION, PAID, FAILED, EXPIRED

    payment_paid_at: timestamp("payment_paid_at", { withTimezone: true }),
    payment_verified_at: timestamp("payment_verified_at", {
      withTimezone: true,
    }),
    payment_verification_source: varchar("payment_verification_source", {
      length: 30,
    }),

    created_by: uuid("created_by").references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // COBOR-YYYYMMDD-SEQ
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    full_name: text("full_name").notNull(),
    father_or_husband_name: text("father_or_husband_name"),
    dob: timestamp("dob", { withTimezone: true }),
    phone: varchar("phone", { length: 20 }).notNull(),
    permanent_address: text("permanent_address"),
    current_address: text("current_address"),
    is_current_same: boolean("is_current_same").default(false),
    pan_no: varchar("pan_no", { length: 20 }),
    aadhaar_no: varchar("aadhaar_no", { length: 20 }),
    auto_filled: boolean("auto_filled").default(false),
    kyc_status: varchar("kyc_status", { length: 30 }).default("not_started"), // not_started, draft, in_progress, completed, failed
    consent_status: varchar("consent_status", { length: 30 }).default(
      "awaiting_signature",
    ),
    verification_submitted_at: timestamp("verification_submitted_at", {
      withTimezone: true,
    }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      coBorrowerLeadIdx: index("co_borrowers_lead_id_idx").on(table.lead_id),
    };
  },
);

export const coBorrowerDocuments = pgTable("co_borrower_documents", {
  id: varchar("id", { length: 255 }).primaryKey(), // COBDOC-YYYYMMDD-SEQ
  co_borrower_id: varchar("co_borrower_id", { length: 255 })
    .references(() => coBorrowers.id, { onDelete: "cascade" })
    .notNull(),
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => dealerLeads.id, { onDelete: "cascade" })
    .notNull(),
  doc_type: varchar("document_type", { length: 50 }).notNull(), // aadhaar_front, aadhaar_back, pan_card, passport_photo, address_proof, rc_copy, bank_statement, cheque_1-4
  file_url: text("document_url").notNull(),
  file_name: text("file_name"),
  file_size: integer("file_size"),
  verification_status: varchar("verification_status", { length: 30 }).default("pending"),
  status: varchar("status", { length: 30 }).default("pending").notNull(),
  ocr_data: jsonb("ocr_data"),
  uploaded_at: timestamp("uploaded_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const otherDocumentRequests = pgTable("other_document_requests", {
  id: varchar("id", { length: 255 }).primaryKey(), // OTHERDOC-SEQ
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => dealerLeads.id, { onDelete: "cascade" })
    .notNull(),
  doc_for: varchar("doc_for", { length: 20 }).default("primary").notNull(), // primary, co_borrower
  doc_label: text("doc_label").notNull(), // e.g., "Rent Agreement", "Owner Verification"
  doc_key: varchar("doc_key", { length: 100 }).notNull(), // machine-friendly key
  is_required: boolean("is_required").default(true),
  file_url: text("file_url"),
  upload_status: varchar("upload_status", { length: 20 })
    .default("not_uploaded")
    .notNull(), // not_uploaded, uploaded, rejected, verified
  rejection_reason: text("rejection_reason"),
  reviewed_by: uuid("reviewed_by").references(() => users.id),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
  requested_by: uuid("requested_by")
    .references(() => users.id)
    .notNull(),
  uploaded_at: timestamp("uploaded_at", { withTimezone: true }),
  upload_token: varchar("upload_token", { length: 255 }),
  token_expires_at: timestamp("token_expires_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const coBorrowerRequests = pgTable(
  "co_borrower_requests",
  {
    id: varchar("id", { length: 255 }).primaryKey(), // COBREQ-YYYYMMDD-SEQ
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    attempt_number: integer("attempt_number").default(1).notNull(),
    reason: text("reason"),
    status: varchar("status", { length: 30 }).default("open").notNull(), // open, replaced, completed
    created_by: uuid("created_by").references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // OFFER-YYYYMMDD-SEQ
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    financier_name: text("financier_name").notNull(),
    loan_amount: decimal("loan_amount", { precision: 12, scale: 2 }).notNull(),
    interest_rate: decimal("interest_rate", {
      precision: 5,
      scale: 2,
    }).notNull(), // % per annum
    tenure_months: integer("tenure_months").notNull(),
    emi: decimal("emi", { precision: 10, scale: 2 }).notNull(),
    processing_fee: decimal("processing_fee", { precision: 10, scale: 2 }),
    notes: text("notes"),
    status: varchar("status", { length: 20 }).default("pending").notNull(), // pending, offered, selected, booked
    created_by: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
  id: varchar("id", { length: 255 }).primaryKey(), // REVIEW-YYYYMMDD-SEQ
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => dealerLeads.id, { onDelete: "cascade" })
    .notNull(),
  review_for: varchar("review_for", { length: 20 })
    .default("primary")
    .notNull(), // primary, co_borrower
  document_id: varchar("document_id", { length: 255 }), // Reference to kyc_documents or co_borrower_documents
  document_type: varchar("document_type", { length: 50 }),
  outcome: varchar("outcome", { length: 20 }).notNull(), // verified, rejected, request_additional
  rejection_reason: text("rejection_reason"),
  additional_doc_requested: text("additional_doc_requested"), // If outcome is request_additional
  reviewer_id: uuid("reviewer_id")
    .references(() => users.id)
    .notNull(),
  reviewer_notes: text("reviewer_notes"),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const adminVerificationQueue = pgTable(
  "admin_verification_queue",
  {
    id: varchar("id", { length: 255 }).primaryKey(), // ADMQ-YYYYMMDD-SEQ
    queue_type: varchar("queue_type", { length: 50 })
      .default("kyc_verification")
      .notNull(),
    lead_id: text("lead_id")
      .references(() => dealerLeads.id, { onDelete: "cascade" })
      .notNull(),
    priority: varchar("priority", { length: 20 }).default("normal").notNull(),
    assigned_to: uuid("assigned_to").references(() => users.id),
    submitted_by: uuid("submitted_by").references(() => users.id),
    status: varchar("status", { length: 50 })
      .default("pending_itarang_verification")
      .notNull(),
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    lead_id: text("lead_id")
      .primaryKey()
      .references(() => dealerLeads.id, { onDelete: "cascade" }),
    submission_timestamp: timestamp("submission_timestamp", {
      withTimezone: true,
    }).notNull(),
    case_type: varchar("case_type", { length: 20 }),
    coupon_code: varchar("coupon_code", { length: 50 }),
    coupon_status: varchar("coupon_status", { length: 20 })
      .default("reserved")
      .notNull(),
    documents_count: integer("documents_count").default(0).notNull(),
    consent_verified: boolean("consent_verified").default(false).notNull(),
    dealer_edits_locked: boolean("dealer_edits_locked")
      .default(false)
      .notNull(),
    verification_started_at: timestamp("verification_started_at", {
      withTimezone: true,
    }),
    first_api_execution_at: timestamp("first_api_execution_at", {
      withTimezone: true,
    }),
    first_api_type: varchar("first_api_type", { length: 50 }),
    final_decision: varchar("final_decision", { length: 30 }),
    final_decision_at: timestamp("final_decision_at", { withTimezone: true }),
    final_decision_by: uuid("final_decision_by").references(() => users.id),
    final_decision_notes: text("final_decision_notes"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // ASSET-YYYYMMDD-SEQ
    inventory_id: varchar("inventory_id", { length: 255 })
      .references(() => inventory.id)
      .notNull(),
    lead_id: varchar("lead_id", { length: 255 }).references(
      () => dealerLeads.id,
    ),
    deal_id: varchar("deal_id", { length: 255 }).references(() => deals.id),
    dealer_id: varchar("dealer_id", { length: 255 }).references(
      () => accounts.id,
    ),
    customer_name: text("customer_name"),
    customer_phone: varchar("customer_phone", { length: 20 }),

    // Asset Info (denormalized)
    serial_number: varchar("serial_number", { length: 255 }),
    asset_category: varchar("asset_category", { length: 20 }),
    asset_type: varchar("asset_type", { length: 50 }),
    model_type: text("model_type"),

    // Deployment
    deployment_date: timestamp("deployment_date", {
      withTimezone: true,
    }).notNull(),
    deployment_location: text("deployment_location"),
    latitude: decimal("latitude", { precision: 10, scale: 8 }),
    longitude: decimal("longitude", { precision: 11, scale: 8 }),

    // QR Code
    qr_code_url: text("qr_code_url"),
    qr_code_data: text("qr_code_data"),

    // Payment
    payment_type: varchar("payment_type", { length: 20 }), // upfront, finance, lease
    payment_status: varchar("payment_status", { length: 20 }).default(
      "pending",
    ), // pending, partial, paid

    // Battery Health & Telemetry
    battery_health_percent: decimal("battery_health_percent", {
      precision: 5,
      scale: 2,
    }),
    last_voltage: decimal("last_voltage", { precision: 5, scale: 2 }),
    last_soc: integer("last_soc"),
    last_telemetry_at: timestamp("last_telemetry_at", { withTimezone: true }),
    telemetry_data: jsonb("telemetry_data"), // Historical telemetry snapshots
    total_cycles: integer("total_cycles"),

    // Warranty
    warranty_start_date: timestamp("warranty_start_date", {
      withTimezone: true,
    }),
    warranty_end_date: timestamp("warranty_end_date", { withTimezone: true }),
    warranty_status: varchar("warranty_status", { length: 20 }).default(
      "active",
    ), // active, expired, claimed

    // Status
    status: varchar("status", { length: 20 }).default("active").notNull(), // active, maintenance, inactive, returned, replaced
    last_maintenance_at: timestamp("last_maintenance_at", {
      withTimezone: true,
    }),
    next_maintenance_due: timestamp("next_maintenance_due", {
      withTimezone: true,
    }),

    created_by: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
  id: varchar("id", { length: 255 }).primaryKey(),
  deployed_asset_id: varchar("deployed_asset_id", { length: 255 })
    .references(() => deployedAssets.id, { onDelete: "cascade" })
    .notNull(),
  action: varchar("action", { length: 50 }).notNull(), // deployed, maintenance, replaced, returned, status_change
  description: text("description"),
  performed_by: uuid("performed_by")
    .references(() => users.id)
    .notNull(),
  metadata: jsonb("metadata"), // Action-specific data
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- SERVICE MANAGEMENT MODULE ---

export const serviceTickets = pgTable(
  "service_tickets",
  {
    id: varchar("id", { length: 255 }).primaryKey(), // SVC-YYYYMMDD-SEQ
    deployed_asset_id: varchar("deployed_asset_id", { length: 255 }).references(
      () => deployedAssets.id,
    ),
    dealer_id: varchar("dealer_id", { length: 255 })
      .references(() => accounts.id)
      .notNull(),
    customer_name: text("customer_name"),
    customer_phone: varchar("customer_phone", { length: 20 }),

    // Issue Details
    issue_type: varchar("issue_type", { length: 50 }).notNull(), // battery_failure, charger_issue, physical_damage, performance_degradation, connectivity, other
    issue_description: text("issue_description").notNull(),
    priority: varchar("priority", { length: 20 }).default("medium").notNull(), // low, medium, high, critical
    photos_urls: jsonb("photos_urls"),

    // Assignment
    assigned_to: uuid("assigned_to").references(() => users.id),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),

    // Resolution
    status: varchar("status", { length: 30 }).default("open").notNull(), // open, assigned, in_progress, on_hold, resolved, closed, escalated
    resolution_type: varchar("resolution_type", { length: 50 }), // repair, replace, refund, warranty_claim, no_action
    resolution_notes: text("resolution_notes"),
    resolved_by: uuid("resolved_by").references(() => users.id),
    resolved_at: timestamp("resolved_at", { withTimezone: true }),

    // SLA
    sla_deadline: timestamp("sla_deadline", { withTimezone: true }),
    sla_breached: boolean("sla_breached").default(false),

    created_by: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // LOANF-YYYYMMDD-SEQ
    lead_id: varchar("lead_id", { length: 255 })
      .references(() => dealerLeads.id)
      .notNull(),
    loan_application_id: varchar("loan_application_id", {
      length: 255,
    }).references(() => loanApplications.id),
    dealer_id: varchar("dealer_id", { length: 255 }).references(
      () => accounts.id,
    ),

    // Loan Details
    borrower_name: text("borrower_name").notNull(),
    co_borrower_name: text("co_borrower_name"),
    loan_amount: decimal("loan_amount", { precision: 12, scale: 2 }).notNull(),
    interest_rate: decimal("interest_rate", { precision: 5, scale: 2 }),
    tenure_months: integer("tenure_months"),
    emi_amount: decimal("emi_amount", { precision: 10, scale: 2 }),
    down_payment: decimal("down_payment", { precision: 12, scale: 2 }),
    processing_fee: decimal("processing_fee", { precision: 10, scale: 2 }),

    // Disbursal
    disbursal_status: varchar("disbursal_status", { length: 30 })
      .default("pending")
      .notNull(), // pending, approved, disbursed, rejected
    disbursed_amount: decimal("disbursed_amount", { precision: 12, scale: 2 }),
    disbursed_at: timestamp("disbursed_at", { withTimezone: true }),
    disbursal_reference: text("disbursal_reference"),

    // Payments
    total_paid: decimal("total_paid", { precision: 12, scale: 2 }).default("0"),
    total_outstanding: decimal("total_outstanding", {
      precision: 12,
      scale: 2,
    }),
    next_emi_date: timestamp("next_emi_date", { withTimezone: true }),
    emi_schedule: jsonb("emi_schedule"), // Array of { due_date, amount, status, paid_date }
    overdue_amount: decimal("overdue_amount", {
      precision: 12,
      scale: 2,
    }).default("0"),
    overdue_days: integer("overdue_days").default(0),

    // Status
    loan_status: varchar("loan_status", { length: 30 })
      .default("active")
      .notNull(), // active, closed, defaulted, restructured, written_off
    closure_date: timestamp("closure_date", { withTimezone: true }),
    closure_type: varchar("closure_type", { length: 20 }), // normal, prepayment, foreclosure

    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
  id: varchar("id", { length: 255 }).primaryKey(), // LPAY-YYYYMMDD-SEQ
  loan_file_id: varchar("loan_file_id", { length: 255 })
    .references(() => loanFiles.id, { onDelete: "cascade" })
    .notNull(),
  payment_type: varchar("payment_type", { length: 20 }).notNull(), // emi, prepayment, penalty, down_payment
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  payment_mode: varchar("payment_mode", { length: 30 }), // upi, neft, cash, cheque, auto_debit
  transaction_id: text("transaction_id"),
  payment_date: timestamp("payment_date", { withTimezone: true }).notNull(),
  emi_month: integer("emi_month"), // Which EMI number this payment is for
  status: varchar("status", { length: 20 }).default("completed").notNull(), // completed, pending, failed, reversed
  receipt_url: text("receipt_url"),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- DEALER PROFILE ---

export const dealerSubscriptions = pgTable("dealer_subscriptions", {
  id: varchar("id", { length: 255 }).primaryKey(),
  dealer_id: varchar("dealer_id", { length: 255 })
    .references(() => accounts.id)
    .notNull(),
  plan_name: varchar("plan_name", { length: 50 }).notNull(), // basic, standard, premium
  status: varchar("status", { length: 20 }).default("active").notNull(), // active, expired, cancelled
  started_at: timestamp("started_at", { withTimezone: true }).notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  features: jsonb("features"), // Allowed features based on plan
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- CAMPAIGN SEGMENTS ---

export const campaignSegments = pgTable("campaign_segments", {
  id: varchar("id", { length: 255 }).primaryKey(), // SEG-SEQ
  name: text("name").notNull(),
  description: text("description"),
  dealer_id: varchar("dealer_id", { length: 255 }).references(
    () => accounts.id,
  ),
  is_prebuilt: boolean("is_prebuilt").default(false), // true for system segments like "All Customers", "Hot Leads"
  filter_criteria: jsonb("filter_criteria").notNull(), // { conditions: [{ field, operator, value }], logic: 'AND' | 'OR' }
  estimated_audience: integer("estimated_audience"),
  created_by: uuid("created_by").references(() => users.id),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
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
  id: varchar("id", { length: 255 }).primaryKey(),
  device_id: varchar("device_id", { length: 100 }).notNull(),
  battery_serial: varchar("battery_serial", { length: 100 }),
  vehicle_number: varchar("vehicle_number", { length: 50 }),
  vehicle_type: varchar("vehicle_type", { length: 50 }),
  customer_name: text("customer_name"),
  customer_phone: varchar("customer_phone", { length: 20 }),
  dealer_id: varchar("dealer_id", { length: 255 }),
  status: varchar("status", { length: 20 }).default("active"),
  installed_at: timestamp("installed_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const batteryAlerts = pgTable("battery_alerts", {
  id: varchar("id", { length: 255 }).primaryKey(),
  device_id: varchar("device_id", { length: 100 }).notNull(),
  alert_type: varchar("alert_type", { length: 50 }).notNull(),
  severity: varchar("severity", { length: 20 }).notNull(),
  message: text("message"),
  value: decimal("value", { precision: 10, scale: 2 }),
  threshold: decimal("threshold", { precision: 10, scale: 2 }),
  acknowledged: boolean("acknowledged").default(false),
  acknowledged_at: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledged_by: text("acknowledged_by"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// --- APP SETTINGS ---

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// --- DEALER LEAD SCRAPER MODULE ---

export const scraperRuns = pgTable(
  "scraper_runs",
  {
    id: varchar("id", { length: 255 }).primaryKey(), // SCRAPE-YYYYMMDD-SEQ
    triggered_by: uuid("triggered_by")
      .references(() => users.id)
      .notNull(),
    status: varchar("status", { length: 20 }).default("running").notNull(), // running, completed, failed, cancelled
    started_at: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    search_queries: jsonb("search_queries"), // string[] of queries used
    total_found: integer("total_found").default(0),
    new_leads_saved: integer("new_leads_saved").default(0),
    duplicates_skipped: integer("duplicates_skipped").default(0),
    error_message: text("error_message"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // SDL-YYYYMMDD-SEQ
    scraper_run_id: varchar("scraper_run_id", { length: 255 })
      .references(() => scraperRuns.id)
      .notNull(),
    dealer_name: text("dealer_name").notNull(),
    phone: varchar("phone", { length: 20 }),
    location_city: varchar("location_city", { length: 100 }),
    location_state: varchar("location_state", { length: 100 }),
    source_url: text("source_url"),
    raw_data: jsonb("raw_data"), // full scraped payload for reference
    email: varchar("email", { length: 255 }),
    gst_number: varchar("gst_number", { length: 20 }),
    business_type: varchar("business_type", { length: 50 }),
    products_sold: text("products_sold"),
    website: text("website"),
    quality_score: integer("quality_score"),
    phone_valid: boolean("phone_valid"),
    // Assignment (Sales Head assigns to Sales Manager)
    assigned_to: uuid("assigned_to").references(() => users.id), // null = unassigned
    assigned_by: uuid("assigned_by").references(() => users.id),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),
    // Exploration workflow (Sales Manager drives this)
    exploration_status: varchar("exploration_status", { length: 30 })
      .default("unassigned")
      .notNull(),
    // Values: unassigned, assigned, exploring, explored, not_interested
    exploration_notes: text("exploration_notes"),
    explored_at: timestamp("explored_at", { withTimezone: true }),
    // Promotion to full CRM lead (optional)
    converted_lead_id: varchar("converted_lead_id", { length: 255 }).references(
      () => dealerLeads.id,
    ),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
    id: varchar("id", { length: 255 }).primaryKey(), // DDUP-YYYYMMDD-SEQ
    scraper_run_id: varchar("scraper_run_id", { length: 255 })
      .references(() => scraperRuns.id)
      .notNull(),
    raw_dealer_name: text("raw_dealer_name"),
    raw_phone: varchar("raw_phone", { length: 20 }),
    raw_location: text("raw_location"),
    raw_source_url: text("raw_source_url"),
    skip_reason: varchar("skip_reason", { length: 50 }).notNull(), // duplicate_phone, duplicate_name_location, duplicate_url
    matched_lead_id: varchar("matched_lead_id", { length: 255 }), // existing SDL id that matched
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    ddupRunIdx: index("ddup_run_idx").on(table.scraper_run_id),
  }),
);

export const scraperSearchQueries = pgTable(
  "scraper_search_queries",
  {
    id: varchar("id", { length: 255 }).primaryKey(), // SQ-YYYYMMDD-SEQ
    query_text: text("query_text").notNull(),
    is_active: boolean("is_active").notNull().default(true),
    created_by: uuid("created_by")
      .references(() => users.id)
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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
  id: varchar("id", { length: 255 }).primaryKey(),
  frequency: varchar("frequency", { length: 20 }).notNull(),
  day_of_week: integer("day_of_week"),
  time_of_day: varchar("time_of_day", { length: 5 }).notNull().default("03:00"),
  is_active: boolean("is_active").notNull().default(true),
  last_run_at: timestamp("last_run_at", { withTimezone: true }),
  created_by: uuid("created_by")
    .references(() => users.id)
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
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
    id: uuid("id").defaultRandom().primaryKey(),
    dealerUserId: uuid("dealer_user_id"),
    companyName: text("company_name").notNull(),
    companyType: text("company_type"),
    gstNumber: text("gst_number"),
    panNumber: text("pan_number"),
    cinNumber: text("cin_number"),
    businessAddress: jsonb("business_address").default({}),
    registeredAddress: jsonb("registered_address").default({}),
    financeEnabled: boolean("finance_enabled").default(false),
    onboardingStatus: varchar("onboarding_status", { length: 30 })
      .default("draft")
      .notNull(),
    reviewStatus: varchar("review_status", { length: 30 }).default("pending"),
    submittedAt: timestamp("submitted_at"),
    approvedAt: timestamp("approved_at"),
    rejectedAt: timestamp("rejected_at"),
    rejectionReason: text("rejection_reason"),
    adminNotes: text("admin_notes"),

    // Set when this dealer was approved as a branch of an existing accounts row
    // (same GSTIN+PAN, different address). Branch dealers share the parent
    // account's legal-entity fields (company, GSTIN, PAN, bank) and are
    // blocked from editing those via the admin correction endpoint.
    isBranchDealer: boolean("is_branch_dealer").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    ownerName: text("owner_name"),
    ownerPhone: text("owner_phone"),
    ownerLandline: varchar("owner_landline", { length: 20 }),
    ownerEmail: text("owner_email"),

    salesManagerName: text("sales_manager_name"),
    salesManagerEmail: text("sales_manager_email"),
    salesManagerMobile: varchar("sales_manager_mobile", { length: 20 }),

    itarangSignatory1Name: text("itarang_signatory_1_name"),
    itarangSignatory1Email: text("itarang_signatory_1_email"),
    itarangSignatory1Mobile: varchar("itarang_signatory_1_mobile", { length: 20 }),

    itarangSignatory2Name: text("itarang_signatory_2_name"),
    itarangSignatory2Email: text("itarang_signatory_2_email"),
    itarangSignatory2Mobile: varchar("itarang_signatory_2_mobile", { length: 20 }),

    bankName: text("bank_name"),
    accountNumber: text("account_number"),
    beneficiaryName: text("beneficiary_name"),
    ifscCode: text("ifsc_code"),

    correctionRemarks: text("correction_remarks"),
    rejectionRemarks: text("rejection_remarks"),

    dealerAccountStatus: varchar("dealer_account_status", {
      length: 30,
    }).default("inactive"),
    dealerCode: text("dealer_code"),

    agreementStatus: varchar("agreement_status", { length: 50 }),
    agreementLanguage: varchar("agreement_language", { length: 30 })
      .default("english")
      .notNull(),
    completionStatus: varchar("completion_status", { length: 30 }),
    providerDocumentId: text("provider_document_id"),
    requestId: text("request_id"),
    providerSigningUrl: text("provider_signing_url"),
    providerRawResponse: jsonb("provider_raw_response"),
    stampStatus: varchar("stamp_status", { length: 30 }),
    stampCertificateIds: jsonb("stamp_certificate_ids")
      .$type<string[]>()
      .default([]),
    lastActionTimestamp: timestamp("last_action_timestamp"),
    signedAt: timestamp("signed_at"),
    signedAgreementUrl: text("signed_agreement_url"),
    signedAgreementStoragePath: text("signed_agreement_storage_path"),
    auditTrailUrl: text("audit_trail_url"),
    auditTrailStoragePath: text("audit_trail_storage_path"),
  },
);

export const dealerAgreementSigners = pgTable(
  "dealer_agreement_signers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => dealerOnboardingApplications.id, { onDelete: "cascade" }),
    providerDocumentId: text("provider_document_id"),
    requestId: text("request_id"),
    signerRole: varchar("signer_role", { length: 50 }).notNull(),
    signerName: text("signer_name").notNull(),
    signerEmail: text("signer_email"),
    signerMobile: text("signer_mobile"),
    signingMethod: varchar("signing_method", { length: 50 }),
    providerSignerIdentifier: text("provider_signer_identifier"),
    providerSigningUrl: text("provider_signing_url"),
    signerStatus: varchar("signer_status", { length: 50 })
      .default("pending")
      .notNull(),
    signedAt: timestamp("signed_at"),
    lastEventAt: timestamp("last_event_at"),
    providerRawResponse: jsonb("provider_raw_response").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    appIdx: index("dealer_agreement_signers_application_id_idx").on(
      table.applicationId,
    ),
    docIdx: index("dealer_agreement_signers_provider_document_id_idx").on(
      table.providerDocumentId,
    ),
    statusIdx: index("dealer_agreement_signers_signer_status_idx").on(
      table.signerStatus,
    ),
  }),
);

export const dealerAgreementEvents = pgTable(
  "dealer_agreement_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => dealerOnboardingApplications.id, { onDelete: "cascade" }),
    providerDocumentId: text("provider_document_id"),
    requestId: text("request_id"),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    signerRole: varchar("signer_role", { length: 50 }),
    eventStatus: varchar("event_status", { length: 50 }),
    eventPayload: jsonb("event_payload").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    appIdx: index("dealer_agreement_events_application_id_idx").on(
      table.applicationId,
    ),
    docIdx: index("dealer_agreement_events_provider_document_id_idx").on(
      table.providerDocumentId,
    ),
    createdIdx: index("dealer_agreement_events_created_at_idx").on(
      table.createdAt,
    ),
  }),
);

export const dealerOnboardingDocuments = pgTable(
  "dealer_onboarding_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    applicationId: uuid("application_id")
      .notNull()
      .references(() => dealerOnboardingApplications.id, {
        onDelete: "cascade",
      }),

    documentType: varchar("document_type", { length: 100 }).notNull(),

    bucketName: text("bucket_name").notNull(),
    storagePath: text("storage_path").notNull(),

    fileName: text("file_name").notNull(),
    fileUrl: text("file_url"),

    mimeType: varchar("mime_type", { length: 100 }),
    fileSize: bigint("file_size", { mode: "number" }),

    uploadedBy: uuid("uploaded_by"),
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),

    docStatus: varchar("doc_status", { length: 30 })
      .default("uploaded")
      .notNull(),
    verificationStatus: varchar("verification_status", { length: 30 }).default(
      "pending",
    ),

    verifiedAt: timestamp("verified_at"),
    verifiedBy: uuid("verified_by"),

    rejectionReason: text("rejection_reason"),

    extractedData: jsonb("extracted_data").default({}),
    apiVerificationResults: jsonb("api_verification_results").default({}),
    metadata: jsonb("metadata").default({}),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    applicationIdIdx: index("dealer_onboarding_documents_application_id_idx").on(
      table.applicationId,
    ),
  }),
);

export const scrapeRuns = pgTable("scraper_runs", {
  id: text("id").primaryKey(),

  status: text("status"),

  triggeredBy: text("triggered_by"),

  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),

  totalFound: integer("total_found"),
  newLeadsSaved: integer("new_leads_saved"),
  duplicatesSkipped: integer("duplicates_skipped"),

  cleanedLeads: integer("cleaned_leads"),
  durationMs: integer("duration_ms"),

  errorMessage: text("error_message"),

  searchQueries: json("search_queries"),

  totalChunks: integer("total_chunks").default(0),
  completedChunks: integer("completed_chunks").default(0),

  createdAt: timestamp("created_at").defaultNow(),
});

export const scraperRunChunks = pgTable("scraper_run_chunks", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  combinationQuery: text("combination_query").notNull(),
  status: text("status").default("pending").notNull(),
  leadsCount: integer("leads_count").default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const scraperLeads = pgTable("scraper_leads", {
  id: text("id").primaryKey(),

  name: text("name"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),

  city: text("city"),
  address: text("address"),

  source: text("source"),
  status: text("status"),

  createdAt: timestamp("created_at").defaultNow(),
});

export const scraperRaw = pgTable("scraper_raw", {
  id: text("id").primaryKey(),

  runId: text("run_id"),

  rawData: text("raw_data"),

  createdAt: timestamp("created_at").defaultNow(),
});

export const dealerLeads = pgTable("dealer_leads", {
  id: text("id").primaryKey(),

  dealer_id: text("dealer_id"),
  dealer_name: text("dealer_name"),
  phone: text("phone").unique(),
  language: text("language"),
  shop_name: text("shop_name"),
  location: text("location"),

  follow_up_history: jsonb("follow_up_history"),
  current_status: text("current_status"),
  total_attempts: integer("total_attempts"),
  final_intent_score: integer("final_intent_score"),

  memory: jsonb("memory"),
  overall_summary: text("overall_summary"),

  created_at: timestamp("created_at").defaultNow(),
  next_call_at: timestamp("next_call_at", { withTimezone: true }),

  assigned_to: text("assigned_to"), // sales manager name
  approved_by: text("approved_by"), // admin who approved
  rejected_by: text("rejected_by"), // admin who rejected
});

export const scraperLeadsDuplicates = pgTable("scraper_leads_duplicates", {
  id: text("id").primaryKey(),

  originalLeadId: text("original_lead_id"),

  name: text("name"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),

  city: text("city"),
  address: text("address"),

  source: text("source"),
  status: text("status"),

  createdAt: timestamp("created_at").defaultNow(),
});

// --- NOTIFICATIONS ---

export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  user_id: uuid("user_id"), // target user (dealer user id)
  dealer_id: varchar("dealer_id", { length: 255 }), // target dealer account
  lead_id: varchar("lead_id", { length: 100 }),
  type: varchar("type", { length: 50 }).notNull(), // kyc_accepted, kyc_rejected, kyc_docs_requested, kyc_approved, kyc_rejected_final
  title: text("title").notNull(),
  message: text("message").notNull(),
  data: jsonb("data"), // extra context (verification_type, notes, etc.)
  read: boolean("read").default(false),
  read_at: timestamp("read_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const scraperCityQueue = pgTable("scraper_city_queue", {
  id: text("id").primaryKey(),
  base_query: text("base_query").notNull(),
  state: text("state").notNull(),
  city: text("city").notNull(),
  full_query: text("full_query").notNull(),
  status: text("status").default("pending"),
  leads_found: integer("leads_found").default(0),
  new_leads: integer("new_leads").default(0),
  duplicates: integer("duplicates").default(0),
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
  sub_category: varchar("sub_category", { length: 100 }),

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
  id: varchar("id", { length: 255 }).primaryKey(), // LS-YYYYMMDD-NNN
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => leads.id, { onDelete: "cascade" })
    .notNull(),
  product_selection_id: varchar("product_selection_id", { length: 255 }),

  // 10 BRD fields for sanction
  loan_amount: decimal("loan_amount", { precision: 12, scale: 2 }),
  down_payment: decimal("down_payment", { precision: 12, scale: 2 }),
  file_charge: decimal("file_charge", { precision: 12, scale: 2 }),
  subvention: decimal("subvention", { precision: 12, scale: 2 }),
  disbursement_amount: decimal("disbursement_amount", { precision: 12, scale: 2 }),
  emi: decimal("emi", { precision: 12, scale: 2 }),
  tenure_months: integer("tenure_months"),
  roi: decimal("roi", { precision: 5, scale: 2 }),
  loan_approved_by: text("loan_approved_by"), // lender/NBFC name
  loan_file_number: varchar("loan_file_number", { length: 100 }),

  // Status
  status: varchar("status", { length: 30 }).default("sanctioned").notNull(), // sanctioned, rejected, dealer_approved
  rejection_reason: text("rejection_reason"),

  // Admin audit
  sanctioned_by: uuid("sanctioned_by"),
  sanctioned_at: timestamp("sanctioned_at", { withTimezone: true }).defaultNow(),

  // Dealer/customer approval (Step 5 OTP)
  dealer_approved: boolean("dealer_approved").default(false),
  dealer_approved_at: timestamp("dealer_approved_at", { withTimezone: true }),
  dealer_approved_by: uuid("dealer_approved_by"),

  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- STEP 5: OTP CONFIRMATION (dispatch authorisation) ---

export const otpConfirmations = pgTable("otp_confirmations", {
  id: varchar("id", { length: 255 }).primaryKey(), // OTP-YYYYMMDD-NNN
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => leads.id, { onDelete: "cascade" })
    .notNull(),
  otp_type: varchar("otp_type", { length: 50 }).default("dispatch_confirmation").notNull(),
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

  // Admin override path (BRD §4220) — stubbed for now
  override_by_admin: boolean("override_by_admin").default(false),
  override_reason: text("override_reason"),
  override_by: uuid("override_by"),
});

// --- STEP 5: AFTER-SALES RECORDS (post-dispatch service handle) ---

export const afterSalesRecords = pgTable("after_sales_records", {
  id: varchar("id", { length: 255 }).primaryKey(), // AS-YYYY-NNN
  lead_id: varchar("lead_id", { length: 255 })
    .references(() => leads.id, { onDelete: "set null" }),
  warranty_id: varchar("warranty_id", { length: 255 }),
  battery_serial: varchar("battery_serial", { length: 255 }),
  customer_id: varchar("customer_id", { length: 255 }),
  dealer_id: varchar("dealer_id", { length: 255 }),
  payment_mode: varchar("payment_mode", { length: 20 }), // cash, finance
  opened_at: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(), // active, closed
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
export const nbfcTenants = pgTable("nbfc_tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(), // 'demo-nbfc'
  display_name: text("display_name").notNull(), // 'Demo NBFC Pvt Ltd'
  contact_email: text("contact_email"),
  aum_inr: decimal("aum_inr", { precision: 16, scale: 2 }), // displayed in header pill
  active_loans: integer("active_loans").default(0).notNull(), // denormalized, refreshed nightly
  is_active: boolean("is_active").default(true).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Many-to-many between users and tenants. Most NBFC partner users belong to
// exactly one tenant; some Itarang internal operators may belong to many.
export const nbfcUsers = pgTable(
  "nbfc_users",
  {
    user_id: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    tenant_id: uuid("tenant_id")
      .references(() => nbfcTenants.id, { onDelete: "cascade" })
      .notNull(),
    role: varchar("role", { length: 32 }).default("viewer").notNull(), // 'admin' | 'viewer'
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
    loan_application_id: varchar("loan_application_id", { length: 255 })
      .primaryKey()
      .references(() => loanApplications.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id")
      .references(() => nbfcTenants.id, { onDelete: "restrict" })
      .notNull(),
    vehicleno: varchar("vehicleno", { length: 64 }), // joins IoT vehicle_state.vehicleno
    emi_amount: decimal("emi_amount", { precision: 12, scale: 2 }),
    emi_due_date_dom: integer("emi_due_date_dom"), // day-of-month
    current_dpd: integer("current_dpd").default(0).notNull(), // refreshed nightly
    outstanding_amount: decimal("outstanding_amount", { precision: 14, scale: 2 }),
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
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(), // 'usage-drop-7d'
  title: text("title").notNull(),
  description: text("description").notNull(), // 1-paragraph statement
  test_method: varchar("test_method", { length: 16 }).notNull(), // 'sql' | 'js' | 'python'
  test_definition: jsonb("test_definition").notNull(), // SQL string / JS predicate / Python source
  source: varchar("source", { length: 16 }).default("human").notNull(), // 'human' | 'llm-v1'
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  retired_at: timestamp("retired_at", { withTimezone: true }), // soft-delete
});

// One row per (tenant, hypothesis, run). Risk page reads the latest run per
// (tenant, hypothesis); older runs serve as a time series for the audit page.
export const riskCardRuns = pgTable(
  "risk_card_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .references(() => nbfcTenants.id, { onDelete: "cascade" })
      .notNull(),
    hypothesis_id: uuid("hypothesis_id")
      .references(() => riskHypotheses.id, { onDelete: "cascade" })
      .notNull(),
    run_at: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    severity: varchar("severity", { length: 16 }).notNull(), // 'high' | 'warn' | 'ok'
    finding_summary: text("finding_summary").notNull(), // 1-line headline
    affected_count: integer("affected_count").default(0).notNull(),
    total_count: integer("total_count").default(0).notNull(),
    evidence_json: jsonb("evidence_json"), // sample rows + chart spec for drawer
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
    applicationId: uuid("application_id")
      .notNull()
      .references(() => dealerOnboardingApplications.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    status: varchar("status", { length: 30 }).default("pending").notNull(),
    requestedBy: uuid("requested_by"),
    remarks: text("remarks").notNull(),
    requestedFields: jsonb("requested_fields").$type<string[]>().default([]).notNull(),
    requestedDocuments: jsonb("requested_documents").$type<string[]>().default([]).notNull(),
    dealerSubmittedAt: timestamp("dealer_submitted_at"),
    dealerNote: text("dealer_note"),
    appliedBy: uuid("applied_by"),
    appliedAt: timestamp("applied_at"),
    // sha256 hex of the raw token sent in the dealer email — never store the
    // raw token. Lookup is by hash.
    tokenHash: text("token_hash").notNull().unique(),
    tokenExpiresAt: timestamp("token_expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    applicationIdx: index("dealer_correction_rounds_application_id_idx").on(
      table.applicationId,
    ),
    statusIdx: index("dealer_correction_rounds_status_idx").on(table.status),
    tokenHashIdx: index("dealer_correction_rounds_token_hash_idx").on(
      table.tokenHash,
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
    roundId: uuid("round_id")
      .notNull()
      .references(() => dealerCorrectionRounds.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 20 }).notNull(), // "field" | "document"
    key: varchar("key", { length: 100 }).notNull(),
    previousValue: text("previous_value"),
    newValue: text("new_value"),
    previousDocumentId: uuid("previous_document_id"),
    newDocumentId: uuid("new_document_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    roundIdx: index("dealer_correction_items_round_id_idx").on(table.roundId),
  }),
);
