import { pgTable, index, foreignKey, varchar, text, numeric, integer, uuid, timestamp, boolean, jsonb, check, unique, date, bigint, pgView, doublePrecision } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const loanOffers = pgTable("loan_offers", {
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
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("loan_offers_lead_id_idx").using("btree", table.leadId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "loan_offers_lead_id_fkey"
		}).onDelete("cascade"),
]);

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
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	disbursedAt: timestamp("disbursed_at", { withTimezone: true, mode: 'string' }),
	rejectionReason: text("rejection_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "loan_applications_lead_id_fkey"
		}),
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "loan_applications_dealer_id_fkey"
		}),
]);

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
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "loan_details_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const loanFiles = pgTable("loan_files", {
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
	disbursedAt: timestamp("disbursed_at", { withTimezone: true, mode: 'string' }),
	disbursalReference: text("disbursal_reference"),
	totalPaid: numeric("total_paid", { precision: 12, scale:  2 }).default('0'),
	totalOutstanding: numeric("total_outstanding", { precision: 12, scale:  2 }),
	nextEmiDate: timestamp("next_emi_date", { withTimezone: true, mode: 'string' }),
	emiSchedule: jsonb("emi_schedule"),
	overdueAmount: numeric("overdue_amount", { precision: 12, scale:  2 }).default('0'),
	overdueDays: integer("overdue_days").default(0),
	loanStatus: varchar("loan_status", { length: 30 }).default('active').notNull(),
	closureDate: timestamp("closure_date", { withTimezone: true, mode: 'string' }),
	closureType: varchar("closure_type", { length: 20 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("loan_files_dealer_id_idx").using("btree", table.dealerId.asc().nullsLast().op("text_ops")),
	index("loan_files_loan_status_idx").using("btree", table.loanStatus.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "loan_files_lead_id_fkey"
		}),
	foreignKey({
			columns: [table.loanApplicationId],
			foreignColumns: [loanApplications.id],
			name: "loan_files_loan_application_id_fkey"
		}),
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "loan_files_dealer_id_fkey"
		}),
]);

export const spatialRefSys = pgTable("spatial_ref_sys", {
	srid: integer().notNull(),
	authName: varchar("auth_name", { length: 256 }),
	authSrid: integer("auth_srid"),
	srtext: varchar({ length: 2048 }),
	proj4Text: varchar({ length: 2048 }),
}, (table) => [
	check("spatial_ref_sys_srid_check", sql`(srid > 0) AND (srid <= 998999)`),
]);

export const leadDocuments = pgTable("lead_documents", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	documentType: varchar("document_type", { length: 50 }).notNull(),
	documentUrl: text("document_url").notNull(),
	status: varchar({ length: 20 }).default('uploaded'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "lead_documents_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const loanPayments = pgTable("loan_payments", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	loanFileId: varchar("loan_file_id", { length: 255 }).notNull(),
	paymentType: varchar("payment_type", { length: 20 }).notNull(),
	amount: numeric({ precision: 12, scale:  2 }).notNull(),
	paymentMode: varchar("payment_mode", { length: 30 }),
	transactionId: text("transaction_id"),
	paymentDate: timestamp("payment_date", { withTimezone: true, mode: 'string' }).notNull(),
	emiMonth: integer("emi_month"),
	status: varchar({ length: 20 }).default('completed').notNull(),
	receiptUrl: text("receipt_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.loanFileId],
			foreignColumns: [loanFiles.id],
			name: "loan_payments_loan_file_id_fkey"
		}).onDelete("cascade"),
]);

export const leadAssignments = pgTable("lead_assignments", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	leadOwner: uuid("lead_owner").notNull(),
	assignedBy: uuid("assigned_by").notNull(),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	leadActor: uuid("lead_actor"),
	actorAssignedBy: uuid("actor_assigned_by"),
	actorAssignedAt: timestamp("actor_assigned_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "lead_assignments_lead_id_fkey"
		}),
]);

