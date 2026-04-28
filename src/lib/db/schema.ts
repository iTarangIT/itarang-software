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
  bigint,
  date,
  serial,
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
  dealerId: varchar("dealer_id", { length: 255 }),
  phone: text(),
  avatarUrl: text("avatar_url"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  passwordHash: text("password_hash"),
  mustChangePassword: boolean("must_change_password").default(false).notNull(),
});

// --- PHASE 0: MVP ---

export const productCategories = pgTable("product_categories", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: text().notNull(),
  slug: text().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const products = pgTable(
  "products",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    categoryId: uuid("category_id").notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    voltageV: integer("voltage_v").notNull(),
    capacityAh: integer("capacity_ah").notNull(),
    sku: text().notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    hsnCode: varchar("hsn_code", { length: 8 }),
    assetType: varchar("asset_type", { length: 50 }),
    isSerialized: boolean("is_serialized").default(true).notNull(),
    warrantyMonths: integer("warranty_months").default(0).notNull(),
    status: varchar({ length: 20 }).default('active').notNull(),
    price: integer(),
  },
  (table) => ({
    catSortIdx: index("idx_products_category_sort").on(
      table.categoryId,
      table.sortOrder,
    ),
    voltCapIdx: index("idx_products_voltage_capacity").on(
      table.voltageV,
      table.capacityAh,
    ),
  }),
);