export const manualConsentAudits = pgTable("manual_consent_audits", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	consentRecordId: varchar("consent_record_id", { length: 255 }),
	previewPdfUrl: text("preview_pdf_url"),
	previewPdfPath: text("preview_pdf_path"),
	previewExpiresAt: timestamp("preview_expires_at", { withTimezone: true, mode: 'string' }),
	signedPdfUrl: text("signed_pdf_url"),
	signedPdfName: text("signed_pdf_name"),
	signedPdfSize: integer("signed_pdf_size"),
	signedPdfUploadedAt: timestamp("signed_pdf_uploaded_at", { withTimezone: true, mode: 'string' }),
	uploadedBy: uuid("uploaded_by"),
	pdfMetadata: jsonb("pdf_metadata"),
	ocrSummary: jsonb("ocr_summary"),
	uploadQualityFlags: jsonb("upload_quality_flags"),
	reviewStatus: varchar("review_status", { length: 50 }).notNull(),
	rejectionReason: varchar("rejection_reason", { length: 255 }),
	rejectionNotes: text("rejection_notes"),
	reviewedBy: uuid("reviewed_by"),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	signMethod: varchar("sign_method", { length: 50 }),
	ipAddress: varchar("ip_address", { length: 45 }),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

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
	kycCompletedAt: timestamp("kyc_completed_at", { withTimezone: true, mode: 'string' }),
	paymentMethod: varchar("payment_method", { length: 20 }),
	consentStatus: varchar("consent_status", { length: 20 }).default('pending'),
	hasCoBorrower: boolean("has_co_borrower").default(false),
	hasAdditionalDocsRequired: boolean("has_additional_docs_required").default(false),
	interimStepStatus: varchar("interim_step_status", { length: 20 }).default('pending'),
	kycDraftData: jsonb("kyc_draft_data"),
	stepStatus: jsonb("step_status"),
	source: varchar({ length: 50 }),
	remarks: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
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
	dob: timestamp({ withTimezone: true, mode: 'string' }),
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
	qualifiedAt: timestamp("qualified_at", { withTimezone: true, mode: 'string' }),
	qualificationNotes: text("qualification_notes"),
	convertedDealId: varchar("converted_deal_id", { length: 255 }),
	convertedAt: timestamp("converted_at", { withTimezone: true, mode: 'string' }),
	totalAiCalls: integer("total_ai_calls").default(0),
	lastAiCallAt: timestamp("last_ai_call_at", { withTimezone: true, mode: 'string' }),
	lastCallOutcome: text("last_call_outcome"),
	aiPriorityScore: numeric("ai_priority_score", { precision: 5, scale:  2 }),
	nextCallAfter: timestamp("next_call_after", { withTimezone: true, mode: 'string' }),
	doNotCall: boolean("do_not_call").default(false),
	workflowStep: integer("workflow_step").default(1).notNull(),
	primaryProductId: uuid("primary_product_id"),
	uploaderId: uuid("uploader_id").notNull(),
	aiManaged: boolean("ai_managed").default(false),
	aiOwner: text("ai_owner"),
	manualTakeover: boolean("manual_takeover").default(false),
	lastAiActionAt: timestamp("last_ai_action_at", { withTimezone: true, mode: 'string' }),
	intentScore: integer("intent_score"),
	intentReason: text("intent_reason"),
	nextCallAt: timestamp("next_call_at", { withTimezone: true, mode: 'string' }),
	callPriority: integer("call_priority").default(0),
	conversationSummary: text("conversation_summary"),
	lastCallStatus: text("last_call_status"),
	smReviewStatus: varchar("sm_review_status", { length: 30 }).default('not_submitted'),
	submittedToSmAt: timestamp("submitted_to_sm_at", { withTimezone: true, mode: 'string' }),
	smAssignedTo: uuid("sm_assigned_to"),
	consentLinkUrl: text("consent_link_url"),
	consentLinkSentAt: timestamp("consent_link_sent_at", { withTimezone: true, mode: 'string' }),
	consentLinkExpiresAt: timestamp("consent_link_expires_at", { withTimezone: true, mode: 'string' }),
	consentDeliveryChannel: varchar("consent_delivery_channel", { length: 50 }),
	esignTransactionId: varchar("esign_transaction_id", { length: 255 }),
	esignCertificateId: varchar("esign_certificate_id", { length: 255 }),
	esignCompletedAt: timestamp("esign_completed_at", { withTimezone: true, mode: 'string' }),
	esignFailedAt: timestamp("esign_failed_at", { withTimezone: true, mode: 'string' }),
	esignErrorCode: varchar("esign_error_code", { length: 100 }),
	esignErrorMessage: text("esign_error_message"),
	consentVerifiedBy: uuid("consent_verified_by"),
	consentVerifiedAt: timestamp("consent_verified_at", { withTimezone: true, mode: 'string' }),
	consentVerificationNotes: text("consent_verification_notes"),
	consentFinal: boolean("consent_final").default(false),
	consentRejectionReason: varchar("consent_rejection_reason", { length: 255 }),
	consentRejectionNotes: text("consent_rejection_notes"),
	consentRejectedBy: uuid("consent_rejected_by"),
	consentRejectedAt: timestamp("consent_rejected_at", { withTimezone: true, mode: 'string' }),
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
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	phoneQuality: varchar("phone_quality", { length: 20 }).default('valid'),
	normalizedPhone: varchar("normalized_phone", { length: 20 }),
	intentBand: varchar("intent_band", { length: 20 }),
	intentScoredAt: timestamp("intent_scored_at", { withTimezone: true, mode: 'string' }),
	intentDetails: jsonb("intent_details"),
	couponCode: varchar("coupon_code", { length: 20 }),
	couponStatus: varchar("coupon_status", { length: 20 }),
}, (table) => [
	index("idx_leads_ai_queue").using("btree", table.aiManaged.asc().nullsLast().op("bool_ops"), table.manualTakeover.asc().nullsLast().op("bool_ops"), table.nextCallAt.asc().nullsLast().op("timestamptz_ops"), table.callPriority.asc().nullsLast().op("timestamptz_ops")).where(sql`((ai_managed = true) AND (manual_takeover = false))`),
	index("leads_ai_managed_idx").using("btree", table.aiManaged.asc().nullsLast().op("bool_ops")),
	index("leads_dealer_id_idx").using("btree", table.dealerId.asc().nullsLast().op("text_ops")),
	index("leads_google_place_id_idx").using("btree", table.googlePlaceId.asc().nullsLast().op("text_ops")),
	index("leads_intent_band_idx").using("btree", table.intentBand.asc().nullsLast().op("text_ops")),
	index("leads_interest_idx").using("btree", table.interestLevel.asc().nullsLast().op("text_ops")),
	index("leads_interest_level_idx").using("btree", table.interestLevel.asc().nullsLast().op("text_ops")),
	index("leads_normalized_phone_idx").using("btree", table.normalizedPhone.asc().nullsLast().op("text_ops")),
	index("leads_scrape_batch_id_idx").using("btree", table.scrapeBatchId.asc().nullsLast().op("text_ops")),
	index("leads_source_idx").using("btree", table.leadSource.asc().nullsLast().op("text_ops")),
	index("leads_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "leads_dealer_id_fkey"
		}),
	foreignKey({
			columns: [table.primaryProductId],
			foreignColumns: [products.id],
			name: "leads_primary_product_id_fkey"
		}),
	unique("leads_reference_id_key").on(table.referenceId),
]);

export const otherDocumentRequests = pgTable("other_document_requests", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	requestedBy: uuid("requested_by"),
	documentName: text("document_name").notNull(),
	description: text(),
	documentUrl: text("document_url"),
	status: varchar({ length: 20 }).default('pending'),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	uploadToken: varchar("upload_token", { length: 255 }),
	tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "other_document_requests_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const oemInventoryForPdi = pgTable("oem_inventory_for_pdi", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	inventoryId: varchar("inventory_id", { length: 255 }),
	oemId: varchar("oem_id", { length: 255 }),
	status: varchar({ length: 20 }).default('pending'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.inventoryId],
			foreignColumns: [inventory.id],
			name: "oem_inventory_for_pdi_inventory_id_fkey"
		}),
	foreignKey({
			columns: [table.oemId],
			foreignColumns: [oems.id],
			name: "oem_inventory_for_pdi_oem_id_fkey"
		}),
]);

export const orderDisputes = pgTable("order_disputes", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	orderId: varchar("order_id", { length: 255 }).notNull(),
	disputeType: varchar("dispute_type", { length: 50 }).notNull(),
	description: text().notNull(),
	status: varchar({ length: 20 }).default('open').notNull(),
	resolution: text(),
	raisedBy: uuid("raised_by").notNull(),
	resolvedBy: uuid("resolved_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "order_disputes_order_id_fkey"
		}),
]);

export const orders = pgTable("orders", {
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
	grnDate: timestamp("grn_date", { withTimezone: true, mode: 'string' }),
	paymentStatus: varchar("payment_status", { length: 20 }).default('unpaid').notNull(),
	paymentAmount: numeric("payment_amount", { precision: 12, scale:  2 }).default('0').notNull(),
	paymentMode: varchar("payment_mode", { length: 50 }),
	transactionId: text("transaction_id"),
	paymentDate: timestamp("payment_date", { withTimezone: true, mode: 'string' }),
	orderStatus: varchar("order_status", { length: 50 }).default('pi_awaited').notNull(),
	deliveryStatus: varchar("delivery_status", { length: 20 }).default('pending').notNull(),
	expectedDeliveryDate: timestamp("expected_delivery_date", { withTimezone: true, mode: 'string' }),
	actualDeliveryDate: timestamp("actual_delivery_date", { withTimezone: true, mode: 'string' }),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("orders_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("orders_payment_status_idx").using("btree", table.paymentStatus.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.provisionId],
			foreignColumns: [provisions.id],
			name: "orders_provision_id_fkey"
		}),
	foreignKey({
			columns: [table.oemId],
			foreignColumns: [oems.id],
			name: "orders_oem_id_fkey"
		}),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [accounts.id],
			name: "orders_account_id_fkey"
		}),
]);

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
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("oems_gstin_key").on(table.gstin),
]);

export const pdiRecords = pgTable("pdi_records", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	inventoryId: varchar("inventory_id", { length: 255 }),
	performedBy: uuid("performed_by"),
	status: varchar({ length: 20 }).default('pending').notNull(),
	checklist: jsonb(),
	notes: text(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.inventoryId],
			foreignColumns: [inventory.id],
			name: "pdi_records_inventory_id_fkey"
		}),
]);

export const scrapedDealerLeads = pgTable("scraped_dealer_leads", {
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
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }),
	explorationStatus: varchar("exploration_status", { length: 30 }).default('unassigned').notNull(),
	explorationNotes: text("exploration_notes"),
	exploredAt: timestamp("explored_at", { withTimezone: true, mode: 'string' }),
	convertedLeadId: varchar("converted_lead_id", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	email: text(),
	gstNumber: text("gst_number"),
	businessType: text("business_type"),
	productsSold: text("products_sold"),
	website: text(),
	qualityScore: integer("quality_score").default(1),
	phoneValid: boolean("phone_valid").default(false),
}, (table) => [
	index("sdl_assigned_to_idx").using("btree", table.assignedTo.asc().nullsLast().op("uuid_ops")),
	index("sdl_name_city_idx").using("btree", table.dealerName.asc().nullsLast().op("text_ops"), table.locationCity.asc().nullsLast().op("text_ops")),
	index("sdl_phone_idx").using("btree", table.phone.asc().nullsLast().op("text_ops")),
	index("sdl_run_idx").using("btree", table.scraperRunId.asc().nullsLast().op("text_ops")),
	index("sdl_source_url_idx").using("btree", table.sourceUrl.asc().nullsLast().op("text_ops")),
	index("sdl_status_idx").using("btree", table.explorationStatus.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.convertedLeadId],
			foreignColumns: [leads.id],
			name: "scraped_dealer_leads_converted_lead_id_fkey"
		}),
]);

export const productCategories = pgTable("product_categories", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("product_categories_name_key").on(table.name),
	unique("product_categories_slug_key").on(table.slug),
]);

export const scrapeBatches = pgTable("scrape_batches", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	query: text().notNull(),
	city: varchar({ length: 100 }),
	state: varchar({ length: 100 }),
	radiusMeters: integer("radius_meters"),
	latitude: numeric({ precision: 10, scale:  8 }),
	longitude: numeric({ precision: 11, scale:  8 }),
	totalResults: integer("total_results").default(0),
	newLeadsCreated: integer("new_leads_created").default(0),
	duplicatesFound: integer("duplicates_found").default(0),
	enrichedExisting: integer("enriched_existing").default(0),
	noPhoneCount: integer("no_phone_count").default(0),
	status: varchar({ length: 20 }).default('pending').notNull(),
	errorMessage: text("error_message"),
	initiatedBy: uuid("initiated_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
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
	scrapedAt: timestamp("scraped_at", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_city_queue_lookup").using("btree", table.baseQuery.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	unique("scraper_city_queue_base_query_state_city_key").on(table.baseQuery, table.state, table.city),
]);

export const scraperDedupLogs = pgTable("scraper_dedup_logs", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	scraperRunId: varchar("scraper_run_id", { length: 255 }).notNull(),
	rawDealerName: text("raw_dealer_name"),
	rawPhone: varchar("raw_phone", { length: 20 }),
	rawLocation: text("raw_location"),
	rawSourceUrl: text("raw_source_url"),
	skipReason: varchar("skip_reason", { length: 50 }).notNull(),
	matchedLeadId: varchar("matched_lead_id", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ddup_run_idx").using("btree", table.scraperRunId.asc().nullsLast().op("text_ops")),
]);

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
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_scraper_leads_name_city").using("btree", table.name.asc().nullsLast().op("text_ops"), table.city.asc().nullsLast().op("text_ops")),
]);

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
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const scraperRaw = pgTable("scraper_raw", {
	id: text().primaryKey().notNull(),
	runId: text("run_id"),
	rawData: text("raw_data"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
});

export const personalDetails = pgTable("personal_details", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	aadhaarNo: varchar("aadhaar_no", { length: 12 }),
	panNo: varchar("pan_no", { length: 10 }),
	dob: timestamp({ withTimezone: true, mode: 'string' }),
	email: text(),
	income: numeric({ precision: 12, scale:  2 }),
	fatherHusbandName: text("father_husband_name"),
	maritalStatus: varchar("marital_status", { length: 20 }),
	spouseName: text("spouse_name"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	financeType: varchar("finance_type", { length: 50 }),
	financier: varchar({ length: 100 }),
	assetType: varchar("asset_type", { length: 50 }),
	vehicleRc: varchar("vehicle_rc", { length: 50 }),
	loanType: varchar("loan_type", { length: 100 }),
	localAddress: text("local_address"),
	dobConfidence: numeric("dob_confidence", { precision: 5, scale:  2 }),
	nameConfidence: numeric("name_confidence", { precision: 5, scale:  2 }),
	addressConfidence: numeric("address_confidence", { precision: 5, scale:  2 }),
	ocrProcessedAt: timestamp("ocr_processed_at", { withTimezone: true, mode: 'string' }),
	permanentAddress: text("permanent_address"),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "personal_details_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const provisions = pgTable("provisions", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	orderId: varchar("order_id", { length: 255 }),
	oemId: varchar("oem_id", { length: 255 }),
	amount: numeric({ precision: 12, scale:  2 }),
	status: varchar({ length: 20 }).default('pending'),
	notes: text(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.oemId],
			foreignColumns: [oems.id],
			name: "provisions_oem_id_fkey"
		}),
]);

export const scraperRuns = pgTable("scraper_runs", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	triggeredBy: uuid("triggered_by").notNull(),
	status: varchar({ length: 20 }).default('running').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	searchQueries: jsonb("search_queries"),
	totalFound: integer("total_found").default(0),
	newLeadsSaved: integer("new_leads_saved").default(0),
	duplicatesSkipped: integer("duplicates_skipped").default(0),
	errorMessage: text("error_message"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	cleanedLeads: integer("cleaned_leads"),
	durationMs: integer("duration_ms"),
}, (table) => [
	index("scraper_runs_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("scraper_runs_triggered_by_idx").using("btree", table.triggeredBy.asc().nullsLast().op("uuid_ops")),
]);

export const scraperSchedules = pgTable("scraper_schedules", {
	id: text().primaryKey().notNull(),
	frequency: text().default('weekly').notNull(),
	dayOfWeek: integer("day_of_week").default(1),
	timeOfDay: text("time_of_day").default('04:00'),
	isActive: boolean("is_active").default(true).notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const scraperSearchQueries = pgTable("scraper_search_queries", {
	id: text().primaryKey().notNull(),
	queryText: text("query_text").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const slas = pgTable("slas", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	entityType: varchar("entity_type", { length: 50 }).notNull(),
	entityId: varchar("entity_id", { length: 255 }).notNull(),
	deadline: timestamp({ withTimezone: true, mode: 'string' }),
	breached: boolean().default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const users = pgTable("users", {
	id: uuid().notNull(),
	email: text().notNull(),
	name: text().notNull(),
	role: varchar({ length: 50 }).notNull(),
	dealerId: varchar("dealer_id", { length: 255 }),
	phone: text(),
	avatarUrl: text("avatar_url"),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	passwordHash: text("password_hash"),
	mustChangePassword: boolean("must_change_password").default(false).notNull(),
}, (table) => [
	unique("users_email_key").on(table.email),
]);

export const serviceTickets = pgTable("service_tickets", {
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
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }),
	status: varchar({ length: 30 }).default('open').notNull(),
	resolutionType: varchar("resolution_type", { length: 50 }),
	resolutionNotes: text("resolution_notes"),
	resolvedBy: uuid("resolved_by"),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	slaDeadline: timestamp("sla_deadline", { withTimezone: true, mode: 'string' }),
	slaBreached: boolean("sla_breached").default(false),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("service_tickets_dealer_id_idx").using("btree", table.dealerId.asc().nullsLast().op("text_ops")),
	index("service_tickets_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.deployedAssetId],
			foreignColumns: [deployedAssets.id],
			name: "service_tickets_deployed_asset_id_fkey"
		}),
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "service_tickets_dealer_id_fkey"
		}),
]);

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
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "campaign_segments_dealer_id_fkey"
		}),
]);