export const oems = pgTable("oems", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  businessEntityName: text("business_entity_name").notNull(),
  gstin: varchar({ length: 15 }).notNull(),
  pan: varchar({ length: 10 }),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text(),
  state: text(),
  pincode: varchar({ length: 6 }),
  bankName: text("bank_name"),
  bankAccountNumber: text("bank_account_number").notNull(),
  ifscCode: varchar("ifsc_code", { length: 11 }).notNull(),
  bankProofUrl: text("bank_proof_url"),
  status: varchar({ length: 20 }).default('active').notNull(),
  onboardingStatus: varchar("onboarding_status", { length: 30 }).default('pending').notNull(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const oemContacts = pgTable("oem_contacts", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  oemId: varchar("oem_id", { length: 255 }).notNull(),
  name: text().notNull(),
  designation: text(),
  email: text(),
  phone: varchar({ length: 20 }),
  isPrimary: boolean("is_primary").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  contactRole: varchar("contact_role", { length: 50 }),
  contactName: text("contact_name"),
  contactPhone: varchar("contact_phone", { length: 20 }),
  contactEmail: text("contact_email"),
});

export const inventory = pgTable("inventory", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  oemId: varchar("oem_id", { length: 255 }),
  oemName: text("oem_name"),
  productCatalogId: varchar("product_catalog_id", { length: 255 }),
  hsnCode: varchar("hsn_code", { length: 8 }),
  assetCategory: varchar("asset_category", { length: 20 }).notNull(),
  assetType: varchar("asset_type", { length: 50 }).notNull(),
  modelType: text("model_type").notNull(),
  serialNumber: varchar("serial_number", { length: 255 }),
  isSerialized: boolean("is_serialized").default(true).notNull(),
  warrantyMonths: integer("warranty_months").default(0).notNull(),
  status: varchar({ length: 30 }).default('in_stock').notNull(),
  batchNumber: varchar("batch_number", { length: 100 }),
  receivedDate: timestamp("received_date", { withTimezone: true }),
  pdiStatus: varchar("pdi_status", { length: 20 }).default('pending'),
  pdiCompletedAt: timestamp("pdi_completed_at", { withTimezone: true }),
  pdiBy: uuid("pdi_by"),
  dealerId: varchar("dealer_id", { length: 255 }),
  allocatedToDealerAt: timestamp("allocated_to_dealer_at", { withTimezone: true }),
  soldAt: timestamp("sold_at", { withTimezone: true }),
  dealId: varchar("deal_id", { length: 255 }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  productId: uuid("product_id"),
  inventoryAmount: numeric("inventory_amount", { precision: 12, scale:  2 }),
  gstPercent: numeric("gst_percent", { precision: 5, scale:  2 }),
  gstAmount: numeric("gst_amount", { precision: 12, scale:  2 }),
  finalAmount: numeric("final_amount", { precision: 12, scale:  2 }),
  oemInvoiceNumber: text("oem_invoice_number"),
  oemInvoiceDate: timestamp("oem_invoice_date", { withTimezone: true }),
  oemInvoiceUrl: text("oem_invoice_url"),
  productManualUrl: text("product_manual_url"),
  warrantyDocumentUrl: text("warranty_document_url"),
  warehouseLocation: text("warehouse_location"),
  manufacturingDate: timestamp("manufacturing_date", { withTimezone: true }),
  expiryDate: timestamp("expiry_date", { withTimezone: true }),
  quantity: integer(),
  iotImeiNo: varchar("iot_imei_no", { length: 255 }),
  linkedLeadId: varchar("linked_lead_id", { length: 255 }),
  dispatchDate: timestamp("dispatch_date", { withTimezone: true }),
  socPercent: numeric("soc_percent", { precision: 5, scale:  2 }),
  socLastSyncAt: timestamp("soc_last_sync_at", { withTimezone: true }),
});

// --- DEALER SALES ---
export const leads = pgTable("leads", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  dealerId: varchar("dealer_id", { length: 255 }),
  assignedTo: uuid("assigned_to"),
  ownerName: text("owner_name"),
  ownerContact: varchar("owner_contact", { length: 20 }),
  phone: varchar({ length: 20 }),
  mobile: varchar({ length: 20 }),
  permanentAddress: text("permanent_address"),
  localAddress: text("local_address"),
  vehicleOwnership: varchar("vehicle_ownership", { length: 50 }),
  batteryType: varchar("battery_type", { length: 50 }),
  assetModel: text("asset_model"),
  assetPrice: numeric("asset_price", { precision: 12, scale:  2 }),
  familyMembers: integer("family_members"),
  drivingExperience: integer("driving_experience"),
  loanRequired: boolean("loan_required").default(false),
  interestLevel: varchar("interest_level", { length: 20 }).default('cold'),
  leadScore: integer("lead_score").default(0),
  status: varchar({ length: 30 }).default('new'),
  kycStatus: varchar("kyc_status", { length: 30 }).default('pending'),
  kycScore: integer("kyc_score").default(0),
  kycCompletedAt: timestamp("kyc_completed_at", { withTimezone: true }),
  paymentMethod: varchar("payment_method", { length: 20 }),
  consentStatus: varchar("consent_status", { length: 20 }).default('pending'),
  hasCoBorrower: boolean("has_co_borrower").default(false),
  hasAdditionalDocsRequired: boolean("has_additional_docs_required").default(false),
  interimStepStatus: varchar("interim_step_status", { length: 20 }).default('pending'),
  kycDraftData: jsonb("kyc_draft_data"),
  stepStatus: jsonb("step_status"),
  source: varchar({ length: 50 }),
  remarks: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  leadSource: varchar("lead_source", { length: 50 }).notNull(),
  leadStatus: varchar("lead_status", { length: 50 }).default('new').notNull(),
  businessName: text("business_name"),
  ownerEmail: text("owner_email"),
  state: varchar({ length: 100 }),
  city: varchar({ length: 100 }),
  shopAddress: text("shop_address"),
  leadType: varchar("lead_type", { length: 20 }),
  vehicleRc: varchar("vehicle_rc", { length: 50 }),
  fullName: text("full_name"),
  fatherOrHusbandName: text("father_or_husband_name"),
  dob: timestamp({ withTimezone: true }),
  currentAddress: text("current_address"),
  isCurrentSame: boolean("is_current_same").default(false).notNull(),
  productCategoryId: varchar("product_category_id", { length: 255 }),
  productTypeId: varchar("product_type_id", { length: 255 }),
  vehicleOwnerName: text("vehicle_owner_name"),
  vehicleOwnerPhone: varchar("vehicle_owner_phone", { length: 20 }),
  autoFilled: boolean("auto_filled").default(false).notNull(),
  ocrStatus: varchar("ocr_status", { length: 20 }),
  ocrError: text("ocr_error"),
  referenceId: varchar("reference_id", { length: 255 }),
  interestedIn: jsonb("interested_in"),
  batteryOrderExpected: integer("battery_order_expected"),
  investmentCapacity: numeric("investment_capacity", { precision: 12, scale:  2 }),
  businessType: varchar("business_type", { length: 50 }),
  qualifiedBy: uuid("qualified_by"),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
  qualificationNotes: text("qualification_notes"),
  convertedDealId: varchar("converted_deal_id", { length: 255 }),
  convertedAt: timestamp("converted_at", { withTimezone: true }),
  totalAiCalls: integer("total_ai_calls").default(0),
  lastAiCallAt: timestamp("last_ai_call_at", { withTimezone: true }),
  lastCallOutcome: text("last_call_outcome"),
  aiPriorityScore: numeric("ai_priority_score", { precision: 5, scale:  2 }),
  nextCallAfter: timestamp("next_call_after", { withTimezone: true }),
  doNotCall: boolean("do_not_call").default(false),
  workflowStep: integer("workflow_step").default(1).notNull(),
  primaryProductId: uuid("primary_product_id"),
  uploaderId: uuid("uploader_id").notNull(),
  aiManaged: boolean("ai_managed").default(false),
  aiOwner: text("ai_owner"),
  manualTakeover: boolean("manual_takeover").default(false),
  lastAiActionAt: timestamp("last_ai_action_at", { withTimezone: true }),
  intentScore: integer("intent_score"),
  intentReason: text("intent_reason"),
  nextCallAt: timestamp("next_call_at", { withTimezone: true }),
  callPriority: integer("call_priority").default(0),
  conversationSummary: text("conversation_summary"),
  lastCallStatus: text("last_call_status"),
  smReviewStatus: varchar("sm_review_status", { length: 30 }).default('not_submitted'),
  submittedToSmAt: timestamp("submitted_to_sm_at", { withTimezone: true }),
  smAssignedTo: uuid("sm_assigned_to"),
  consentLinkUrl: text("consent_link_url"),
  consentLinkSentAt: timestamp("consent_link_sent_at", { withTimezone: true }),
  consentLinkExpiresAt: timestamp("consent_link_expires_at", { withTimezone: true }),
  consentDeliveryChannel: varchar("consent_delivery_channel", { length: 50 }),
  esignTransactionId: varchar("esign_transaction_id", { length: 255 }),
  esignCertificateId: varchar("esign_certificate_id", { length: 255 }),
  esignCompletedAt: timestamp("esign_completed_at", { withTimezone: true }),
  esignFailedAt: timestamp("esign_failed_at", { withTimezone: true }),
  esignErrorCode: varchar("esign_error_code", { length: 100 }),
  esignErrorMessage: text("esign_error_message"),
  consentVerifiedBy: uuid("consent_verified_by"),
  consentVerifiedAt: timestamp("consent_verified_at", { withTimezone: true }),
  consentVerificationNotes: text("consent_verification_notes"),
  consentFinal: boolean("consent_final").default(false),
  consentRejectionReason: varchar("consent_rejection_reason", { length: 255 }),
  consentRejectionNotes: text("consent_rejection_notes"),
  consentRejectedBy: uuid("consent_rejected_by"),
  consentRejectedAt: timestamp("consent_rejected_at", { withTimezone: true }),
  consentAttemptCount: integer("consent_attempt_count").default(0),
  googlePlaceId: varchar("google_place_id", { length: 255 }),
  website: text(),
  googleMapsUri: text("google_maps_uri"),
  googleRating: numeric("google_rating", { precision: 3, scale:  1 }),
  googleRatingsCount: integer("google_ratings_count"),
  googleBusinessStatus: varchar("google_business_status", { length: 50 }),
  googleBusinessTypes: jsonb("google_business_types"),
  rawSourcePayload: jsonb("raw_source_payload"),
  scrapeQuery: text("scrape_query"),
  scrapeBatchId: varchar("scrape_batch_id", { length: 255 }),
  scrapedAt: timestamp("scraped_at", { withTimezone: true }),
  phoneQuality: varchar("phone_quality", { length: 20 }).default('valid'),
  normalizedPhone: varchar("normalized_phone", { length: 20 }),
  intentBand: varchar("intent_band", { length: 20 }),
  intentScoredAt: timestamp("intent_scored_at", { withTimezone: true }),
  intentDetails: jsonb("intent_details"),
  couponCode: varchar("coupon_code", { length: 20 }),
  couponStatus: varchar("coupon_status", { length: 20 }),
  borrowerConsentStatus: varchar("borrower_consent_status", { length: 30 }).default('awaiting_signature'),
  soldAt: timestamp("sold_at", { withTimezone: true }),
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
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  loanRequired: boolean("loan_required").default(false),
  loanAmount: numeric("loan_amount", { precision: 12, scale:  2 }),
  interestRate: numeric("interest_rate", { precision: 5, scale:  2 }),
  tenureMonths: integer("tenure_months"),
  processingFee: numeric("processing_fee", { precision: 10, scale:  2 }),
  emi: numeric({ precision: 10, scale:  2 }),
  downPayment: numeric("down_payment", { precision: 12, scale:  2 }),
  financeType: varchar("finance_type", { length: 50 }),
  financier: varchar({ length: 100 }),
  assetType: varchar("asset_type", { length: 50 }),
  loanType: varchar("loan_type", { length: 50 }),
  vehicleRc: text("vehicle_rc"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const personalDetails = pgTable("personal_details", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  aadhaarNo: varchar("aadhaar_no", { length: 12 }),
  panNo: varchar("pan_no", { length: 10 }),
  dob: timestamp({ withTimezone: true }),
  email: text(),
  income: numeric({ precision: 12, scale:  2 }),
  fatherHusbandName: text("father_husband_name"),
  maritalStatus: varchar("marital_status", { length: 20 }),
  spouseName: text("spouse_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  financeType: varchar("finance_type", { length: 50 }),
  financier: varchar({ length: 100 }),
  assetType: varchar("asset_type", { length: 50 }),
  vehicleRc: varchar("vehicle_rc", { length: 50 }),
  loanType: varchar("loan_type", { length: 100 }),
  localAddress: text("local_address"),
  dobConfidence: numeric("dob_confidence", { precision: 5, scale:  2 }),
  nameConfidence: numeric("name_confidence", { precision: 5, scale:  2 }),
  addressConfidence: numeric("address_confidence", { precision: 5, scale:  2 }),
  ocrProcessedAt: timestamp("ocr_processed_at", { withTimezone: true }),
  permanentAddress: text("permanent_address"),
  bankAccountNumber: varchar("bank_account_number", { length: 50 }),
  bankIfsc: varchar("bank_ifsc", { length: 20 }),
  bankName: varchar("bank_name", { length: 100 }),
  bankBranch: varchar("bank_branch", { length: 100 }),
});

export const documents = pgTable("documents", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  type: varchar({ length: 50 }).notNull(),
  url: text().notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  documentType: varchar("document_type", { length: 50 }),
  fileUrl: text("file_url"),
});

export const leadDocuments = pgTable("lead_documents", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  documentType: varchar("document_type", { length: 50 }).notNull(),
  documentUrl: text("document_url").notNull(),
  status: varchar({ length: 20 }).default('uploaded'),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  dealerId: varchar("dealer_id", { length: 255 }),
  userId: uuid("user_id"),
  docType: varchar("doc_type", { length: 100 }),
  storagePath: text("storage_path"),
});

export const leadAssignments = pgTable("lead_assignments", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  leadOwner: uuid("lead_owner").notNull(),
  assignedBy: uuid("assigned_by").notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  leadActor: uuid("lead_actor"),
  actorAssignedBy: uuid("actor_assigned_by"),
  actorAssignedAt: timestamp("actor_assigned_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const assignmentChangeLogs = pgTable("assignment_change_logs", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  oldUserId: uuid("old_user_id"),
  newUserId: uuid("new_user_id"),
  changedBy: uuid("changed_by"),
  changeType: varchar("change_type", { length: 50 }).notNull(),
  reason: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  changeReason: text("change_reason"),
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const deals = pgTable("deals", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  products: jsonb().notNull(),
  lineTotal: numeric("line_total", { precision: 12, scale:  2 }).notNull(),
  gstAmount: numeric("gst_amount", { precision: 12, scale:  2 }).notNull(),
  transportationCost: numeric("transportation_cost", { precision: 10, scale:  2 }).default('0').notNull(),
  transportationGstPercent: integer("transportation_gst_percent").default(18).notNull(),
  totalPayable: numeric("total_payable", { precision: 12, scale:  2 }).notNull(),
  paymentTerm: varchar("payment_term", { length: 20 }).notNull(),
  creditPeriodMonths: integer("credit_period_months"),
  dealStatus: varchar("deal_status", { length: 50 }).default('pending_approval_l1').notNull(),
  isImmutable: boolean("is_immutable").default(false).notNull(),
  invoiceNumber: text("invoice_number"),
  invoiceUrl: text("invoice_url"),
  invoiceIssuedAt: timestamp("invoice_issued_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  expiredBy: uuid("expired_by"),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  expiryReason: text("expiry_reason"),
  rejectedBy: uuid("rejected_by"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const approvals = pgTable("approvals", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  level: integer().notNull(),
  approverRole: varchar("approver_role", { length: 50 }).notNull(),
  status: varchar({ length: 20 }).default('pending').notNull(),
  approverId: uuid("approver_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  notes: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  decisionAt: timestamp("decision_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  comments: text(),
});

export const orderDisputes = pgTable("order_disputes", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  orderId: varchar("order_id", { length: 255 }).notNull(),
  disputeType: varchar("dispute_type", { length: 50 }).notNull(),
  description: text().notNull(),
  status: varchar({ length: 20 }).default('open').notNull(),
  resolution: text(),
  raisedBy: uuid("raised_by").notNull(),
  resolvedBy: uuid("resolved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  photosUrls: jsonb("photos_urls"),
  resolutionStatus: varchar("resolution_status", { length: 50 }).default('open').notNull(),
  resolutionDetails: text("resolution_details"),
  actionTaken: text("action_taken"),
  resolvedAt: timestamp("resolved_at"),
  assignedTo: uuid("assigned_to"),
  createdBy: uuid("created_by"),
});

export const slas = pgTable("slas", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  deadline: timestamp({ withTimezone: true }),
  breached: boolean().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  assignedTo: uuid("assigned_to"),
  status: varchar({ length: 20 }).default('active').notNull(),
  completedAt: timestamp("completed_at"),
  escalatedTo: uuid("escalated_to"),
  escalatedAt: timestamp("escalated_at"),
  workflowStep: varchar("workflow_step", { length: 100 }),
  slaDeadline: timestamp("sla_deadline"),
});

// --- PDI ---

export const oemInventoryForPDI = pgTable("oem_inventory_for_pdi", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  inventoryId: varchar("inventory_id", { length: 255 }),
  oemId: varchar("oem_id", { length: 255 }),
  status: varchar({ length: 20 }).default('pending'),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  serialNumber: varchar("serial_number", { length: 255 }),
  pdiStatus: varchar("pdi_status", { length: 20 }).default('pending').notNull(),
  pdiRecordId: varchar("pdi_record_id", { length: 255 }),
  provisionId: varchar("provision_id", { length: 255 }),
});

export const pdiRecords = pgTable("pdi_records", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  inventoryId: varchar("inventory_id", { length: 255 }),
  performedBy: uuid("performed_by"),
  status: varchar({ length: 20 }).default('pending').notNull(),
  checklist: jsonb(),
  notes: text(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  iotImeiNo: varchar("iot_imei_no", { length: 255 }),
  voltage: numeric({ precision: 5, scale:  2 }),
  soc: integer(),
  capacityAh: numeric("capacity_ah", { precision: 6, scale:  2 }),
  resistanceMohm: numeric("resistance_mohm", { precision: 6, scale:  2 }),
  temperatureCelsius: numeric("temperature_celsius", { precision: 5, scale:  2 }),
  locationAddress: text("location_address"),
  productManualUrl: text("product_manual_url"),
  warrantyDocumentUrl: text("warranty_document_url"),
  pdiPhotos: jsonb("pdi_photos"),
  failureReason: text("failure_reason"),
  inspectedAt: timestamp("inspected_at", { withTimezone: true }).defaultNow().notNull(),
  oemInventoryId: varchar("oem_inventory_id", { length: 255 }),
  provisionId: varchar("provision_id", { length: 255 }),
  serviceEngineerId: uuid("service_engineer_id"),
  physicalCondition: text("physical_condition"),
  dischargingConnector: varchar("discharging_connector", { length: 20 }),
  chargingConnector: varchar("charging_connector", { length: 20 }),
  productorSticker: varchar("productor_sticker", { length: 50 }),
  latitude: numeric({ precision: 10, scale: 8 }),
  longitude: numeric({ precision: 11, scale: 8 }),
  pdiStatus: varchar("pdi_status", { length: 20 }),
});

export const auditLogs = pgTable("audit_logs", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  entityType: varchar("entity_type", { length: 50 }),
  entityId: varchar("entity_id", { length: 255 }),
  action: varchar({ length: 50 }),
  performedBy: uuid("performed_by"),
  oldData: jsonb("old_data"),
  newData: jsonb("new_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  changes: jsonb(),
  timestamp: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// --- ACCOUNTS ---

export const accounts = pgTable("accounts", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  businessEntityName: text("business_entity_name").notNull(),
  gstin: varchar({ length: 15 }).notNull(),
  pan: varchar({ length: 10 }),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text(),
  state: text(),
  pincode: varchar({ length: 6 }),
  bankName: text("bank_name"),
  bankAccountNumber: text("bank_account_number"),
  ifscCode: varchar("ifsc_code", { length: 11 }),
  bankProofUrl: text("bank_proof_url"),
  dealerCode: varchar("dealer_code", { length: 50 }),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: varchar("contact_phone", { length: 20 }),
  status: varchar({ length: 20 }).default('active').notNull(),
  onboardingStatus: varchar("onboarding_status", { length: 30 }).default('pending').notNull(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- PROCUREMENT ---

export const provisions = pgTable("provisions", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  orderId: varchar("order_id", { length: 255 }),
  oemId: varchar("oem_id", { length: 255 }),
  amount: numeric({ precision: 12, scale:  2 }),
  status: varchar({ length: 20 }).default('pending'),
  notes: text(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  remarks: text(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  oemName: text("oem_name"),
  products: jsonb(),
  expectedDeliveryDate: timestamp("expected_delivery_date", { withTimezone: true }),
});

export const orders = pgTable(
  "orders",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    provisionId: varchar("provision_id", { length: 255 }).notNull(),
    oemId: varchar("oem_id", { length: 255 }).notNull(),
    accountId: varchar("account_id", { length: 255 }),
    orderItems: jsonb("order_items").notNull(),
    totalAmount: numeric("total_amount", { precision: 12, scale:  2 }).notNull(),
    paymentTerm: varchar("payment_term", { length: 20 }).notNull(),
    creditPeriodDays: integer("credit_period_days"),
    piUrl: text("pi_url"),
    piAmount: numeric("pi_amount", { precision: 12, scale:  2 }),
    invoiceUrl: text("invoice_url"),
    grnId: text("grn_id"),
    grnDate: timestamp("grn_date", { withTimezone: true }),
    paymentStatus: varchar("payment_status", { length: 20 }).default('unpaid').notNull(),
    paymentAmount: numeric("payment_amount", { precision: 12, scale:  2 }).default('0').notNull(),
    paymentMode: varchar("payment_mode", { length: 50 }),
    transactionId: text("transaction_id"),
    paymentDate: timestamp("payment_date", { withTimezone: true }),
    orderStatus: varchar("order_status", { length: 50 }).default('pi_awaited').notNull(),
    deliveryStatus: varchar("delivery_status", { length: 20 }).default('pending').notNull(),
    expectedDeliveryDate: timestamp("expected_delivery_date", { withTimezone: true }),
    actualDeliveryDate: timestamp("actual_delivery_date", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    reorderTatDays: integer("reorder_tat_days"),
  },
  (table) => {
    return {
      ordersCreatedAtIdx: index("orders_created_at_idx").on(table.createdAt),
      ordersPaymentStatusIdx: index("orders_payment_status_idx").on(
        table.paymentStatus,
      ),
    };
  },
);

export const bolnaCalls = pgTable(
  "bolna_calls",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }),
    bolnaCallId: text("bolna_call_id"),
    agentId: text("agent_id"),
    status: varchar({ length: 20 }),
    recordingUrl: text("recording_url"),
    transcript: text(),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    currentPhase: varchar("current_phase", { length: 100 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    transcriptChunk: text("transcript_chunk"),
    chunkReceivedAt: timestamp("chunk_received_at", { withTimezone: true }),
    fullTranscript: text("full_transcript"),
    transcriptFetchedAt: timestamp("transcript_fetched_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      bolnaCallIdIdx: index("bolna_calls_bolna_call_id_idx").on(
        table.bolnaCallId,
      ),
      leadIdIdx: index("bolna_calls_lead_id_idx").on(table.leadId),
      statusIdx: index("bolna_calls_status_idx").on(table.status),
      startedAtIdx: index("bolna_calls_started_at_idx").on(table.startedAt),
    };
  },
);

export const aiCallLogs = pgTable(
  "ai_call_logs",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }),
    provider: varchar({ length: 50 }),
    status: varchar({ length: 20 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    modelUsed: varchar("model_used", { length: 50 }),
    intentScore: integer("intent_score"),
    intentReason: text("intent_reason"),
    nextAction: varchar("next_action", { length: 50 }),
    agentId: varchar("agent_id", { length: 255 }),
    phoneNumber: varchar("phone_number", { length: 20 }),
    transcript: text(),
    summary: text(),
    recordingUrl: text("recording_url"),
    callDuration: integer("call_duration"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    callId: varchar("call_id", { length: 255 }).notNull(),
  },
  (table) => {
    return {
      aiCallLogsLeadIdIdx: index("ai_call_logs_lead_id_idx").on(table.leadId),
      aiCallLogsCallIdIdx: index("ai_call_logs_call_id_idx").on(table.callId),
    };
  },
);

// --- AI CALLS ---

export const callSessions = pgTable("call_sessions", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }),
  initiatedBy: uuid("initiated_by"),
  status: varchar({ length: 20 }).default('initiated'),
  provider: varchar({ length: 50 }),
  providerSessionId: text("provider_session_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  sessionId: text("session_id"),
});

export const callRecords = pgTable("call_records", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }),
  sessionId: varchar("session_id", { length: 255 }),
  recordingUrl: text("recording_url"),
  transcript: text(),
  summary: text(),
  sentiment: varchar({ length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  bolnaCallId: varchar("bolna_call_id", { length: 255 }),
  status: text().default('queued'),
  durationSeconds: integer("duration_seconds"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const conversationMessages = pgTable("conversation_messages", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  callRecordId: varchar("call_record_id", { length: 255 }).notNull(),
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
    fields: [products.categoryId],
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
    fields: [oems.createdBy],
    references: [users.id],
    relationName: "oem_creator",
  }),
  contacts: many(oemContacts),
}));

export const oemContactsRelations = relations(oemContacts, ({ one }) => ({
  oem: one(oems, { fields: [oemContacts.oemId], references: [oems.id] }),
}));

export const inventoryRelations = relations(inventory, ({ one }) => ({
  product: one(products, {
    fields: [inventory.productId],
    references: [products.id],
  }),
  creator: one(users, {
    fields: [inventory.createdBy],
    references: [users.id],
    relationName: "inventory_creator",
  }),
}));

// export const leadsRelations = relations(leads, ({ one, many }) => ({
//   uploader: one(users, {
//     fields: [leads.uploaderId],
//     references: [users.id],
//     relationName: "lead_uploader",
//   }),
//   qualifiedBy: one(users, {
//     fields: [leads.qualifiedBy],
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
      fields: [leadAssignments.leadId],
      references: [dealerLeads.id],
    }),
    owner: one(users, {
      fields: [leadAssignments.leadOwner],
      references: [users.id],
      relationName: "assigned_to_user",
    }),
    assigner: one(users, {
      fields: [leadAssignments.assignedBy],
      references: [users.id],
      relationName: "assigned_by_user",
    }),
    actor: one(users, {
      fields: [leadAssignments.leadActor],
      references: [users.id],
      relationName: "lead_actor_user",
    }),
    actorAssigner: one(users, {
      fields: [leadAssignments.actorAssignedBy],
      references: [users.id],
      relationName: "actor_assigned_by_user",
    }),
  }),
);

export const dealsRelations = relations(deals, ({ one, many }) => ({
  lead: one(dealerLeads, {
    fields: [deals.leadId],
    references: [dealerLeads.id],
  }),
  creator: one(users, {
    fields: [deals.createdBy],
    references: [users.id],
    relationName: "deal_creator",
  }),
  approvals: many(approvals),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  approver: one(users, {
    fields: [approvals.approverId],
    references: [users.id],
    relationName: "approver_user",
  }),
}));

export const slasRelations = relations(slas, ({ one }) => ({
  assignedUser: one(users, {
    fields: [slas.assignedTo],
    references: [users.id],
    relationName: "sla_assigned",
  }),
  escalatedUser: one(users, {
    fields: [slas.escalatedTo],
    references: [users.id],
    relationName: "sla_escalated",
  }),
}));

export const provisionsRelations = relations(provisions, ({ one, many }) => ({
  oem: one(oems, { fields: [provisions.oemId], references: [oems.id] }),
  creator: one(users, {
    fields: [provisions.createdBy],
    references: [users.id],
  }),
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one }) => ({
  provision: one(provisions, {
    fields: [orders.provisionId],
    references: [provisions.id],
  }),
  oem: one(oems, { fields: [orders.oemId], references: [oems.id] }),
  creator: one(users, { fields: [orders.createdBy], references: [users.id] }),
  account: one(accounts, {
    fields: [orders.accountId],
    references: [accounts.id],
  }),
}));

export const oemInventoryForPDIRelations = relations(
  oemInventoryForPDI,
  ({ one }) => ({
    inventory: one(inventory, {
      fields: [oemInventoryForPDI.inventoryId],
      references: [inventory.id],
    }),
    oem: one(oems, {
      fields: [oemInventoryForPDI.oemId],
      references: [oems.id],
    }),
    pdiRecord: one(pdiRecords, {
      fields: [oemInventoryForPDI.pdiRecordId],
      references: [pdiRecords.id],
    }),
  }),
);

// NOTE: pdiRecords.oemInventoryId / serviceEngineerId columns don't exist in the
// live DB. Relation commented out until those columns are added.
export const pdiRecordsRelations = relations(pdiRecords, ({ one }) => ({}));

export const assignmentChangeLogsRelations = relations(
  assignmentChangeLogs,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [assignmentChangeLogs.leadId],
      references: [dealerLeads.id],
    }),
    oldUser: one(users, {
      fields: [assignmentChangeLogs.oldUserId],
      references: [users.id],
    }),
    newUser: one(users, {
      fields: [assignmentChangeLogs.newUserId],
      references: [users.id],
    }),
    changedBy: one(users, {
      fields: [assignmentChangeLogs.changedBy],
      references: [users.id],
    }),
  }),
);

export const orderDisputesRelations = relations(orderDisputes, ({ one }) => ({
  order: one(orders, {
    fields: [orderDisputes.orderId],
    references: [orders.id],
  }),
  resolvedBy: one(users, {
    fields: [orderDisputes.resolvedBy],
    references: [users.id],
  }),
  // NOTE: orderDisputes.createdBy column doesn't exist in live DB; relation omitted.
}));

export const accountsRelations = relations(accounts, ({ many }) => ({
  orders: many(orders),
}));

export const bolnaCallsRelations = relations(bolnaCalls, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [bolnaCalls.leadId],
    references: [dealerLeads.id],
  }),
}));

export const aiCallLogsRelations = relations(aiCallLogs, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [aiCallLogs.leadId],
    references: [dealerLeads.id],
  }),
}));
export const callSessionsRelations = relations(callSessions, ({ many }) => ({
  records: many(callRecords),
}));