export const callSessions = pgTable("call_sessions", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }),
	initiatedBy: uuid("initiated_by"),
	status: varchar({ length: 20 }).default('initiated'),
	provider: varchar({ length: 50 }),
	providerSessionId: text("provider_session_id"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	durationSeconds: integer("duration_seconds"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "call_sessions_lead_id_fkey"
		}),
]);

export const callRecords = pgTable("call_records", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }),
	sessionId: varchar("session_id", { length: 255 }),
	recordingUrl: text("recording_url"),
	transcript: text(),
	summary: text(),
	sentiment: varchar({ length: 20 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	bolnaCallId: varchar("bolna_call_id", { length: 255 }),
	status: text().default('queued'),
	durationSeconds: integer("duration_seconds"),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [callSessions.id],
			name: "call_records_session_id_fkey"
		}),
]);

export const aiCallLogs = pgTable("ai_call_logs", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }),
	callSessionId: varchar("call_session_id", { length: 255 }),
	provider: varchar({ length: 50 }),
	status: varchar({ length: 20 }),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	modelUsed: varchar("model_used", { length: 50 }),
	intentScore: integer("intent_score"),
	intentReason: text("intent_reason"),
	nextAction: varchar("next_action", { length: 50 }),
}, (table) => [
	index("idx_ai_call_logs_lead").using("btree", table.leadId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "ai_call_logs_lead_id_fkey"
		}),
	foreignKey({
			columns: [table.callSessionId],
			foreignColumns: [callSessions.id],
			name: "ai_call_logs_call_session_id_fkey"
		}),
]);

export const bolnaCalls = pgTable("bolna_calls", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }),
	bolnaCallId: text("bolna_call_id"),
	agentId: text("agent_id"),
	status: varchar({ length: 20 }),
	recordingUrl: text("recording_url"),
	transcript: text(),
	durationSeconds: integer("duration_seconds"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "bolna_calls_lead_id_fkey"
		}),
]);

export const coBorrowers = pgTable("co_borrowers", {
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
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "co_borrowers_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const coBorrowerDocuments = pgTable("co_borrower_documents", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	coBorrowerId: varchar("co_borrower_id", { length: 255 }),
	documentType: varchar("document_type", { length: 50 }).notNull(),
	documentUrl: text("document_url"),
	status: varchar({ length: 30 }).default('pending'),
	ocrData: jsonb("ocr_data"),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "co_borrower_documents_lead_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.coBorrowerId],
			foreignColumns: [coBorrowers.id],
			name: "co_borrower_documents_co_borrower_id_fkey"
		}),
]);

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
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "admin_kyc_reviews_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const assignmentChangeLogs = pgTable("assignment_change_logs", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	oldUserId: uuid("old_user_id"),
	newUserId: uuid("new_user_id"),
	changedBy: uuid("changed_by"),
	changeType: varchar("change_type", { length: 50 }).notNull(),
	reason: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "assignment_change_logs_lead_id_fkey"
		}),
]);

export const adminVerificationQueue = pgTable("admin_verification_queue", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	queueType: varchar("queue_type", { length: 50 }).default('kyc_verification').notNull(),
	leadId: text("lead_id").notNull(),
	priority: varchar({ length: 20 }).default('normal').notNull(),
	assignedTo: uuid("assigned_to"),
	submittedBy: uuid("submitted_by"),
	status: varchar({ length: 50 }).default('pending_itarang_verification').notNull(),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("admin_vq_assigned_idx").using("btree", table.assignedTo.asc().nullsLast().op("uuid_ops")),
	index("admin_vq_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("admin_vq_lead_idx").using("btree", table.leadId.asc().nullsLast().op("text_ops")),
	index("admin_vq_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const approvals = pgTable("approvals", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	entityType: varchar("entity_type", { length: 50 }).notNull(),
	entityId: varchar("entity_id", { length: 255 }).notNull(),
	level: integer().notNull(),
	approverRole: varchar("approver_role", { length: 50 }).notNull(),
	status: varchar({ length: 20 }).default('pending').notNull(),
	approverId: uuid("approver_id"),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const auditLogs = pgTable("audit_logs", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	entityType: varchar("entity_type", { length: 50 }),
	entityId: varchar("entity_id", { length: 255 }),
	action: varchar({ length: 50 }),
	performedBy: uuid("performed_by"),
	oldData: jsonb("old_data"),
	newData: jsonb("new_data"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	changes: jsonb(),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

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
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const dealerOnboardingApplications = pgTable("dealer_onboarding_applications", {
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
	submittedAt: timestamp("submitted_at", { mode: 'string' }),
	approvedAt: timestamp("approved_at", { mode: 'string' }),
	rejectedAt: timestamp("rejected_at", { mode: 'string' }),
	rejectionReason: text("rejection_reason"),
	adminNotes: text("admin_notes"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
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
	correctionRequestedAt: timestamp("correction_requested_at", { mode: 'string' }),
	revalidatedAt: timestamp("revalidated_at", { mode: 'string' }),
	lastActionBy: uuid("last_action_by"),
	lastActionAt: timestamp("last_action_at", { mode: 'string' }),
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
	signedAt: timestamp("signed_at", { mode: 'string' }),
	lastActionTimestamp: timestamp("last_action_timestamp", { mode: 'string' }),
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
	agreementLastInitiatedAt: timestamp("agreement_last_initiated_at", { mode: 'string' }),
	agreementExpiredAt: timestamp("agreement_expired_at", { mode: 'string' }),
	agreementFailedAt: timestamp("agreement_failed_at", { mode: 'string' }),
	agreementFailureReason: text("agreement_failure_reason"),
	agreementCompletedAt: timestamp("agreement_completed_at", { mode: 'string' }),
	signedAgreementStoragePath: text("signed_agreement_storage_path"),
	auditTrailStoragePath: text("audit_trail_storage_path"),
	agreementStatus: varchar("agreement_status", { length: 50 }).default('not_generated'),
	providerRawResponse: jsonb("provider_raw_response"),
	signedAgreementUrl: text("signed_agreement_url"),
	auditTrailUrl: text("audit_trail_url"),
	ownerLandline: varchar("owner_landline", { length: 20 }),
});

export const deployedAssets = pgTable("deployed_assets", {
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
	deploymentDate: timestamp("deployment_date", { withTimezone: true, mode: 'string' }).notNull(),
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
	lastTelemetryAt: timestamp("last_telemetry_at", { withTimezone: true, mode: 'string' }),
	telemetryData: jsonb("telemetry_data"),
	totalCycles: integer("total_cycles"),
	warrantyStartDate: timestamp("warranty_start_date", { withTimezone: true, mode: 'string' }),
	warrantyEndDate: timestamp("warranty_end_date", { withTimezone: true, mode: 'string' }),
	warrantyStatus: varchar("warranty_status", { length: 20 }).default('active'),
	status: varchar({ length: 20 }).default('active').notNull(),
	lastMaintenanceAt: timestamp("last_maintenance_at", { withTimezone: true, mode: 'string' }),
	nextMaintenanceDue: timestamp("next_maintenance_due", { withTimezone: true, mode: 'string' }),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("deployed_assets_dealer_id_idx").using("btree", table.dealerId.asc().nullsLast().op("text_ops")),
	index("deployed_assets_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.inventoryId],
			foreignColumns: [inventory.id],
			name: "deployed_assets_inventory_id_fkey"
		}),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "deployed_assets_lead_id_fkey"
		}),
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "deployed_assets_dealer_id_fkey"
		}),
]);

export const couponBatches = pgTable("coupon_batches", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	name: varchar({ length: 200 }).notNull(),
	dealerId: varchar("dealer_id", { length: 255 }).notNull(),
	prefix: varchar({ length: 20 }).notNull(),
	couponValue: numeric("coupon_value", { precision: 10, scale:  2 }).default('0').notNull(),
	totalQuantity: integer("total_quantity").notNull(),
	expiryDate: timestamp("expiry_date", { withTimezone: true, mode: 'string' }),
	status: varchar({ length: 20 }).default('active').notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("coupon_batches_dealer_idx").using("btree", table.dealerId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "coupon_batches_dealer_id_fkey"
		}),
]);

export const dealerAgreementEvents = pgTable("dealer_agreement_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	applicationId: uuid("application_id").notNull(),
	providerDocumentId: text("provider_document_id"),
	requestId: text("request_id"),
	eventType: varchar("event_type", { length: 100 }).notNull(),
	signerRole: varchar("signer_role", { length: 50 }),
	eventStatus: varchar("event_status", { length: 50 }),
	eventPayload: jsonb("event_payload").default({}),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [dealerOnboardingApplications.id],
			name: "dealer_agreement_events_application_id_fkey"
		}).onDelete("cascade"),
]);

export const dealerLeads = pgTable("dealer_leads", {
	id: text().primaryKey().notNull(),
	dealerName: text("dealer_name"),
	phone: text(),
	language: text(),
	followUpHistory: jsonb("follow_up_history").default([]),
	currentStatus: text("current_status"),
	totalAttempts: integer("total_attempts").default(0),
	finalIntentScore: integer("final_intent_score").default(0),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	location: text(),
	memory: jsonb(),
	nextCallAt: timestamp("next_call_at", { mode: 'string' }),
	shopName: text("shop_name"),
	overallSummary: text("overall_summary"),
	assignedTo: text("assigned_to"),
	approvedBy: text("approved_by"),
	rejectedBy: text("rejected_by"),
}, (table) => [
	unique("dealer_leads_phone_key").on(table.phone),
]);

export const dealerAgreementSigners = pgTable("dealer_agreement_signers", {
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
	signedAt: timestamp("signed_at", { mode: 'string' }),
	lastEventAt: timestamp("last_event_at", { mode: 'string' }),
	providerRawResponse: jsonb("provider_raw_response").default({}),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [dealerOnboardingApplications.id],
			name: "dealer_agreement_signers_application_id_fkey"
		}).onDelete("cascade"),
]);

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
	invoiceIssuedAt: timestamp("invoice_issued_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	expiredBy: uuid("expired_by"),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
	expiryReason: text("expiry_reason"),
	rejectedBy: uuid("rejected_by"),
	rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: 'string' }),
	rejectionReason: text("rejection_reason"),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "deals_lead_id_fkey"
		}),
]);

export const conversationMessages = pgTable("conversation_messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	callRecordId: varchar("call_record_id", { length: 255 }).notNull(),
	role: text().notNull(),
	message: text().notNull(),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("conversation_messages_call_record_id_idx").using("btree", table.callRecordId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.callRecordId],
			foreignColumns: [callRecords.id],
			name: "conversation_messages_call_record_id_call_records_id_fk"
		}).onDelete("cascade"),
]);

export const deploymentHistory = pgTable("deployment_history", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	deployedAssetId: varchar("deployed_asset_id", { length: 255 }).notNull(),
	action: varchar({ length: 50 }).notNull(),
	description: text(),
	performedBy: uuid("performed_by").notNull(),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.deployedAssetId],
			foreignColumns: [deployedAssets.id],
			name: "deployment_history_deployed_asset_id_fkey"
		}).onDelete("cascade"),
]);

export const dealerSubscriptions = pgTable("dealer_subscriptions", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	dealerId: varchar("dealer_id", { length: 255 }).notNull(),
	planName: varchar("plan_name", { length: 50 }).notNull(),
	status: varchar({ length: 20 }).default('active').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	features: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "dealer_subscriptions_dealer_id_fkey"
		}),
]);