export const callRecordsRelations = relations(callRecords, ({ one, many }) => ({
  session: one(callSessions, {
    fields: [callRecords.sessionId],
    references: [callSessions.sessionId],
  }),
  lead: one(dealerLeads, {
    fields: [callRecords.leadId],
    references: [dealerLeads.id],
  }),
  messages: many(conversationMessages),
}));

export const conversationMessagesRelations = relations(
  conversationMessages,
  ({ one }) => ({
    record: one(callRecords, {
      fields: [conversationMessages.callRecordId],
      references: [callRecords.id],
    }),
  }),
);

// --- DEALER ADDITIONS (SOP Refinements) ---

export const campaigns = pgTable("campaigns", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  name: text().notNull(),
  type: varchar({ length: 20 }).notNull(),
  messageContent: text("message_content"),
  audienceFilter: jsonb("audience_filter"),
  totalAudience: integer("total_audience"),
  status: varchar({ length: 20 }).default('draft').notNull(),
  sentCount: integer("sent_count").default(0),
  deliveredCount: integer("delivered_count").default(0),
  failedCount: integer("failed_count").default(0),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  cost: numeric({ precision: 10, scale:  2 }),
  startedAt: timestamp("started_at", { withTimezone: true }),
});

// For "Process Loan" workflow tracking
export const loanApplications = pgTable("loan_applications", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  dealerId: varchar("dealer_id", { length: 255 }),
  applicantName: text("applicant_name"),
  loanAmount: numeric("loan_amount", { precision: 12, scale:  2 }),
  interestRate: numeric("interest_rate", { precision: 5, scale:  2 }),
  tenureMonths: integer("tenure_months"),
  emiAmount: numeric("emi_amount", { precision: 10, scale:  2 }),
  downPayment: numeric("down_payment", { precision: 12, scale:  2 }),
  facilitationFee: numeric("facilitation_fee", { precision: 10, scale:  2 }),
  facilitationFeeStatus: varchar("facilitation_fee_status", { length: 20 }).default('pending'),
  documentsUploaded: boolean("documents_uploaded").default(false),
  status: varchar({ length: 30 }).default('draft'),
  nbfcName: text("nbfc_name"),
  nbfcRefId: text("nbfc_ref_id"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  disbursedAt: timestamp("disbursed_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  companyValidationStatus: varchar("company_validation_status", { length: 20 }).default('pending').notNull(),
  applicationStatus: varchar("application_status", { length: 20 }).default('new').notNull(),
  facilitationFeeAmount: numeric("facilitation_fee_amount", { precision: 10, scale:  2 }),
  createdBy: uuid("created_by"),
});

// --- KYC MODULE ---

export const kycDocuments = pgTable(
  "kyc_documents",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    docType: varchar("doc_type", { length: 50 }).notNull(),
    fileUrl: text("file_url"),
    verificationStatus: varchar("verification_status", { length: 30 }).default('pending'),
    ocrData: jsonb("ocr_data"),
    apiResponse: jsonb("api_response"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    failedReason: text("failed_reason"),
    fileType: varchar("file_type", { length: 50 }),
    docStatus: varchar("doc_status", { length: 30 }).default('not_uploaded'),
    rejectionReason: text("rejection_reason"),
    uploadedBy: uuid("uploaded_by"),
    verifiedBy: uuid("verified_by"),
    docFor: varchar("doc_for", { length: 20 }).default('customer').notNull(),
  },
  (table) => {
    return {
      kycDocsLeadIdx: index("kyc_documents_lead_id_idx").on(table.leadId),
      kycDocsTypeIdx: index("kyc_documents_doc_type_idx").on(table.docType),
    };
  },
);

export const kycVerifications = pgTable(
  "kyc_verifications",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    verificationType: varchar("verification_type", { length: 50 }).notNull(),
    status: varchar({ length: 30 }).default('pending'),
    apiProvider: varchar("api_provider", { length: 50 }),
    apiRequest: jsonb("api_request"),
    apiResponse: jsonb("api_response"),
    failedReason: text("failed_reason"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    matchScore: numeric("match_score", { precision: 5, scale:  2 }),
    retryCount: integer("retry_count").default(0),
    adminAction: varchar("admin_action", { length: 30 }),
    adminActionBy: uuid("admin_action_by"),
    adminActionAt: timestamp("admin_action_at", { withTimezone: true }),
    adminActionNotes: text("admin_action_notes"),
    verificationFor: varchar("verification_for", { length: 20 }).default('customer').notNull(),
    applicant: varchar({ length: 20 }).default('primary').notNull(),
  },
  (table) => {
    return {
      kycVerLeadIdx: index("kyc_verifications_lead_id_idx").on(table.leadId),
      kycVerTypeIdx: index("kyc_verifications_type_idx").on(
        table.verificationType,
      ),
    };
  },
);

// --- DIGILOCKER TRANSACTIONS ---

export const digilockerTransactions = pgTable(
  "digilocker_transactions",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    verificationId: varchar("verification_id", { length: 255 }),
    referenceId: varchar("reference_id", { length: 255 }),
    decentroTxnId: varchar("decentro_txn_id", { length: 255 }),
    sessionId: varchar("session_id", { length: 255 }),
    status: varchar({ length: 50 }).default('initiated').notNull(),
    customerPhone: varchar("customer_phone", { length: 20 }),
    customerEmail: varchar("customer_email", { length: 255 }),
    digilockerUrl: text("digilocker_url"),
    shortUrl: text("short_url"),
    notificationChannel: varchar("notification_channel", { length: 20 }).default('sms'),
    linkSentAt: timestamp("link_sent_at", { withTimezone: true }),
    linkOpenedAt: timestamp("link_opened_at", { withTimezone: true }),
    customerAuthorizedAt: timestamp("customer_authorized_at", { withTimezone: true }),
    digilockerRawResponse: jsonb("digilocker_raw_response"),
    aadhaarExtractedData: jsonb("aadhaar_extracted_data"),
    crossMatchResult: jsonb("cross_match_result"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    smsMessageId: varchar("sms_message_id", { length: 255 }),
    smsDeliveredAt: timestamp("sms_delivered_at", { withTimezone: true }),
    smsFailedReason: text("sms_failed_reason"),
    smsAttempts: integer("sms_attempts").default(0).notNull(),
    aadhaarPdf: bytea("aadhaar_pdf"),
  },
  (table) => ({
    digilockerLeadIdx: index("digilocker_transactions_lead_idx").on(
      table.leadId,
    ),
    digilockerTxnIdx: index("digilocker_transactions_txn_idx").on(
      table.decentroTxnId,
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
    leadId: varchar("lead_id", { length: 255 }),
    fieldName: varchar("field_name", { length: 50 }),
    fieldValue: varchar("field_value", { length: 500 }),
    dataSource: varchar("data_source", { length: 20 }),
    enteredBy: uuid("entered_by"),
    enteredAt: timestamp("entered_at", { withTimezone: true }).defaultNow(),
    reason: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    kycDataAuditLeadIdx: index("kyc_data_audit_lead_idx").on(table.leadId),
  }),
);

export const consentRecords = pgTable("consent_records", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  consentType: varchar("consent_type", { length: 30 }).notNull(),
  channel: varchar({ length: 20 }),
  consentToken: text("consent_token"),
  consentLinkUrl: text("consent_link_url"),
  consentStatus: varchar("consent_status", { length: 20 }).default('awaiting_signature'),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  generatedPdfUrl: text("generated_pdf_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  consentFor: varchar("consent_for", { length: 20 }).default('primary').notNull(),
  consentLinkSentAt: timestamp("consent_link_sent_at", { withTimezone: true }),
  signedConsentUrl: text("signed_consent_url"),
  verifiedBy: uuid("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  consentLinkExpiresAt: timestamp("consent_link_expires_at", { withTimezone: true }),
  consentDeliveryChannel: varchar("consent_delivery_channel", { length: 20 }),
  signMethod: varchar("sign_method", { length: 30 }),
  esignTransactionId: varchar("esign_transaction_id", { length: 255 }),
  esignCertificateId: varchar("esign_certificate_id", { length: 255 }),
  esignProvider: varchar("esign_provider", { length: 50 }),
  esignErrorCode: varchar("esign_error_code", { length: 50 }),
  esignErrorMessage: text("esign_error_message"),
  signerAadhaarMasked: varchar("signer_aadhaar_masked", { length: 20 }),
  rejectedBy: uuid("rejected_by"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectionReason: varchar("rejection_reason", { length: 255 }),
  reviewerNotes: text("reviewer_notes"),
  consentAttemptCount: integer("consent_attempt_count").default(0),
  esignRetryCount: integer("esign_retry_count").default(0),
  adminViewedBy: uuid("admin_viewed_by"),
  adminViewedAt: timestamp("admin_viewed_at", { withTimezone: true }),
});

export const couponCodes = pgTable("coupon_codes", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  code: varchar({ length: 50 }).notNull(),
  dealerId: varchar("dealer_id", { length: 255 }),
  isUsed: boolean("is_used").default(false),
  usedByLeadId: varchar("used_by_lead_id", { length: 255 }),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar({ length: 20 }).default('available').notNull(),
  creditsAvailable: integer("credits_available").default(1),
  usedBy: uuid("used_by"),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  discountType: varchar("discount_type", { length: 20 }).default('flat'),
  discountValue: numeric("discount_value", { precision: 10, scale:  2 }).default('0'),
  maxDiscountCap: numeric("max_discount_cap", { precision: 10, scale:  2 }),
  minAmount: numeric("min_amount", { precision: 10, scale:  2 }),
  batchId: varchar("batch_id", { length: 255 }),
  reservedAt: timestamp("reserved_at", { withTimezone: true }),
  reservedBy: uuid("reserved_by"),
  reservedForLeadId: varchar("reserved_for_lead_id", { length: 255 }),
});

// --- COUPON BATCHES ---

export const couponBatches = pgTable(
  "coupon_batches",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    dealerId: varchar("dealer_id", { length: 255 }).notNull(),
    prefix: varchar({ length: 20 }).notNull(),
    couponValue: numeric("coupon_value", { precision: 10, scale:  2 }).default('0').notNull(),
    totalQuantity: integer("total_quantity").notNull(),
    expiryDate: timestamp("expiry_date", { withTimezone: true }),
    status: varchar({ length: 20 }).default('active').notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    batchDealerIdx: index("coupon_batches_dealer_idx").on(table.dealerId),
    batchStatusIdx: index("coupon_batches_status_idx").on(table.status),
  }),
);

// --- COUPON AUDIT LOG ---

export const couponAuditLog = pgTable(
  "coupon_audit_log",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    couponId: varchar("coupon_id", { length: 255 }).notNull(),
    action: varchar({ length: 20 }).notNull(),
    oldStatus: varchar("old_status", { length: 20 }),
    newStatus: varchar("new_status", { length: 20 }),
    leadId: varchar("lead_id", { length: 255 }),
    performedBy: uuid("performed_by"),
    ipAddress: varchar("ip_address", { length: 45 }),
    notes: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    auditCouponIdx: index("coupon_audit_log_coupon_idx").on(
      table.couponId,
      table.createdAt,
    ),
    auditActionIdx: index("coupon_audit_log_action_idx").on(table.action),
  }),
);