export const digilockerTransactions = pgTable("digilocker_transactions", {
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
	linkSentAt: timestamp("link_sent_at", { withTimezone: true, mode: 'string' }),
	linkOpenedAt: timestamp("link_opened_at", { withTimezone: true, mode: 'string' }),
	customerAuthorizedAt: timestamp("customer_authorized_at", { withTimezone: true, mode: 'string' }),
	digilockerRawResponse: jsonb("digilocker_raw_response"),
	aadhaarExtractedData: jsonb("aadhaar_extracted_data"),
	crossMatchResult: jsonb("cross_match_result"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("digilocker_lead_idx").using("btree", table.leadId.asc().nullsLast().op("text_ops")),
	index("digilocker_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const consentRecords = pgTable("consent_records", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	consentType: varchar("consent_type", { length: 30 }).notNull(),
	channel: varchar({ length: 20 }),
	consentToken: text("consent_token"),
	consentLinkUrl: text("consent_link_url"),
	consentStatus: varchar("consent_status", { length: 20 }).default('awaiting_signature'),
	signedAt: timestamp("signed_at", { withTimezone: true, mode: 'string' }),
	generatedPdfUrl: text("generated_pdf_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	consentFor: varchar("consent_for", { length: 20 }).default('primary').notNull(),
	consentLinkSentAt: timestamp("consent_link_sent_at", { withTimezone: true, mode: 'string' }),
	signedConsentUrl: text("signed_consent_url"),
	verifiedBy: uuid("verified_by"),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
	consentLinkExpiresAt: timestamp("consent_link_expires_at", { withTimezone: true, mode: 'string' }),
	consentDeliveryChannel: varchar("consent_delivery_channel", { length: 20 }),
	signMethod: varchar("sign_method", { length: 30 }),
	esignTransactionId: varchar("esign_transaction_id", { length: 255 }),
	esignCertificateId: varchar("esign_certificate_id", { length: 255 }),
	esignProvider: varchar("esign_provider", { length: 50 }),
	esignErrorCode: varchar("esign_error_code", { length: 50 }),
	esignErrorMessage: text("esign_error_message"),
	signerAadhaarMasked: varchar("signer_aadhaar_masked", { length: 20 }),
	rejectedBy: uuid("rejected_by"),
	rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: 'string' }),
	rejectionReason: varchar("rejection_reason", { length: 255 }),
	reviewerNotes: text("reviewer_notes"),
	consentAttemptCount: integer("consent_attempt_count").default(0),
	esignRetryCount: integer("esign_retry_count").default(0),
}, (table) => [
	index("consent_records_lead_id_idx").using("btree", table.leadId.asc().nullsLast().op("text_ops")),
	index("consent_records_status_idx").using("btree", table.consentStatus.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "consent_records_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const documents = pgTable("documents", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	type: varchar({ length: 50 }).notNull(),
	url: text().notNull(),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "documents_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const couponCodes = pgTable("coupon_codes", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	code: varchar({ length: 50 }).notNull(),
	dealerId: varchar("dealer_id", { length: 255 }),
	isUsed: boolean("is_used").default(false),
	usedByLeadId: varchar("used_by_lead_id", { length: 255 }),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: varchar({ length: 20 }).default('available').notNull(),
	creditsAvailable: integer("credits_available").default(1),
	usedBy: uuid("used_by"),
	validatedAt: timestamp("validated_at", { withTimezone: true, mode: 'string' }),
	discountType: varchar("discount_type", { length: 20 }).default('flat'),
	discountValue: numeric("discount_value", { precision: 10, scale:  2 }).default('0'),
	maxDiscountCap: numeric("max_discount_cap", { precision: 10, scale:  2 }),
	minAmount: numeric("min_amount", { precision: 10, scale:  2 }),
	batchId: varchar("batch_id", { length: 255 }),
	reservedAt: timestamp("reserved_at", { withTimezone: true, mode: 'string' }),
	reservedBy: uuid("reserved_by"),
	reservedForLeadId: varchar("reserved_for_lead_id", { length: 255 }),
}, (table) => [
	index("coupon_codes_dealer_status_idx").using("btree", table.dealerId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("coupon_codes_reserved_lead_idx").using("btree", table.reservedForLeadId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "coupon_codes_dealer_id_fkey"
		}),
	foreignKey({
			columns: [table.usedByLeadId],
			foreignColumns: [leads.id],
			name: "coupon_codes_used_by_lead_fkey"
		}),
	foreignKey({
			columns: [table.batchId],
			foreignColumns: [couponBatches.id],
			name: "coupon_codes_batch_id_fkey"
		}),
	foreignKey({
			columns: [table.reservedForLeadId],
			foreignColumns: [leads.id],
			name: "coupon_codes_reserved_for_lead_id_fkey"
		}),
	unique("coupon_codes_code_key").on(table.code),
]);

export const intellicarToken = pgTable("intellicar_token", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	di: bigint({ mode: "number" }).primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	token: text(),
});

export const dealerOnboardingDocuments = pgTable("dealer_onboarding_documents", {
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
	uploadedAt: timestamp("uploaded_at", { mode: 'string' }).defaultNow().notNull(),
	docStatus: varchar("doc_status", { length: 30 }).default('uploaded').notNull(),
	verificationStatus: varchar("verification_status", { length: 30 }).default('pending'),
	verifiedAt: timestamp("verified_at", { mode: 'string' }),
	verifiedBy: uuid("verified_by"),
	rejectionReason: text("rejection_reason"),
	extractedData: jsonb("extracted_data").default({}),
	apiVerificationResults: jsonb("api_verification_results").default({}),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
	adminComment: text("admin_comment"),
}, (table) => [
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [dealerOnboardingApplications.id],
			name: "dealer_onboarding_documents_application_id_fkey"
		}).onDelete("cascade"),
]);

export const kycVerificationMetadata = pgTable("kyc_verification_metadata", {
	leadId: varchar("lead_id", { length: 255 }).primaryKey().notNull(),
	submissionTimestamp: timestamp("submission_timestamp", { withTimezone: true, mode: 'string' }),
	caseType: varchar("case_type", { length: 20 }),
	couponCode: varchar("coupon_code", { length: 100 }),
	couponStatus: varchar("coupon_status", { length: 30 }).default('reserved'),
	documentsCount: integer("documents_count"),
	consentVerified: boolean("consent_verified").default(false),
	dealerEditsLocked: boolean("dealer_edits_locked").default(false),
	verificationStartedAt: timestamp("verification_started_at", { withTimezone: true, mode: 'string' }),
	firstApiExecutionAt: timestamp("first_api_execution_at", { withTimezone: true, mode: 'string' }),
	firstApiType: varchar("first_api_type", { length: 50 }),
	finalDecision: varchar("final_decision", { length: 20 }),
	finalDecisionAt: timestamp("final_decision_at", { withTimezone: true, mode: 'string' }),
	finalDecisionBy: uuid("final_decision_by"),
	finalDecisionNotes: text("final_decision_notes"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("kvm_coupon_idx").using("btree", table.couponCode.asc().nullsLast().op("text_ops")),
]);

export const oemContacts = pgTable("oem_contacts", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	oemId: varchar("oem_id", { length: 255 }).notNull(),
	name: text().notNull(),
	designation: text(),
	email: text(),
	phone: varchar({ length: 20 }),
	isPrimary: boolean("is_primary").default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.oemId],
			foreignColumns: [oems.id],
			name: "oem_contacts_oem_id_fkey"
		}).onDelete("cascade"),
]);

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
	receivedDate: timestamp("received_date", { withTimezone: true, mode: 'string' }),
	pdiStatus: varchar("pdi_status", { length: 20 }).default('pending'),
	pdiCompletedAt: timestamp("pdi_completed_at", { withTimezone: true, mode: 'string' }),
	pdiBy: uuid("pdi_by"),
	dealerId: varchar("dealer_id", { length: 255 }),
	allocatedToDealerAt: timestamp("allocated_to_dealer_at", { withTimezone: true, mode: 'string' }),
	soldAt: timestamp("sold_at", { withTimezone: true, mode: 'string' }),
	dealId: varchar("deal_id", { length: 255 }),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	productId: uuid("product_id"),
	inventoryAmount: numeric("inventory_amount", { precision: 12, scale:  2 }),
	gstPercent: numeric("gst_percent", { precision: 5, scale:  2 }),
	gstAmount: numeric("gst_amount", { precision: 12, scale:  2 }),
	finalAmount: numeric("final_amount", { precision: 12, scale:  2 }),
	oemInvoiceNumber: text("oem_invoice_number"),
	oemInvoiceDate: timestamp("oem_invoice_date", { withTimezone: true, mode: 'string' }),
	oemInvoiceUrl: text("oem_invoice_url"),
	productManualUrl: text("product_manual_url"),
	warrantyDocumentUrl: text("warranty_document_url"),
	warehouseLocation: text("warehouse_location"),
	manufacturingDate: timestamp("manufacturing_date", { withTimezone: true, mode: 'string' }),
	expiryDate: timestamp("expiry_date", { withTimezone: true, mode: 'string' }),
	quantity: integer(),
}, (table) => [
	foreignKey({
			columns: [table.oemId],
			foreignColumns: [oems.id],
			name: "inventory_oem_id_fkey"
		}),
	foreignKey({
			columns: [table.dealerId],
			foreignColumns: [accounts.id],
			name: "inventory_dealer_id_fkey"
		}),
	foreignKey({
			columns: [table.productId],
			foreignColumns: [products.id],
			name: "inventory_product_id_fkey"
		}),
	unique("inventory_serial_number_key").on(table.serialNumber),
]);

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
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("accounts_gstin_key").on(table.gstin),
	unique("accounts_dealer_code_key").on(table.dealerCode),
]);

export const kycDocuments = pgTable("kyc_documents", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	docType: varchar("doc_type", { length: 50 }).notNull(),
	fileUrl: text("file_url"),
	verificationStatus: varchar("verification_status", { length: 30 }).default('pending'),
	ocrData: jsonb("ocr_data"),
	apiResponse: jsonb("api_response"),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	fileName: text("file_name"),
	fileSize: integer("file_size"),
	failedReason: text("failed_reason"),
	fileType: varchar("file_type", { length: 50 }),
	docStatus: varchar("doc_status", { length: 30 }).default('not_uploaded'),
	rejectionReason: text("rejection_reason"),
	uploadedBy: uuid("uploaded_by"),
	verifiedBy: uuid("verified_by"),
}, (table) => [
	index("kyc_documents_doc_status_idx").using("btree", table.docStatus.asc().nullsLast().op("text_ops")),
	index("kyc_documents_doc_type_idx").using("btree", table.docType.asc().nullsLast().op("text_ops")),
	index("kyc_documents_lead_id_idx").using("btree", table.leadId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "kyc_documents_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const kycVerifications = pgTable("kyc_verifications", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	leadId: varchar("lead_id", { length: 255 }).notNull(),
	verificationType: varchar("verification_type", { length: 50 }).notNull(),
	status: varchar({ length: 30 }).default('pending'),
	apiProvider: varchar("api_provider", { length: 50 }),
	apiRequest: jsonb("api_request"),
	apiResponse: jsonb("api_response"),
	failedReason: text("failed_reason"),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	matchScore: numeric("match_score", { precision: 5, scale:  2 }),
	retryCount: integer("retry_count").default(0),
	adminAction: varchar("admin_action", { length: 30 }),
	adminActionBy: uuid("admin_action_by"),
	adminActionAt: timestamp("admin_action_at", { withTimezone: true, mode: 'string' }),
	adminActionNotes: text("admin_action_notes"),
}, (table) => [
	index("kyc_verifications_lead_id_idx").using("btree", table.leadId.asc().nullsLast().op("text_ops")),
	index("kyc_verifications_type_idx").using("btree", table.verificationType.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "kyc_verifications_lead_id_fkey"
		}).onDelete("cascade"),
]);

export const products = pgTable("products", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	categoryId: uuid("category_id").notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	voltageV: integer("voltage_v").notNull(),
	capacityAh: integer("capacity_ah").notNull(),
	sku: text().notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	hsnCode: varchar("hsn_code", { length: 8 }),
	assetType: varchar("asset_type", { length: 50 }),
	isSerialized: boolean("is_serialized").default(true).notNull(),
	warrantyMonths: integer("warranty_months").default(0).notNull(),
	status: varchar({ length: 20 }).default('active').notNull(),
	price: integer(),
}, (table) => [
	index("idx_products_category_sort").using("btree", table.categoryId.asc().nullsLast().op("int4_ops"), table.sortOrder.asc().nullsLast().op("uuid_ops")),
	index("idx_products_voltage_capacity").using("btree", table.voltageV.asc().nullsLast().op("int4_ops"), table.capacityAh.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [productCategories.id],
			name: "products_category_id_fkey"
		}).onDelete("restrict"),
	unique("uq_products_cat_voltage_capacity").on(table.categoryId, table.voltageV, table.capacityAh),
	unique("products_sku_key").on(table.sku),
]);