// --- FACILITATION PAYMENTS ---

export const facilitationPayments = pgTable(
  "facilitation_payments",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    paymentMethod: varchar("payment_method", { length: 30 }),
    facilitationFeeBaseAmount: numeric("facilitation_fee_base_amount", { precision: 10, scale:  2 }).default('1500.00').notNull(),
    couponCode: varchar("coupon_code", { length: 50 }),
    couponId: varchar("coupon_id", { length: 255 }),
    couponDiscountType: varchar("coupon_discount_type", { length: 20 }),
    couponDiscountValue: numeric("coupon_discount_value", { precision: 10, scale:  2 }),
    couponDiscountAmount: numeric("coupon_discount_amount", { precision: 10, scale:  2 }).default('0'),
    facilitationFeeFinalAmount: numeric("facilitation_fee_final_amount", { precision: 10, scale:  2 }).notNull(),
    razorpayQrId: varchar("razorpay_qr_id", { length: 255 }),
    razorpayQrStatus: varchar("razorpay_qr_status", { length: 30 }),
    razorpayQrImageUrl: text("razorpay_qr_image_url"),
    razorpayQrShortUrl: text("razorpay_qr_short_url"),
    razorpayQrExpiresAt: timestamp("razorpay_qr_expires_at", { withTimezone: true }),
    razorpayPaymentId: varchar("razorpay_payment_id", { length: 255 }),
    razorpayOrderId: varchar("razorpay_order_id", { length: 255 }),
    razorpayPaymentStatus: varchar("razorpay_payment_status", { length: 30 }),
    utrNumberManual: varchar("utr_number_manual", { length: 100 }),
    paymentScreenshotUrl: text("payment_screenshot_url"),
    facilitationFeeStatus: varchar("facilitation_fee_status", { length: 30 }).default('UNPAID').notNull(),
    paymentPaidAt: timestamp("payment_paid_at", { withTimezone: true }),
    paymentVerifiedAt: timestamp("payment_verified_at", { withTimezone: true }),
    paymentVerificationSource: varchar("payment_verification_source", { length: 30 }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    fpLeadIdx: index("facilitation_payments_lead_id_idx").on(table.leadId),
    fpStatusIdx: index("facilitation_payments_status_idx").on(
      table.facilitationFeeStatus,
    ),
    fpQrIdx: index("facilitation_payments_rzp_qr_idx").on(table.razorpayQrId),
  }),
);

export const facilitationPaymentsRelations = relations(
  facilitationPayments,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [facilitationPayments.leadId],
      references: [dealerLeads.id],
    }),
    creator: one(users, {
      fields: [facilitationPayments.createdBy],
      references: [users.id],
    }),
  }),
);

// --- CO-BORROWER MODULE ---

export const coBorrowers = pgTable(
  "co_borrowers",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    fullName: text("full_name"),
    phone: varchar({ length: 20 }),
    aadhaarNo: varchar("aadhaar_no", { length: 12 }),
    panNo: varchar("pan_no", { length: 10 }),
    dob: date(),
    relationship: varchar({ length: 50 }),
    income: numeric({ precision: 12, scale:  2 }),
    address: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    fatherOrHusbandName: text("father_or_husband_name"),
    permanentAddress: text("permanent_address"),
    currentAddress: text("current_address"),
    isCurrentSame: boolean("is_current_same").default(false),
    autoFilled: boolean("auto_filled").default(false),
    kycStatus: varchar("kyc_status", { length: 30 }).default('not_started'),
    consentStatus: varchar("consent_status", { length: 30 }).default('awaiting_signature'),
    verificationSubmittedAt: timestamp("verification_submitted_at", { withTimezone: true }),
  },
  (table) => {
    return {
      coBorrowerLeadIdx: index("co_borrowers_lead_id_idx").on(table.leadId),
    };
  },
);

export const coBorrowerDocuments = pgTable("co_borrower_documents", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  coBorrowerId: varchar("co_borrower_id", { length: 255 }),
  documentType: varchar("document_type", { length: 50 }).notNull(),
  documentUrl: text("document_url"),
  status: varchar({ length: 30 }).default('pending'),
  ocrData: jsonb("ocr_data"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  verificationStatus: varchar("verification_status", { length: 30 }).default('pending'),
});

export const otherDocumentRequests = pgTable("other_document_requests", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  requestedBy: uuid("requested_by"),
  docLabel: text("doc_label").notNull(),
  description: text(),
  fileUrl: text("file_url"),
  uploadStatus: varchar("upload_status", { length: 20 }).default('pending'),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  uploadToken: varchar("upload_token", { length: 255 }),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  docFor: varchar("doc_for", { length: 20 }).default('primary').notNull(),
  docKey: varchar("doc_key", { length: 100 }).default('other').notNull(),
  isRequired: boolean("is_required").default(true),
  rejectionReason: text("rejection_reason"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  documentName: text("document_name"),
  documentUrl: text("document_url"),
  status: varchar({ length: 20 }).default('pending'),
});

export const coBorrowerRequests = pgTable(
  "co_borrower_requests",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    attemptNumber: integer("attempt_number").default(1).notNull(),
    reason: text(),
    status: varchar({ length: 30 }).default('open').notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    coBorrowerRequestsLeadIdx: index("co_borrower_requests_lead_id_idx").on(
      table.leadId,
    ),
  }),
);

// --- LOAN OFFERS (SM → Dealer) ---

export const loanOffers = pgTable(
  "loan_offers",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    financierName: text("financier_name").notNull(),
    loanAmount: numeric("loan_amount", { precision: 12, scale:  2 }).notNull(),
    interestRate: numeric("interest_rate", { precision: 5, scale:  2 }).notNull(),
    tenureMonths: integer("tenure_months").notNull(),
    emi: numeric({ precision: 10, scale:  2 }).notNull(),
    processingFee: numeric("processing_fee", { precision: 10, scale:  2 }),
    notes: text(),
    status: varchar({ length: 20 }).default('pending').notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    loanOffersLeadIdx: index("loan_offers_lead_id_idx").on(table.leadId),
  }),
);

export const loanOffersRelations = relations(loanOffers, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [loanOffers.leadId],
    references: [dealerLeads.id],
  }),
  creator: one(users, {
    fields: [loanOffers.createdBy],
    references: [users.id],
  }),
}));

// --- ADMIN KYC REVIEW ---

export const adminKycReviews = pgTable("admin_kyc_reviews", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  reviewFor: varchar("review_for", { length: 20 }).default('primary').notNull(),
  documentId: varchar("document_id", { length: 255 }),
  documentType: varchar("document_type", { length: 50 }),
  outcome: varchar({ length: 20 }).notNull(),
  rejectionReason: text("rejection_reason"),
  additionalDocRequested: text("additional_doc_requested"),
  reviewerId: uuid("reviewer_id").notNull(),
  reviewerNotes: text("reviewer_notes"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const adminVerificationQueue = pgTable(
  "admin_verification_queue",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    queueType: varchar("queue_type", { length: 50 }).default('kyc_verification').notNull(),
    leadId: text("lead_id").notNull(),
    priority: varchar({ length: 20 }).default('normal').notNull(),
    assignedTo: uuid("assigned_to"),
    submittedBy: uuid("submitted_by"),
    status: varchar({ length: 50 }).default('pending_itarang_verification').notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    adminVerificationQueueLeadIdx: index(
      "admin_verification_queue_lead_idx",
    ).on(table.leadId),
    adminVerificationQueueStatusIdx: index(
      "admin_verification_queue_status_idx",
    ).on(table.status),
    adminVerificationQueueAssignedIdx: index(
      "admin_verification_queue_assigned_idx",
    ).on(table.assignedTo),
    adminVerificationQueueCreatedIdx: index(
      "admin_verification_queue_created_idx",
    ).on(table.createdAt),
  }),
);

export const kycVerificationMetadata = pgTable(
  "kyc_verification_metadata",
  {
    leadId: varchar("lead_id", { length: 255 }).primaryKey().notNull(),
    submissionTimestamp: timestamp("submission_timestamp", { withTimezone: true }),
    caseType: varchar("case_type", { length: 20 }),
    couponCode: varchar("coupon_code", { length: 100 }),
    couponStatus: varchar("coupon_status", { length: 30 }).default('reserved'),
    documentsCount: integer("documents_count"),
    consentVerified: boolean("consent_verified").default(false),
    dealerEditsLocked: boolean("dealer_edits_locked").default(false),
    verificationStartedAt: timestamp("verification_started_at", { withTimezone: true }),
    firstApiExecutionAt: timestamp("first_api_execution_at", { withTimezone: true }),
    firstApiType: varchar("first_api_type", { length: 50 }),
    finalDecision: varchar("final_decision", { length: 20 }),
    finalDecisionAt: timestamp("final_decision_at", { withTimezone: true }),
    finalDecisionBy: uuid("final_decision_by"),
    finalDecisionNotes: text("final_decision_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    kycVerificationMetadataCouponIdx: index(
      "kyc_verification_metadata_coupon_idx",
    ).on(table.couponCode),
    kycVerificationMetadataStatusIdx: index(
      "kyc_verification_metadata_coupon_status_idx",
    ).on(table.couponStatus),
  }),
);

// --- DEPLOYED ASSETS MODULE ---