export const facilitationPayments = pgTable("facilitation_payments", {
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
	razorpayQrExpiresAt: timestamp("razorpay_qr_expires_at", { withTimezone: true, mode: 'string' }),
	razorpayPaymentId: varchar("razorpay_payment_id", { length: 255 }),
	razorpayOrderId: varchar("razorpay_order_id", { length: 255 }),
	razorpayPaymentStatus: varchar("razorpay_payment_status", { length: 30 }),
	utrNumberManual: varchar("utr_number_manual", { length: 100 }),
	paymentScreenshotUrl: text("payment_screenshot_url"),
	facilitationFeeStatus: varchar("facilitation_fee_status", { length: 30 }).default('UNPAID').notNull(),
	paymentPaidAt: timestamp("payment_paid_at", { withTimezone: true, mode: 'string' }),
	paymentVerifiedAt: timestamp("payment_verified_at", { withTimezone: true, mode: 'string' }),
	paymentVerificationSource: varchar("payment_verification_source", { length: 30 }),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.leadId],
			foreignColumns: [leads.id],
			name: "facilitation_payments_lead_id_fkey"
		}).onDelete("cascade"),
]);
export const pgStatStatementsInfo = pgView("pg_stat_statements_info", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dealloc: bigint({ mode: "number" }),
	statsReset: timestamp("stats_reset", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT dealloc, stats_reset FROM pg_stat_statements_info() pg_stat_statements_info(dealloc, stats_reset)`);

export const pgStatStatements = pgView("pg_stat_statements", {	// TODO: failed to parse database type 'oid'
	userid: unknown("userid"),
	// TODO: failed to parse database type 'oid'
	dbid: unknown("dbid"),
	toplevel: boolean(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	queryid: bigint({ mode: "number" }),
	query: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	plans: bigint({ mode: "number" }),
	totalPlanTime: doublePrecision("total_plan_time"),
	minPlanTime: doublePrecision("min_plan_time"),
	maxPlanTime: doublePrecision("max_plan_time"),
	meanPlanTime: doublePrecision("mean_plan_time"),
	stddevPlanTime: doublePrecision("stddev_plan_time"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	calls: bigint({ mode: "number" }),
	totalExecTime: doublePrecision("total_exec_time"),
	minExecTime: doublePrecision("min_exec_time"),
	maxExecTime: doublePrecision("max_exec_time"),
	meanExecTime: doublePrecision("mean_exec_time"),
	stddevExecTime: doublePrecision("stddev_exec_time"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rows: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sharedBlksHit: bigint("shared_blks_hit", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sharedBlksRead: bigint("shared_blks_read", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sharedBlksDirtied: bigint("shared_blks_dirtied", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sharedBlksWritten: bigint("shared_blks_written", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	localBlksHit: bigint("local_blks_hit", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	localBlksRead: bigint("local_blks_read", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	localBlksDirtied: bigint("local_blks_dirtied", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	localBlksWritten: bigint("local_blks_written", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tempBlksRead: bigint("temp_blks_read", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	tempBlksWritten: bigint("temp_blks_written", { mode: "number" }),
	sharedBlkReadTime: doublePrecision("shared_blk_read_time"),
	sharedBlkWriteTime: doublePrecision("shared_blk_write_time"),
	localBlkReadTime: doublePrecision("local_blk_read_time"),
	localBlkWriteTime: doublePrecision("local_blk_write_time"),
	tempBlkReadTime: doublePrecision("temp_blk_read_time"),
	tempBlkWriteTime: doublePrecision("temp_blk_write_time"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	walRecords: bigint("wal_records", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	walFpi: bigint("wal_fpi", { mode: "number" }),
	walBytes: numeric("wal_bytes"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jitFunctions: bigint("jit_functions", { mode: "number" }),
	jitGenerationTime: doublePrecision("jit_generation_time"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jitInliningCount: bigint("jit_inlining_count", { mode: "number" }),
	jitInliningTime: doublePrecision("jit_inlining_time"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jitOptimizationCount: bigint("jit_optimization_count", { mode: "number" }),
	jitOptimizationTime: doublePrecision("jit_optimization_time"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jitEmissionCount: bigint("jit_emission_count", { mode: "number" }),
	jitEmissionTime: doublePrecision("jit_emission_time"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jitDeformCount: bigint("jit_deform_count", { mode: "number" }),
	jitDeformTime: doublePrecision("jit_deform_time"),
	statsSince: timestamp("stats_since", { withTimezone: true, mode: 'string' }),
	minmaxStatsSince: timestamp("minmax_stats_since", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT userid, dbid, toplevel, queryid, query, plans, total_plan_time, min_plan_time, max_plan_time, mean_plan_time, stddev_plan_time, calls, total_exec_time, min_exec_time, max_exec_time, mean_exec_time, stddev_exec_time, rows, shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written, local_blks_hit, local_blks_read, local_blks_dirtied, local_blks_written, temp_blks_read, temp_blks_written, shared_blk_read_time, shared_blk_write_time, local_blk_read_time, local_blk_write_time, temp_blk_read_time, temp_blk_write_time, wal_records, wal_fpi, wal_bytes, jit_functions, jit_generation_time, jit_inlining_count, jit_inlining_time, jit_optimization_count, jit_optimization_time, jit_emission_count, jit_emission_time, jit_deform_count, jit_deform_time, stats_since, minmax_stats_since FROM pg_stat_statements(true) pg_stat_statements(userid, dbid, toplevel, queryid, query, plans, total_plan_time, min_plan_time, max_plan_time, mean_plan_time, stddev_plan_time, calls, total_exec_time, min_exec_time, max_exec_time, mean_exec_time, stddev_exec_time, rows, shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written, local_blks_hit, local_blks_read, local_blks_dirtied, local_blks_written, temp_blks_read, temp_blks_written, shared_blk_read_time, shared_blk_write_time, local_blk_read_time, local_blk_write_time, temp_blk_read_time, temp_blk_write_time, wal_records, wal_fpi, wal_bytes, jit_functions, jit_generation_time, jit_inlining_count, jit_inlining_time, jit_optimization_count, jit_optimization_time, jit_emission_count, jit_emission_time, jit_deform_count, jit_deform_time, stats_since, minmax_stats_since)`);

export const geographyColumns = pgView("geography_columns", {	// TODO: failed to parse database type 'name'
	fTableCatalog: unknown("f_table_catalog"),
	// TODO: failed to parse database type 'name'
	fTableSchema: unknown("f_table_schema"),
	// TODO: failed to parse database type 'name'
	fTableName: unknown("f_table_name"),
	// TODO: failed to parse database type 'name'
	fGeographyColumn: unknown("f_geography_column"),
	coordDimension: integer("coord_dimension"),
	srid: integer(),
	type: text(),
}).as(sql`SELECT current_database() AS f_table_catalog, n.nspname AS f_table_schema, c.relname AS f_table_name, a.attname AS f_geography_column, postgis_typmod_dims(a.atttypmod) AS coord_dimension, postgis_typmod_srid(a.atttypmod) AS srid, postgis_typmod_type(a.atttypmod) AS type FROM pg_class c, pg_attribute a, pg_type t, pg_namespace n WHERE t.typname = 'geography'::name AND a.attisdropped = false AND a.atttypid = t.oid AND a.attrelid = c.oid AND c.relnamespace = n.oid AND (c.relkind = ANY (ARRAY['r'::"char", 'v'::"char", 'm'::"char", 'f'::"char", 'p'::"char"])) AND NOT pg_is_other_temp_schema(c.relnamespace) AND has_table_privilege(c.oid, 'SELECT'::text)`);

export const geometryColumns = pgView("geometry_columns", {	fTableCatalog: varchar("f_table_catalog", { length: 256 }),
	// TODO: failed to parse database type 'name'
	fTableSchema: unknown("f_table_schema"),
	// TODO: failed to parse database type 'name'
	fTableName: unknown("f_table_name"),
	// TODO: failed to parse database type 'name'
	fGeometryColumn: unknown("f_geometry_column"),
	coordDimension: integer("coord_dimension"),
	srid: integer(),
	type: varchar({ length: 30 }),
}).as(sql`SELECT current_database()::character varying(256) AS f_table_catalog, n.nspname AS f_table_schema, c.relname AS f_table_name, a.attname AS f_geometry_column, COALESCE(postgis_typmod_dims(a.atttypmod), sn.ndims, 2) AS coord_dimension, COALESCE(NULLIF(postgis_typmod_srid(a.atttypmod), 0), sr.srid, 0) AS srid, replace(replace(COALESCE(NULLIF(upper(postgis_typmod_type(a.atttypmod)), 'GEOMETRY'::text), st.type, 'GEOMETRY'::text), 'ZM'::text, ''::text), 'Z'::text, ''::text)::character varying(30) AS type FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND NOT a.attisdropped JOIN pg_namespace n ON c.relnamespace = n.oid JOIN pg_type t ON a.atttypid = t.oid LEFT JOIN ( SELECT s.connamespace, s.conrelid, s.conkey, replace(split_part(s.consrc, ''''::text, 2), ')'::text, ''::text) AS type FROM ( SELECT pg_constraint.connamespace, pg_constraint.conrelid, pg_constraint.conkey, pg_get_constraintdef(pg_constraint.oid) AS consrc FROM pg_constraint) s WHERE s.consrc ~~* '%geometrytype(% = %'::text) st ON st.connamespace = n.oid AND st.conrelid = c.oid AND (a.attnum = ANY (st.conkey)) LEFT JOIN ( SELECT s.connamespace, s.conrelid, s.conkey, replace(split_part(s.consrc, ' = '::text, 2), ')'::text, ''::text)::integer AS ndims FROM ( SELECT pg_constraint.connamespace, pg_constraint.conrelid, pg_constraint.conkey, pg_get_constraintdef(pg_constraint.oid) AS consrc FROM pg_constraint) s WHERE s.consrc ~~* '%ndims(% = %'::text) sn ON sn.connamespace = n.oid AND sn.conrelid = c.oid AND (a.attnum = ANY (sn.conkey)) LEFT JOIN ( SELECT s.connamespace, s.conrelid, s.conkey, replace(replace(split_part(s.consrc, ' = '::text, 2), ')'::text, ''::text), '('::text, ''::text)::integer AS srid FROM ( SELECT pg_constraint.connamespace, pg_constraint.conrelid, pg_constraint.conkey, pg_get_constraintdef(pg_constraint.oid) AS consrc FROM pg_constraint) s WHERE s.consrc ~~* '%srid(% = %'::text) sr ON sr.connamespace = n.oid AND sr.conrelid = c.oid AND (a.attnum = ANY (sr.conkey)) WHERE (c.relkind = ANY (ARRAY['r'::"char", 'v'::"char", 'm'::"char", 'f'::"char", 'p'::"char"])) AND NOT c.relname = 'raster_columns'::name AND t.typname = 'geometry'::name AND NOT pg_is_other_temp_schema(c.relnamespace) AND has_table_privilege(c.oid, 'SELECT'::text)`);