export const deployedAssets = pgTable(
  "deployed_assets",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    inventoryId: varchar("inventory_id", { length: 255 }).notNull(),
    leadId: varchar("lead_id", { length: 255 }),
    dealId: varchar("deal_id", { length: 255 }),
    dealerId: varchar("dealer_id", { length: 255 }),
    customerName: text("customer_name"),
    customerPhone: varchar("customer_phone", { length: 20 }),
    serialNumber: varchar("serial_number", { length: 255 }),
    assetCategory: varchar("asset_category", { length: 20 }),
    assetType: varchar("asset_type", { length: 50 }),
    modelType: text("model_type"),
    deploymentDate: timestamp("deployment_date", { withTimezone: true }).notNull(),
    deploymentLocation: text("deployment_location"),
    latitude: numeric({ precision: 10, scale:  8 }),
    longitude: numeric({ precision: 11, scale:  8 }),
    qrCodeUrl: text("qr_code_url"),
    qrCodeData: text("qr_code_data"),
    paymentType: varchar("payment_type", { length: 20 }),
    paymentStatus: varchar("payment_status", { length: 20 }).default('pending'),
    batteryHealthPercent: numeric("battery_health_percent", { precision: 5, scale:  2 }),
    lastVoltage: numeric("last_voltage", { precision: 5, scale:  2 }),
    lastSoc: integer("last_soc"),
    lastTelemetryAt: timestamp("last_telemetry_at", { withTimezone: true }),
    telemetryData: jsonb("telemetry_data"),
    totalCycles: integer("total_cycles"),
    warrantyStartDate: timestamp("warranty_start_date", { withTimezone: true }),
    warrantyEndDate: timestamp("warranty_end_date", { withTimezone: true }),
    warrantyStatus: varchar("warranty_status", { length: 20 }).default('active'),
    status: varchar({ length: 20 }).default('active').notNull(),
    lastMaintenanceAt: timestamp("last_maintenance_at", { withTimezone: true }),
    nextMaintenanceDue: timestamp("next_maintenance_due", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      deployedAssetsDealerIdx: index("deployed_assets_dealer_id_idx").on(
        table.dealerId,
      ),
      deployedAssetsStatusIdx: index("deployed_assets_status_idx").on(
        table.status,
      ),
    };
  },
);

export const deploymentHistory = pgTable("deployment_history", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  deployedAssetId: varchar("deployed_asset_id", { length: 255 }).notNull(),
  action: varchar({ length: 50 }).notNull(),
  description: text(),
  performedBy: uuid("performed_by").notNull(),
  metadata: jsonb(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- SERVICE MANAGEMENT MODULE ---

export const serviceTickets = pgTable(
  "service_tickets",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    deployedAssetId: varchar("deployed_asset_id", { length: 255 }),
    dealerId: varchar("dealer_id", { length: 255 }).notNull(),
    customerName: text("customer_name"),
    customerPhone: varchar("customer_phone", { length: 20 }),
    issueType: varchar("issue_type", { length: 50 }).notNull(),
    issueDescription: text("issue_description").notNull(),
    priority: varchar({ length: 20 }).default('medium').notNull(),
    photosUrls: jsonb("photos_urls"),
    assignedTo: uuid("assigned_to"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    status: varchar({ length: 30 }).default('open').notNull(),
    resolutionType: varchar("resolution_type", { length: 50 }),
    resolutionNotes: text("resolution_notes"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    slaDeadline: timestamp("sla_deadline", { withTimezone: true }),
    slaBreached: boolean("sla_breached").default(false),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      serviceTicketsDealerIdx: index("service_tickets_dealer_id_idx").on(
        table.dealerId,
      ),
      serviceTicketsStatusIdx: index("service_tickets_status_idx").on(
        table.status,
      ),
      serviceTicketsAssetIdx: index("service_tickets_asset_id_idx").on(
        table.deployedAssetId,
      ),
    };
  },
);

// --- LOAN MANAGEMENT MODULE (Full lifecycle) ---

export const loanFiles = pgTable(
  "loan_files",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    leadId: varchar("lead_id", { length: 255 }).notNull(),
    loanApplicationId: varchar("loan_application_id", { length: 255 }),
    dealerId: varchar("dealer_id", { length: 255 }),
    borrowerName: text("borrower_name").notNull(),
    coBorrowerName: text("co_borrower_name"),
    loanAmount: numeric("loan_amount", { precision: 12, scale:  2 }).notNull(),
    interestRate: numeric("interest_rate", { precision: 5, scale:  2 }),
    tenureMonths: integer("tenure_months"),
    emiAmount: numeric("emi_amount", { precision: 10, scale:  2 }),
    downPayment: numeric("down_payment", { precision: 12, scale:  2 }),
    processingFee: numeric("processing_fee", { precision: 10, scale:  2 }),
    disbursalStatus: varchar("disbursal_status", { length: 30 }).default('pending').notNull(),
    disbursedAmount: numeric("disbursed_amount", { precision: 12, scale:  2 }),
    disbursedAt: timestamp("disbursed_at", { withTimezone: true }),
    disbursalReference: text("disbursal_reference"),
    totalPaid: numeric("total_paid", { precision: 12, scale:  2 }).default('0'),
    totalOutstanding: numeric("total_outstanding", { precision: 12, scale:  2 }),
    nextEmiDate: timestamp("next_emi_date", { withTimezone: true }),
    emiSchedule: jsonb("emi_schedule"),
    overdueAmount: numeric("overdue_amount", { precision: 12, scale:  2 }).default('0'),
    overdueDays: integer("overdue_days").default(0),
    loanStatus: varchar("loan_status", { length: 30 }).default('active').notNull(),
    closureDate: timestamp("closure_date", { withTimezone: true }),
    closureType: varchar("closure_type", { length: 20 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      loanFilesDealerIdx: index("loan_files_dealer_id_idx").on(table.dealerId),
      loanFilesStatusIdx: index("loan_files_loan_status_idx").on(
        table.loanStatus,
      ),
    };
  },
);

export const loanPayments = pgTable("loan_payments", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  loanFileId: varchar("loan_file_id", { length: 255 }).notNull(),
  paymentType: varchar("payment_type", { length: 20 }).notNull(),
  amount: numeric({ precision: 12, scale:  2 }).notNull(),
  paymentMode: varchar("payment_mode", { length: 30 }),
  transactionId: text("transaction_id"),
  paymentDate: timestamp("payment_date", { withTimezone: true }).notNull(),
  emiMonth: integer("emi_month"),
  status: varchar({ length: 20 }).default('completed').notNull(),
  receiptUrl: text("receipt_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- DEALER PROFILE ---

export const dealerSubscriptions = pgTable("dealer_subscriptions", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  dealerId: varchar("dealer_id", { length: 255 }).notNull(),
  planName: varchar("plan_name", { length: 50 }).notNull(),
  status: varchar({ length: 20 }).default('active').notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  features: jsonb(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- CAMPAIGN SEGMENTS ---

export const campaignSegments = pgTable("campaign_segments", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  dealerId: varchar("dealer_id", { length: 255 }),
  name: text().notNull(),
  description: text(),
  segmentType: varchar("segment_type", { length: 20 }).default('custom').notNull(),
  rules: jsonb(),
  logic: varchar({ length: 10 }).default('and'),
  estimatedCount: integer("estimated_count"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  isPrebuilt: boolean("is_prebuilt").default(false),
  estimatedAudience: integer("estimated_audience"),
  filterCriteria: jsonb("filter_criteria"),
});

// --- RELATIONS FOR NEW TABLES ---

export const campaignsRelations = relations(campaigns, ({ one }) => ({
  creator: one(users, {
    fields: [campaigns.createdBy],
    references: [users.id],
  }),
}));

export const loanApplicationsRelations = relations(
  loanApplications,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [loanApplications.leadId],
      references: [dealerLeads.id],
    }),
    creator: one(users, {
      fields: [loanApplications.createdBy],
      references: [users.id],
    }),
  }),
);

export const kycDocumentsRelations = relations(kycDocuments, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [kycDocuments.leadId],
    references: [dealerLeads.id],
  }),
}));

export const kycVerificationsRelations = relations(
  kycVerifications,
  ({ one }) => ({
    lead: one(dealerLeads, {
      fields: [kycVerifications.leadId],
      references: [dealerLeads.id],
    }),
  }),
);

export const consentRecordsRelations = relations(consentRecords, ({ one }) => ({
  lead: one(dealerLeads, {
    fields: [consentRecords.leadId],
    references: [dealerLeads.id],
  }),
  verifier: one(users, {
    fields: [consentRecords.verifiedBy],
    references: [users.id],
  }),
}));

export const coBorrowersRelations = relations(coBorrowers, ({ one, many }) => ({
  lead: one(dealerLeads, {
    fields: [coBorrowers.leadId],
    references: [dealerLeads.id],
  }),
  documents: many(coBorrowerDocuments),
}));

export const coBorrowerDocumentsRelations = relations(
  coBorrowerDocuments,
  ({ one }) => ({
    coBorrower: one(coBorrowers, {
      fields: [coBorrowerDocuments.coBorrowerId],
      references: [coBorrowers.id],
    }),
    lead: one(dealerLeads, {
      fields: [coBorrowerDocuments.leadId],
      references: [dealerLeads.id],
    }),
  }),
);

export const deployedAssetsRelations = relations(
  deployedAssets,
  ({ one, many }) => ({
    inventory: one(inventory, {
      fields: [deployedAssets.inventoryId],
      references: [inventory.id],
    }),
    lead: one(dealerLeads, {
      fields: [deployedAssets.leadId],
      references: [dealerLeads.id],
    }),
    deal: one(deals, {
      fields: [deployedAssets.dealId],
      references: [deals.id],
    }),
    dealer: one(accounts, {
      fields: [deployedAssets.dealerId],
      references: [accounts.id],
    }),
    creator: one(users, {
      fields: [deployedAssets.createdBy],
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
      fields: [deploymentHistory.deployedAssetId],
      references: [deployedAssets.id],
    }),
    performer: one(users, {
      fields: [deploymentHistory.performedBy],
      references: [users.id],
    }),
  }),
);

export const serviceTicketsRelations = relations(serviceTickets, ({ one }) => ({
  asset: one(deployedAssets, {
    fields: [serviceTickets.deployedAssetId],
    references: [deployedAssets.id],
  }),
  dealer: one(accounts, {
    fields: [serviceTickets.dealerId],
    references: [accounts.id],
  }),
  assignee: one(users, {
    fields: [serviceTickets.assignedTo],
    references: [users.id],
  }),
  resolver: one(users, {
    fields: [serviceTickets.resolvedBy],
    references: [users.id],
  }),
  creator: one(users, {
    fields: [serviceTickets.createdBy],
    references: [users.id],
  }),
}));

export const loanFilesRelations = relations(loanFiles, ({ one, many }) => ({
  lead: one(dealerLeads, {
    fields: [loanFiles.leadId],
    references: [dealerLeads.id],
  }),
  loanApplication: one(loanApplications, {
    fields: [loanFiles.loanApplicationId],
    references: [loanApplications.id],
  }),
  dealer: one(accounts, {
    fields: [loanFiles.dealerId],
    references: [accounts.id],
  }),
  payments: many(loanPayments),
}));

export const loanPaymentsRelations = relations(loanPayments, ({ one }) => ({
  loanFile: one(loanFiles, {
    fields: [loanPayments.loanFileId],
    references: [loanFiles.id],
  }),
}));

export const campaignSegmentsRelations = relations(
  campaignSegments,
  ({ one }) => ({
    dealer: one(accounts, {
      fields: [campaignSegments.dealerId],
      references: [accounts.id],
    }),
    creator: one(users, {
      fields: [campaignSegments.createdBy],
      references: [users.id],
    }),
  }),
);

// --- INTELLICAR TELEMETRY (ORM definitions for existing tables) ---

export const deviceBatteryMap = pgTable("device_battery_map", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  deviceId: varchar("device_id", { length: 100 }).notNull(),
  batterySerial: varchar("battery_serial", { length: 100 }),
  vehicleNumber: varchar("vehicle_number", { length: 50 }),
  vehicleType: varchar("vehicle_type", { length: 50 }),
  customerName: text("customer_name"),
  customerPhone: varchar("customer_phone", { length: 20 }),
  dealerId: varchar("dealer_id", { length: 255 }),
  status: varchar({ length: 20 }).default('active'),
  installedAt: timestamp("installed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const batteryAlerts = pgTable("battery_alerts", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  deviceId: varchar("device_id", { length: 100 }).notNull(),
  alertType: varchar("alert_type", { length: 50 }).notNull(),
  severity: varchar({ length: 20 }).notNull(),
  message: text(),
  value: numeric({ precision: 10, scale:  2 }),
  threshold: numeric({ precision: 10, scale:  2 }),
  acknowledged: boolean().default(false),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedBy: text("acknowledged_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// --- APP SETTINGS ---

export const appSettings = pgTable("app_settings", {
  key: text().primaryKey().notNull(),
  value: jsonb().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// --- DEALER LEAD SCRAPER MODULE ---

export const scraperRuns = pgTable(
  "scraper_runs",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    triggeredBy: uuid("triggered_by").notNull(),
    status: varchar({ length: 20 }).default('running').notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    searchQueries: jsonb("search_queries"),
    totalFound: integer("total_found").default(0),
    newLeadsSaved: integer("new_leads_saved").default(0),
    duplicatesSkipped: integer("duplicates_skipped").default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    cleanedLeads: integer("cleaned_leads"),
    durationMs: integer("duration_ms"),
    totalChunks: integer("total_chunks").default(0),
    completedChunks: integer("completed_chunks").default(0),
  },
  (table) => ({
    scraperRunsStatusIdx: index("scraper_runs_status_idx").on(table.status),
    scraperRunsTriggeredByIdx: index("scraper_runs_triggered_by_idx").on(
      table.triggeredBy,
    ),
  }),
);

export const scrapedDealerLeads = pgTable(
  "scraped_dealer_leads",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    scraperRunId: varchar("scraper_run_id", { length: 255 }).notNull(),
    dealerName: text("dealer_name").notNull(),
    phone: varchar({ length: 20 }),
    locationCity: varchar("location_city", { length: 100 }),
    locationState: varchar("location_state", { length: 100 }),
    sourceUrl: text("source_url"),
    rawData: jsonb("raw_data"),
    assignedTo: uuid("assigned_to"),
    assignedBy: uuid("assigned_by"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    explorationStatus: varchar("exploration_status", { length: 30 }).default('unassigned').notNull(),
    explorationNotes: text("exploration_notes"),
    exploredAt: timestamp("explored_at", { withTimezone: true }),
    convertedLeadId: varchar("converted_lead_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    email: text(),
    gstNumber: text("gst_number"),
    businessType: text("business_type"),
    productsSold: text("products_sold"),
    website: text(),
    qualityScore: integer("quality_score").default(1),
    phoneValid: boolean("phone_valid").default(false),
  },
  (table) => ({
    sdlPhoneIdx: index("sdl_phone_idx").on(table.phone),
    sdlNameCityIdx: index("sdl_name_city_idx").on(
      table.dealerName,
      table.locationCity,
    ),
    sdlSourceUrlIdx: index("sdl_source_url_idx").on(table.sourceUrl),
    sdlRunIdx: index("sdl_run_idx").on(table.scraperRunId),
    sdlAssignedToIdx: index("sdl_assigned_to_idx").on(table.assignedTo),
    sdlStatusIdx: index("sdl_status_idx").on(table.explorationStatus),
  }),
);

export const scraperDedupLogs = pgTable(
  "scraper_dedup_logs",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    scraperRunId: varchar("scraper_run_id", { length: 255 }).notNull(),
    rawDealerName: text("raw_dealer_name"),
    rawPhone: varchar("raw_phone", { length: 20 }),
    rawLocation: text("raw_location"),
    rawSourceUrl: text("raw_source_url"),
    skipReason: varchar("skip_reason", { length: 50 }).notNull(),
    matchedLeadId: varchar("matched_lead_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    ddupRunIdx: index("ddup_run_idx").on(table.scraperRunId),
  }),
);

export const scraperSearchQueries = pgTable(
  "scraper_search_queries",
  {
    id: text().primaryKey().notNull(),
    queryText: text("query_text").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sqActiveIdx: index("sq_active_idx").on(table.isActive),
  }),
);

export const scraperSearchQueriesRelations = relations(
  scraperSearchQueries,
  ({ one }) => ({
    createdBy: one(users, {
      fields: [scraperSearchQueries.createdBy],
      references: [users.id],
    }),
  }),
);

export const scraperSchedules = pgTable("scraper_schedules", {
  id: text().primaryKey().notNull(),
  frequency: text().default('weekly').notNull(),
  dayOfWeek: integer("day_of_week").default(1),
  timeOfDay: text("time_of_day").default('04:00'),
  isActive: boolean("is_active").default(true).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scraperSchedulesRelations = relations(
  scraperSchedules,
  ({ one }) => ({
    createdBy: one(users, {
      fields: [scraperSchedules.createdBy],
      references: [users.id],
    }),
  }),
);

// Relations for scraper tables
export const scraperRunsRelations = relations(scraperRuns, ({ one, many }) => ({
  triggeredBy: one(users, {
    fields: [scraperRuns.triggeredBy],
    references: [users.id],
  }),
  leads: many(scrapedDealerLeads),
  dedupLogs: many(scraperDedupLogs),
}));

export const scrapedDealerLeadsRelations = relations(
  scrapedDealerLeads,
  ({ one }) => ({
    scraperRun: one(scraperRuns, {
      fields: [scrapedDealerLeads.scraperRunId],
      references: [scraperRuns.id],
    }),
    assignedTo: one(users, {
      fields: [scrapedDealerLeads.assignedTo],
      references: [users.id],
    }),
    assignedBy: one(users, {
      fields: [scrapedDealerLeads.assignedBy],
      references: [users.id],
    }),
    convertedLead: one(dealerLeads, {
      fields: [scrapedDealerLeads.convertedLeadId],
      references: [dealerLeads.id],
    }),
  }),
);

export const scraperDedupLogsRelations = relations(
  scraperDedupLogs,
  ({ one }) => ({
    scraperRun: one(scraperRuns, {
      fields: [scraperDedupLogs.scraperRunId],
      references: [scraperRuns.id],
    }),
  }),
);

export const dealerOnboardingApplications = pgTable(
  "dealer_onboarding_applications",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    dealerUserId: uuid("dealer_user_id"),
    companyName: text("company_name").notNull(),
    companyType: text("company_type"),
    gstNumber: text("gst_number"),
    panNumber: text("pan_number"),
    cinNumber: text("cin_number"),
    financeEnabled: boolean("finance_enabled").default(false),
    onboardingStatus: varchar("onboarding_status", { length: 30 }).default('draft').notNull(),
    reviewStatus: varchar("review_status", { length: 30 }).default('pending'),
    submittedAt: timestamp("submitted_at"),
    approvedAt: timestamp("approved_at"),
    rejectedAt: timestamp("rejected_at"),
    rejectionReason: text("rejection_reason"),
    adminNotes: text("admin_notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    ownerName: text("owner_name"),
    ownerPhone: text("owner_phone"),
    ownerEmail: text("owner_email"),
    bankName: text("bank_name"),
    accountNumber: text("account_number"),
    beneficiaryName: text("beneficiary_name"),
    ifscCode: text("ifsc_code"),
    correctionRemarks: text("correction_remarks"),
    rejectionRemarks: text("rejection_remarks"),
    dealerAccountStatus: varchar("dealer_account_status", { length: 30 }).default('inactive'),
    dealerCode: text("dealer_code"),
    correctionRequestedAt: timestamp("correction_requested_at"),
    revalidatedAt: timestamp("revalidated_at"),
    lastActionBy: uuid("last_action_by"),
    lastActionAt: timestamp("last_action_at"),
    approvedBy: uuid("approved_by"),
    rejectedBy: uuid("rejected_by"),
    correctionCount: integer("correction_count").default(0).notNull(),
    isLocked: boolean("is_locked").default(false).notNull(),
    businessAddressNew: jsonb("business_address_new").default({}),
    city: varchar({ length: 100 }),
    state: varchar({ length: 100 }),
    pincode: varchar({ length: 20 }),
    contactName: text("contact_name"),
    contactPhone: varchar("contact_phone", { length: 20 }),
    contactEmail: varchar("contact_email", { length: 150 }),
    agreementId: uuid("agreement_id"),
    registeredAddress: jsonb("registered_address").default({}),
    businessAddress: text("business_address"),
    requestId: text("request_id"),
    providerDocumentId: text("provider_document_id"),
    providerSigningUrl: text("provider_signing_url"),
    signedAt: timestamp("signed_at"),
    lastActionTimestamp: timestamp("last_action_timestamp"),
    stampStatus: varchar("stamp_status", { length: 50 }),
    completionStatus: varchar("completion_status", { length: 50 }),
    agreementAuditTrailUrl: text("agreement_audit_trail_url"),
    salesManagerName: text("sales_manager_name"),
    salesManagerEmail: text("sales_manager_email"),
    salesManagerMobile: text("sales_manager_mobile"),
    itarangSignatory1Name: text("itarang_signatory_1_name"),
    itarangSignatory1Email: text("itarang_signatory_1_email"),
    itarangSignatory1Mobile: text("itarang_signatory_1_mobile"),
    itarangSignatory2Name: text("itarang_signatory_2_name"),
    itarangSignatory2Email: text("itarang_signatory_2_email"),
    itarangSignatory2Mobile: text("itarang_signatory_2_mobile"),
    agreementLastInitiatedAt: timestamp("agreement_last_initiated_at"),
    agreementExpiredAt: timestamp("agreement_expired_at"),
    agreementFailedAt: timestamp("agreement_failed_at"),
    agreementFailureReason: text("agreement_failure_reason"),
    agreementCompletedAt: timestamp("agreement_completed_at"),
    signedAgreementStoragePath: text("signed_agreement_storage_path"),
    auditTrailStoragePath: text("audit_trail_storage_path"),
    agreementStatus: varchar("agreement_status", { length: 50 }).default('not_generated'),
    providerRawResponse: jsonb("provider_raw_response"),
    signedAgreementUrl: text("signed_agreement_url"),
    auditTrailUrl: text("audit_trail_url"),
    ownerLandline: varchar("owner_landline", { length: 20 }),
    agreementLanguage: varchar("agreement_language", { length: 30 }).default('english').notNull(),
    isBranchDealer: boolean("is_branch_dealer").default(false).notNull(),
    stampCertificateIds: jsonb("stamp_certificate_ids").default([]),
  },
);

export const dealerAgreementSigners = pgTable(
  "dealer_agreement_signers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    applicationId: uuid("application_id").notNull(),
    providerDocumentId: text("provider_document_id"),
    requestId: text("request_id"),
    signerRole: varchar("signer_role", { length: 50 }).notNull(),
    signerName: text("signer_name").notNull(),
    signerEmail: text("signer_email"),
    signerMobile: text("signer_mobile"),
    signingMethod: varchar("signing_method", { length: 50 }),
    providerSignerIdentifier: text("provider_signer_identifier"),
    providerSigningUrl: text("provider_signing_url"),
    signerStatus: varchar("signer_status", { length: 50 }).default('pending').notNull(),
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
    id: uuid().defaultRandom().primaryKey().notNull(),
    applicationId: uuid("application_id").notNull(),
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
    id: uuid().defaultRandom().primaryKey().notNull(),
    applicationId: uuid("application_id").notNull(),
    documentType: varchar("document_type", { length: 100 }).notNull(),
    bucketName: text("bucket_name").notNull(),
    storagePath: text("storage_path").notNull(),
    fileName: text("file_name").notNull(),
    fileUrl: text("file_url"),
    mimeType: varchar("mime_type", { length: 100 }),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    fileSize: bigint("file_size", { mode: "number" }),
    uploadedBy: uuid("uploaded_by"),
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
    docStatus: varchar("doc_status", { length: 30 }).default('uploaded').notNull(),
    verificationStatus: varchar("verification_status", { length: 30 }).default('pending'),
    verifiedAt: timestamp("verified_at"),
    verifiedBy: uuid("verified_by"),
    rejectionReason: text("rejection_reason"),
    extractedData: jsonb("extracted_data").default({}),
    apiVerificationResults: jsonb("api_verification_results").default({}),
    metadata: jsonb().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    adminComment: text("admin_comment"),
  },
  (table) => ({
    applicationIdIdx: index("dealer_onboarding_documents_application_id_idx").on(
      table.applicationId,
    ),
  }),
);

export const scrapeRuns = pgTable("scraper_runs", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  triggeredBy: uuid("triggered_by").notNull(),
  status: varchar({ length: 20 }).default('running').notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  searchQueries: jsonb("search_queries"),
  totalFound: integer("total_found").default(0),
  newLeadsSaved: integer("new_leads_saved").default(0),
  duplicatesSkipped: integer("duplicates_skipped").default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  cleanedLeads: integer("cleaned_leads"),
  durationMs: integer("duration_ms"),
  totalChunks: integer("total_chunks").default(0),
  completedChunks: integer("completed_chunks").default(0),
});

export const scraperRunChunks = pgTable("scraper_run_chunks", {
  id: text().primaryKey().notNull(),
  runId: text("run_id").notNull(),
  combinationQuery: text("combination_query").notNull(),
  status: text().default('pending').notNull(),
  leadsCount: integer("leads_count").default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
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
  createdAt: timestamp("created_at").defaultNow(),
});

export const scraperRaw = pgTable("scraper_raw", {
  id: text().primaryKey().notNull(),
  runId: text("run_id"),
  rawData: text("raw_data"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const dealerLeads = pgTable("dealer_leads", {
  id: text().primaryKey().notNull(),
  dealerName: text("dealer_name"),
  phone: text(),
  language: text(),
  followUpHistory: jsonb("follow_up_history").default([]),
  currentStatus: text("current_status"),
  totalAttempts: integer("total_attempts").default(0),
  finalIntentScore: integer("final_intent_score").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  location: text(),
  memory: jsonb(),
  nextCallAt: timestamp("next_call_at"),
  shopName: text("shop_name"),
  overallSummary: text("overall_summary"),
  assignedTo: text("assigned_to"),
  approvedBy: text("approved_by"),
  rejectedBy: text("rejected_by"),
  dealerId: text("dealer_id"),
});

export const scraperLeadsDuplicates = pgTable("scraper_leads_duplicates", {
  id: text().primaryKey().notNull(),
  originalLeadId: text("original_lead_id"),
  name: text(),
  phone: text(),
  email: text(),
  website: text(),
  city: text(),
  address: text(),
  source: text(),
  status: text(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
});

// --- NOTIFICATIONS ---

export const notifications = pgTable("notifications", {
  id: text().primaryKey().notNull(),
  userId: uuid("user_id"),
  dealerId: varchar("dealer_id", { length: 255 }),
  leadId: varchar("lead_id", { length: 100 }),
  type: varchar({ length: 50 }).notNull(),
  title: text().notNull(),
  message: text().notNull(),
  data: jsonb(),
  read: boolean().default(false),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const scraperCityQueue = pgTable("scraper_city_queue", {
  id: text().primaryKey().notNull(),
  baseQuery: text("base_query").notNull(),
  state: text().notNull(),
  city: text().notNull(),
  fullQuery: text("full_query").notNull(),
  status: text().default('pending'),
  leadsFound: integer("leads_found").default(0),
  newLeads: integer("new_leads").default(0),
  duplicates: integer().default(0),
  scrapedAt: timestamp("scraped_at"),
  createdAt: timestamp("created_at").defaultNow(),
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
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  productSelectionId: varchar("product_selection_id", { length: 255 }),
  loanAmount: numeric("loan_amount", { precision: 12, scale:  2 }),
  downPayment: numeric("down_payment", { precision: 12, scale:  2 }),
  fileCharge: numeric("file_charge", { precision: 12, scale:  2 }),
  subvention: numeric({ precision: 12, scale:  2 }),
  disbursementAmount: numeric("disbursement_amount", { precision: 12, scale:  2 }),
  emi: numeric({ precision: 12, scale:  2 }),
  tenureMonths: integer("tenure_months"),
  roi: numeric({ precision: 5, scale:  2 }),
  loanApprovedBy: text("loan_approved_by"),
  loanFileNumber: varchar("loan_file_number", { length: 100 }),
  status: varchar({ length: 30 }).default('sanctioned').notNull(),
  rejectionReason: text("rejection_reason"),
  sanctionedBy: uuid("sanctioned_by"),
  sanctionedAt: timestamp("sanctioned_at", { withTimezone: true }).defaultNow(),
  dealerApproved: boolean("dealer_approved").default(false),
  dealerApprovedAt: timestamp("dealer_approved_at", { withTimezone: true }),
  dealerApprovedBy: uuid("dealer_approved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- STEP 5: OTP CONFIRMATION (dispatch authorisation) ---

export const otpConfirmations = pgTable("otp_confirmations", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }).notNull(),
  otpType: varchar("otp_type", { length: 50 }).default('dispatch_confirmation').notNull(),
  otpHash: varchar("otp_hash", { length: 255 }).notNull(),
  phoneSentTo: varchar("phone_sent_to", { length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sendCount: integer("send_count").default(1).notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  isUsed: boolean("is_used").default(false).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedBy: uuid("used_by"),
  overrideByAdmin: boolean("override_by_admin").default(false),
  overrideReason: text("override_reason"),
  overrideBy: uuid("override_by"),
});

// --- STEP 5: AFTER-SALES RECORDS (post-dispatch service handle) ---

export const afterSalesRecords = pgTable("after_sales_records", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  leadId: varchar("lead_id", { length: 255 }),
  warrantyId: varchar("warranty_id", { length: 255 }),
  batterySerial: varchar("battery_serial", { length: 255 }),
  customerId: varchar("customer_id", { length: 255 }),
  dealerId: varchar("dealer_id", { length: 255 }),
  paymentMode: varchar("payment_mode", { length: 20 }),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar({ length: 20 }).default('active').notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
  id: uuid().defaultRandom().primaryKey().notNull(),
  slug: text().notNull(),
  displayName: text("display_name").notNull(),
  contactEmail: text("contact_email"),
  aumInr: numeric("aum_inr", { precision: 16, scale:  2 }),
  activeLoans: integer("active_loans").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Many-to-many between users and tenants. Most NBFC partner users belong to
// exactly one tenant; some Itarang internal operators may belong to many.
export const nbfcUsers = pgTable(
  "nbfc_users",
  {
    userId: uuid("user_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    role: varchar({ length: 32 }).default('viewer').notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userTenantIdx: index("nbfc_users_user_tenant_idx").on(table.userId, table.tenantId),
    tenantIdx: index("nbfc_users_tenant_idx").on(table.tenantId),
  }),
);

// Bridges existing loan_applications to a tenant + the IoT vehicleno that loan
// is financing. One loan belongs to one NBFC.
export const nbfcLoans = pgTable(
  "nbfc_loans",
  {
    loanApplicationId: varchar("loan_application_id", { length: 255 }).primaryKey().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    vehicleno: varchar({ length: 64 }),
    emiAmount: numeric("emi_amount", { precision: 12, scale:  2 }),
    emiDueDateDom: integer("emi_due_date_dom"),
    currentDpd: integer("current_dpd").default(0).notNull(),
    outstandingAmount: numeric("outstanding_amount", { precision: 14, scale:  2 }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tenantIdx: index("nbfc_loans_tenant_idx").on(table.tenantId),
    vnoIdx: index("nbfc_loans_vno_idx").on(table.vehicleno),
    dpdIdx: index("nbfc_loans_dpd_idx").on(table.currentDpd),
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
  testMethod: varchar("test_method", { length: 16 }).notNull(),
  testDefinition: jsonb("test_definition").notNull(),
  source: varchar({ length: 16 }).default('human').notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

// One row per (tenant, hypothesis, run). Risk page reads the latest run per
// (tenant, hypothesis); older runs serve as a time series for the audit page.
export const riskCardRuns = pgTable(
  "risk_card_runs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    hypothesisId: uuid("hypothesis_id").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    severity: varchar({ length: 16 }).notNull(),
    findingSummary: text("finding_summary").notNull(),
    affectedCount: integer("affected_count").default(0).notNull(),
    totalCount: integer("total_count").default(0).notNull(),
    evidenceJson: jsonb("evidence_json"),
    llmCritique: text("llm_critique"),
    llmModel: varchar("llm_model", { length: 64 }),
    llmPromptTokens: integer("llm_prompt_tokens"),
    llmCompletionTokens: integer("llm_completion_tokens"),
  },
  (table) => ({
    tenantRunIdx: index("risk_card_runs_tenant_run_idx").on(table.tenantId, table.runAt),
    tenantHypIdx: index("risk_card_runs_tenant_hyp_idx").on(table.tenantId, table.hypothesisId),
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
