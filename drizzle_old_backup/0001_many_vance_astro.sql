CREATE TABLE "accounts" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"business_name" text NOT NULL,
	"owner_name" text NOT NULL,
	"email" text,
	"phone" varchar(20),
	"gstin" varchar(15),
	"billing_address" text,
	"shipping_address" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_order_fulfilled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_kyc_reviews" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"review_for" varchar(20) DEFAULT 'primary' NOT NULL,
	"document_id" varchar(255),
	"document_type" varchar(50),
	"outcome" varchar(20) NOT NULL,
	"rejection_reason" text,
	"additional_doc_requested" text,
	"reviewer_id" uuid NOT NULL,
	"reviewer_notes" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"call_id" varchar(255) NOT NULL,
	"agent_id" varchar(255),
	"phone_number" varchar(20),
	"transcript" text,
	"summary" text,
	"recording_url" text,
	"call_duration" integer,
	"status" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_call_logs_call_id_unique" UNIQUE("call_id")
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "assignment_change_logs" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"change_type" varchar(50) NOT NULL,
	"old_user_id" uuid,
	"new_user_id" uuid,
	"changed_by" uuid NOT NULL,
	"change_reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battery_alerts" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"alert_type" varchar(50) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"message" text,
	"value" numeric(10, 2),
	"threshold" numeric(10, 2),
	"acknowledged" boolean DEFAULT false,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bolna_calls" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"bolna_call_id" varchar(255) NOT NULL,
	"lead_id" varchar(255),
	"status" varchar(20) DEFAULT 'initiated' NOT NULL,
	"current_phase" varchar(100),
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"transcript_chunk" text,
	"chunk_received_at" timestamp with time zone,
	"full_transcript" text,
	"transcript_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bolna_calls_bolna_call_id_unique" UNIQUE("bolna_call_id")
);
--> statement-breakpoint
CREATE TABLE "call_records" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"session_id" text,
	"lead_id" varchar(255),
	"bolna_call_id" varchar(255),
	"status" text DEFAULT 'queued',
	"duration_seconds" integer,
	"recording_url" text,
	"summary" text,
	"transcript" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"ended_at" timestamp with time zone,
	CONSTRAINT "call_records_bolna_call_id_unique" UNIQUE("bolna_call_id")
);
--> statement-breakpoint
CREATE TABLE "call_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text,
	"status" text DEFAULT 'active',
	"created_at" timestamp with time zone DEFAULT now(),
	"ended_at" timestamp with time zone,
	CONSTRAINT "call_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_segments" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"dealer_id" varchar(255),
	"is_prebuilt" boolean DEFAULT false,
	"filter_criteria" jsonb NOT NULL,
	"estimated_audience" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"audience_filter" jsonb,
	"message_content" text,
	"total_audience" integer,
	"cost" numeric(10, 2),
	"created_by" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "co_borrower_documents" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"co_borrower_id" varchar(255) NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"doc_type" varchar(50) NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text,
	"file_size" integer,
	"verification_status" varchar(30) DEFAULT 'pending' NOT NULL,
	"failed_reason" text,
	"ocr_data" jsonb,
	"api_response" jsonb,
	"verified_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "co_borrowers" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"full_name" text NOT NULL,
	"father_or_husband_name" text,
	"dob" timestamp with time zone,
	"phone" varchar(20) NOT NULL,
	"permanent_address" text,
	"current_address" text,
	"is_current_same" boolean DEFAULT false,
	"pan_no" varchar(20),
	"aadhaar_no" varchar(20),
	"auto_filled" boolean DEFAULT false,
	"kyc_status" varchar(30) DEFAULT 'not_started',
	"consent_status" varchar(30) DEFAULT 'awaiting_signature',
	"verification_submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"consent_for" varchar(20) DEFAULT 'primary' NOT NULL,
	"consent_type" varchar(30),
	"consent_status" varchar(30) DEFAULT 'awaiting_signature' NOT NULL,
	"consent_token" varchar(255),
	"consent_link_url" text,
	"consent_link_sent_at" timestamp with time zone,
	"signed_consent_url" text,
	"generated_pdf_url" text,
	"signed_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_record_id" varchar(255),
	"role" text,
	"message" text,
	"timestamp" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "coupon_codes" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"code" varchar(20) NOT NULL,
	"dealer_id" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"credits_available" integer DEFAULT 1,
	"discount_type" varchar(20) DEFAULT 'flat',
	"discount_value" numeric(10, 2) DEFAULT '0',
	"max_discount_cap" numeric(10, 2),
	"min_amount" numeric(10, 2),
	"used_by_lead_id" varchar(255),
	"used_by" uuid,
	"validated_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "dealer_agreement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"provider_document_id" text,
	"request_id" text,
	"event_type" varchar(100) NOT NULL,
	"signer_role" varchar(50),
	"event_status" varchar(50),
	"event_payload" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dealer_agreement_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"provider_document_id" text,
	"request_id" text,
	"signer_role" varchar(50) NOT NULL,
	"signer_name" text NOT NULL,
	"signer_email" text,
	"signer_mobile" text,
	"signing_method" varchar(50),
	"provider_signer_identifier" text,
	"provider_signing_url" text,
	"signer_status" varchar(50) DEFAULT 'pending' NOT NULL,
	"signed_at" timestamp,
	"last_event_at" timestamp,
	"provider_raw_response" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dealer_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"document_type" varchar(50),
	"file_name" text,
	"mime_type" varchar(100),
	"file_size" integer,
	"s3_key" text,
	"s3_url" text,
	"verification_status" varchar(30) DEFAULT 'uploaded',
	"extracted_data" jsonb,
	"remarks" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dealer_onboarding_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supabase_user_id" text,
	"company_name" text NOT NULL,
	"company_type" varchar(50),
	"gst_number" varchar(20),
	"pan_number" varchar(20),
	"business_address" jsonb,
	"finance_enabled" boolean DEFAULT false,
	"onboarding_status" varchar(30) DEFAULT 'draft',
	"review_status" varchar(30) DEFAULT 'pending_admin_review',
	"submitted_at" timestamp,
	"approved_at" timestamp,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"admin_notes" text,
	"owner_name" text,
	"owner_phone" varchar(20),
	"owner_email" text,
	"bank_name" text,
	"account_number" varchar(30),
	"ifsc_code" varchar(20),
	"beneficiary_name" text,
	"agreement_status" varchar(40),
	"provider_document_id" text,
	"provider_request_id" text,
	"provider_signing_url" text,
	"provider_raw_response" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dealer_onboarding_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"document_type" varchar(100) NOT NULL,
	"bucket_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"file_name" text NOT NULL,
	"file_url" text,
	"mime_type" varchar(100),
	"file_size" bigint,
	"uploaded_by" uuid,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"doc_status" varchar(30) DEFAULT 'uploaded' NOT NULL,
	"verification_status" varchar(30) DEFAULT 'pending',
	"verified_at" timestamp,
	"verified_by" uuid,
	"rejection_reason" text,
	"extracted_data" jsonb DEFAULT '{}'::jsonb,
	"api_verification_results" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dealer_subscriptions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"dealer_id" varchar(255) NOT NULL,
	"plan_name" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"features" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployed_assets" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"inventory_id" varchar(255) NOT NULL,
	"lead_id" varchar(255),
	"deal_id" varchar(255),
	"dealer_id" varchar(255),
	"customer_name" text,
	"customer_phone" varchar(20),
	"serial_number" varchar(255),
	"asset_category" varchar(20),
	"asset_type" varchar(50),
	"model_type" text,
	"deployment_date" timestamp with time zone NOT NULL,
	"deployment_location" text,
	"latitude" numeric(10, 8),
	"longitude" numeric(11, 8),
	"qr_code_url" text,
	"qr_code_data" text,
	"payment_type" varchar(20),
	"payment_status" varchar(20) DEFAULT 'pending',
	"battery_health_percent" numeric(5, 2),
	"last_voltage" numeric(5, 2),
	"last_soc" integer,
	"last_telemetry_at" timestamp with time zone,
	"telemetry_data" jsonb,
	"total_cycles" integer,
	"warranty_start_date" timestamp with time zone,
	"warranty_end_date" timestamp with time zone,
	"warranty_status" varchar(20) DEFAULT 'active',
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_maintenance_at" timestamp with time zone,
	"next_maintenance_due" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_history" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"deployed_asset_id" varchar(255) NOT NULL,
	"action" varchar(50) NOT NULL,
	"description" text,
	"performed_by" uuid NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_battery_map" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"battery_serial" varchar(100),
	"vehicle_number" varchar(50),
	"vehicle_type" varchar(50),
	"customer_name" text,
	"customer_phone" varchar(20),
	"dealer_id" varchar(255),
	"status" varchar(20) DEFAULT 'active',
	"installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" varchar(255),
	"document_type" varchar(50) NOT NULL,
	"file_url" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facilitation_payments" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"payment_method" varchar(30),
	"facilitation_fee_base_amount" numeric(10, 2) DEFAULT '1500.00' NOT NULL,
	"coupon_code" varchar(50),
	"coupon_id" varchar(255),
	"coupon_discount_type" varchar(20),
	"coupon_discount_value" numeric(10, 2),
	"coupon_discount_amount" numeric(10, 2) DEFAULT '0',
	"facilitation_fee_final_amount" numeric(10, 2) NOT NULL,
	"razorpay_qr_id" varchar(255),
	"razorpay_qr_status" varchar(30),
	"razorpay_qr_image_url" text,
	"razorpay_qr_short_url" text,
	"razorpay_qr_expires_at" timestamp with time zone,
	"razorpay_payment_id" varchar(255),
	"razorpay_order_id" varchar(255),
	"razorpay_payment_status" varchar(30),
	"utr_number_manual" varchar(100),
	"payment_screenshot_url" text,
	"facilitation_fee_status" varchar(30) DEFAULT 'UNPAID' NOT NULL,
	"payment_paid_at" timestamp with time zone,
	"payment_verified_at" timestamp with time zone,
	"payment_verification_source" varchar(30),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_documents" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"doc_type" varchar(50) NOT NULL,
	"file_url" text,
	"file_name" text,
	"file_size" integer,
	"verification_status" varchar(30) DEFAULT 'pending' NOT NULL,
	"failed_reason" text,
	"ocr_data" jsonb,
	"api_response" jsonb,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_verifications" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"verification_type" varchar(50) NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"api_provider" varchar(50),
	"api_request" jsonb,
	"api_response" jsonb,
	"failed_reason" text,
	"match_score" numeric(5, 2),
	"retry_count" integer DEFAULT 0,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_documents" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255),
	"dealer_id" varchar(255),
	"user_id" uuid,
	"doc_type" varchar(100) NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_applications" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"applicant_name" text,
	"loan_amount" numeric(12, 2),
	"documents_uploaded" boolean DEFAULT false,
	"company_validation_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"facilitation_fee_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"application_status" varchar(20) DEFAULT 'new' NOT NULL,
	"facilitation_fee_amount" numeric(10, 2),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" varchar(255),
	"loan_required" boolean DEFAULT false,
	"loan_amount" numeric(12, 2),
	"interest_rate" numeric(5, 2),
	"tenure_months" integer,
	"processing_fee" numeric(10, 2),
	"emi" numeric(10, 2),
	"down_payment" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_files" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"loan_application_id" varchar(255),
	"dealer_id" varchar(255),
	"borrower_name" text NOT NULL,
	"co_borrower_name" text,
	"loan_amount" numeric(12, 2) NOT NULL,
	"interest_rate" numeric(5, 2),
	"tenure_months" integer,
	"emi_amount" numeric(10, 2),
	"down_payment" numeric(12, 2),
	"processing_fee" numeric(10, 2),
	"disbursal_status" varchar(30) DEFAULT 'pending' NOT NULL,
	"disbursed_amount" numeric(12, 2),
	"disbursed_at" timestamp with time zone,
	"disbursal_reference" text,
	"total_paid" numeric(12, 2) DEFAULT '0',
	"total_outstanding" numeric(12, 2),
	"next_emi_date" timestamp with time zone,
	"emi_schedule" jsonb,
	"overdue_amount" numeric(12, 2) DEFAULT '0',
	"overdue_days" integer DEFAULT 0,
	"loan_status" varchar(30) DEFAULT 'active' NOT NULL,
	"closure_date" timestamp with time zone,
	"closure_type" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_offers" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"financier_name" text NOT NULL,
	"loan_amount" numeric(12, 2) NOT NULL,
	"interest_rate" numeric(5, 2) NOT NULL,
	"tenure_months" integer NOT NULL,
	"emi" numeric(10, 2) NOT NULL,
	"processing_fee" numeric(10, 2),
	"notes" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_payments" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"loan_file_id" varchar(255) NOT NULL,
	"payment_type" varchar(20) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"payment_mode" varchar(30),
	"transaction_id" text,
	"payment_date" timestamp with time zone NOT NULL,
	"emi_month" integer,
	"status" varchar(20) DEFAULT 'completed' NOT NULL,
	"receipt_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_disputes" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"order_id" varchar(255) NOT NULL,
	"dispute_type" varchar(50) NOT NULL,
	"description" text NOT NULL,
	"photos_urls" jsonb,
	"assigned_to" uuid NOT NULL,
	"resolution_status" varchar(50) DEFAULT 'open' NOT NULL,
	"resolution_details" text,
	"action_taken" text,
	"resolved_by" uuid,
	"resolved_at" timestamp,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "other_document_requests" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"lead_id" varchar(255) NOT NULL,
	"doc_for" varchar(20) DEFAULT 'primary' NOT NULL,
	"doc_label" text NOT NULL,
	"doc_key" varchar(100) NOT NULL,
	"is_required" boolean DEFAULT true,
	"file_url" text,
	"upload_status" varchar(20) DEFAULT 'not_uploaded' NOT NULL,
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"requested_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone,
	"upload_token" varchar(255),
	"token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" varchar(255),
	"aadhaar_no" varchar(20),
	"pan_no" varchar(20),
	"dob" timestamp with time zone,
	"email" text,
	"income" numeric(12, 2),
	"finance_type" varchar(50),
	"financier" varchar(100),
	"asset_type" varchar(50),
	"vehicle_rc" varchar(50),
	"loan_type" varchar(100),
	"father_husband_name" text,
	"marital_status" varchar(20),
	"spouse_name" text,
	"local_address" text,
	"dob_confidence" numeric(5, 2),
	"name_confidence" numeric(5, 2),
	"address_confidence" numeric(5, 2),
	"ocr_processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_categories_name_unique" UNIQUE("name"),
	CONSTRAINT "product_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"voltage_v" integer,
	"capacity_ah" integer,
	"sku" text NOT NULL,
	"hsn_code" varchar(8),
	"asset_type" varchar(50),
	"is_serialized" boolean DEFAULT true NOT NULL,
	"warranty_months" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "scraped_dealer_leads" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"scraper_run_id" varchar(255) NOT NULL,
	"dealer_name" text NOT NULL,
	"phone" varchar(20),
	"location_city" varchar(100),
	"location_state" varchar(100),
	"source_url" text,
	"raw_data" jsonb,
	"email" varchar(255),
	"gst_number" varchar(20),
	"business_type" varchar(50),
	"products_sold" text,
	"website" text,
	"quality_score" integer,
	"phone_valid" boolean,
	"assigned_to" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone,
	"exploration_status" varchar(30) DEFAULT 'unassigned' NOT NULL,
	"exploration_notes" text,
	"explored_at" timestamp with time zone,
	"converted_lead_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraper_dedup_logs" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"scraper_run_id" varchar(255) NOT NULL,
	"raw_dealer_name" text,
	"raw_phone" varchar(20),
	"raw_location" text,
	"raw_source_url" text,
	"skip_reason" varchar(50) NOT NULL,
	"matched_lead_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraper_runs" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"triggered_by" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"search_queries" jsonb,
	"total_found" integer DEFAULT 0,
	"new_leads_saved" integer DEFAULT 0,
	"duplicates_skipped" integer DEFAULT 0,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraper_schedules" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"frequency" varchar(20) NOT NULL,
	"day_of_week" integer,
	"time_of_day" varchar(5) DEFAULT '03:00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraper_search_queries" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"query_text" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_tickets" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"deployed_asset_id" varchar(255),
	"dealer_id" varchar(255) NOT NULL,
	"customer_name" text,
	"customer_phone" varchar(20),
	"issue_type" varchar(50) NOT NULL,
	"issue_description" text NOT NULL,
	"priority" varchar(20) DEFAULT 'medium' NOT NULL,
	"photos_urls" jsonb,
	"assigned_to" uuid,
	"assigned_at" timestamp with time zone,
	"status" varchar(30) DEFAULT 'open' NOT NULL,
	"resolution_type" varchar(50),
	"resolution_notes" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"sla_deadline" timestamp with time zone,
	"sla_breached" boolean DEFAULT false,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_catalog" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "product_catalog" CASCADE;--> statement-breakpoint
ALTER TABLE "inventory" DROP CONSTRAINT "inventory_product_id_product_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory" DROP CONSTRAINT "inventory_uploaded_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "oem_contacts" DROP CONSTRAINT "oem_contacts_oem_id_oems_id_fk";
--> statement-breakpoint
ALTER TABLE "oem_inventory_for_pdi" DROP CONSTRAINT "oem_inventory_for_pdi_product_id_product_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "decision_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "transportation_cost" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "transportation_cost" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "deal_status" SET DEFAULT 'pending_approval_l1';--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ALTER COLUMN "product_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "inventory" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ALTER COLUMN "quantity" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "inventory" ALTER COLUMN "quantity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ALTER COLUMN "gst_percent" SET DATA TYPE numeric(5, 2);--> statement-breakpoint
ALTER TABLE "inventory" ALTER COLUMN "status" SET DEFAULT 'in_transit';--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "state" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "city" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "interest_level" SET DEFAULT 'cold';--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "uploader_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "uploader_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "qualified_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oems" ALTER COLUMN "bank_proof_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_amount" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_amount" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "expected_delivery_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "expected_delivery_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "actual_delivery_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "grn_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pdi_records" ALTER COLUMN "latitude" SET DATA TYPE numeric(10, 8);--> statement-breakpoint
ALTER TABLE "pdi_records" ALTER COLUMN "longitude" SET DATA TYPE numeric(11, 8);--> statement-breakpoint
ALTER TABLE "pdi_records" ALTER COLUMN "inspected_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pdi_records" ALTER COLUMN "inspected_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "provisions" ALTER COLUMN "expected_delivery_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "comments" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "invoice_url" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "invoice_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "expired_by" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "expiry_reason" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "oem_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "asset_category" text NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "asset_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "model_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "batch_number" varchar(255);--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "manufacturing_date" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "expiry_date" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "oem_invoice_number" text NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "oem_invoice_date" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "oem_invoice_url" text;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "product_manual_url" text;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "warranty_document_url" text;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "warehouse_location" text;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "created_by" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD COLUMN "assigned_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD COLUMN "lead_actor" uuid;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD COLUMN "actor_assigned_by" uuid;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD COLUMN "actor_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "dealer_id" varchar(255);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "business_name" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_email" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "shop_address" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "mobile" varchar(20);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "permanent_address" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "vehicle_ownership" varchar(50);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "battery_type" varchar(50);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "asset_model" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "asset_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "family_members" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "driving_experience" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lead_type" varchar(20);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "vehicle_rc" varchar(50);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "father_or_husband_name" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "dob" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "phone" varchar(20);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "current_address" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "is_current_same" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "product_category_id" varchar(255);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "product_type_id" varchar(255);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "vehicle_owner_name" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "vehicle_owner_phone" varchar(20);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "auto_filled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ocr_status" varchar(20);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ocr_error" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "reference_id" varchar(255);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "battery_order_expected" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "investment_capacity" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "business_type" varchar(50);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "converted_deal_id" varchar(255);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "converted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "total_ai_calls" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_ai_call_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_call_outcome" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ai_priority_score" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "next_call_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "do_not_call" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ai_managed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ai_owner" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "manual_takeover" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_ai_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "intent_score" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "intent_reason" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "next_call_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "call_priority" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "conversation_summary" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_call_status" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status" varchar(50) DEFAULT 'INCOMPLETE' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "workflow_step" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "primary_product_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lead_score" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "kyc_status" varchar(30) DEFAULT 'not_started';--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "kyc_score" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "kyc_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "payment_method" varchar(20);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "consent_status" varchar(30) DEFAULT 'awaiting_signature';--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "has_co_borrower" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "has_additional_docs_required" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "interim_step_status" varchar(20);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "kyc_draft_data" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "sm_review_status" varchar(30) DEFAULT 'not_submitted';--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "submitted_to_sm_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "sm_assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN "inventory_id" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "oems" ADD COLUMN "pan" varchar(10);--> statement-breakpoint
ALTER TABLE "oems" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "oems" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "oems" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "oems" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "oems" ADD COLUMN "pincode" varchar(6);--> statement-breakpoint
ALTER TABLE "oems" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "oems" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "account_id" varchar(255);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "invoice_url" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "pdi_records" ADD COLUMN "capacity_ah" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "pdi_records" ADD COLUMN "resistance_mohm" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "pdi_records" ADD COLUMN "temperature_celsius" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "pdi_records" ADD COLUMN "location_address" text;--> statement-breakpoint
ALTER TABLE "pdi_records" ADD COLUMN "pdi_photos" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dealer_id" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_kyc_reviews" ADD CONSTRAINT "admin_kyc_reviews_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_kyc_reviews" ADD CONSTRAINT "admin_kyc_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_change_logs" ADD CONSTRAINT "assignment_change_logs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_change_logs" ADD CONSTRAINT "assignment_change_logs_old_user_id_users_id_fk" FOREIGN KEY ("old_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_change_logs" ADD CONSTRAINT "assignment_change_logs_new_user_id_users_id_fk" FOREIGN KEY ("new_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_change_logs" ADD CONSTRAINT "assignment_change_logs_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bolna_calls" ADD CONSTRAINT "bolna_calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_records" ADD CONSTRAINT "call_records_session_id_call_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."call_sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_records" ADD CONSTRAINT "call_records_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_segments" ADD CONSTRAINT "campaign_segments_dealer_id_accounts_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_segments" ADD CONSTRAINT "campaign_segments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "co_borrower_documents" ADD CONSTRAINT "co_borrower_documents_co_borrower_id_co_borrowers_id_fk" FOREIGN KEY ("co_borrower_id") REFERENCES "public"."co_borrowers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "co_borrower_documents" ADD CONSTRAINT "co_borrower_documents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "co_borrowers" ADD CONSTRAINT "co_borrowers_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_call_record_id_call_records_id_fk" FOREIGN KEY ("call_record_id") REFERENCES "public"."call_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_codes" ADD CONSTRAINT "coupon_codes_dealer_id_accounts_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_codes" ADD CONSTRAINT "coupon_codes_used_by_lead_id_leads_id_fk" FOREIGN KEY ("used_by_lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_codes" ADD CONSTRAINT "coupon_codes_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealer_agreement_events" ADD CONSTRAINT "dealer_agreement_events_application_id_dealer_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."dealer_onboarding_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealer_agreement_signers" ADD CONSTRAINT "dealer_agreement_signers_application_id_dealer_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."dealer_onboarding_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ADD CONSTRAINT "dealer_onboarding_documents_application_id_dealer_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."dealer_onboarding_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealer_subscriptions" ADD CONSTRAINT "dealer_subscriptions_dealer_id_accounts_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployed_assets" ADD CONSTRAINT "deployed_assets_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployed_assets" ADD CONSTRAINT "deployed_assets_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployed_assets" ADD CONSTRAINT "deployed_assets_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployed_assets" ADD CONSTRAINT "deployed_assets_dealer_id_accounts_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployed_assets" ADD CONSTRAINT "deployed_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_history" ADD CONSTRAINT "deployment_history_deployed_asset_id_deployed_assets_id_fk" FOREIGN KEY ("deployed_asset_id") REFERENCES "public"."deployed_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_history" ADD CONSTRAINT "deployment_history_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilitation_payments" ADD CONSTRAINT "facilitation_payments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilitation_payments" ADD CONSTRAINT "facilitation_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_documents" ADD CONSTRAINT "lead_documents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_documents" ADD CONSTRAINT "lead_documents_dealer_id_accounts_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_documents" ADD CONSTRAINT "lead_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_details" ADD CONSTRAINT "loan_details_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_files" ADD CONSTRAINT "loan_files_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_files" ADD CONSTRAINT "loan_files_loan_application_id_loan_applications_id_fk" FOREIGN KEY ("loan_application_id") REFERENCES "public"."loan_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_files" ADD CONSTRAINT "loan_files_dealer_id_accounts_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_offers" ADD CONSTRAINT "loan_offers_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_offers" ADD CONSTRAINT "loan_offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_payments" ADD CONSTRAINT "loan_payments_loan_file_id_loan_files_id_fk" FOREIGN KEY ("loan_file_id") REFERENCES "public"."loan_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_disputes" ADD CONSTRAINT "order_disputes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_document_requests" ADD CONSTRAINT "other_document_requests_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_document_requests" ADD CONSTRAINT "other_document_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_document_requests" ADD CONSTRAINT "other_document_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_details" ADD CONSTRAINT "personal_details_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraped_dealer_leads" ADD CONSTRAINT "scraped_dealer_leads_scraper_run_id_scraper_runs_id_fk" FOREIGN KEY ("scraper_run_id") REFERENCES "public"."scraper_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraped_dealer_leads" ADD CONSTRAINT "scraped_dealer_leads_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraped_dealer_leads" ADD CONSTRAINT "scraped_dealer_leads_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraped_dealer_leads" ADD CONSTRAINT "scraped_dealer_leads_converted_lead_id_leads_id_fk" FOREIGN KEY ("converted_lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_dedup_logs" ADD CONSTRAINT "scraper_dedup_logs_scraper_run_id_scraper_runs_id_fk" FOREIGN KEY ("scraper_run_id") REFERENCES "public"."scraper_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_runs" ADD CONSTRAINT "scraper_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_schedules" ADD CONSTRAINT "scraper_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_search_queries" ADD CONSTRAINT "scraper_search_queries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_deployed_asset_id_deployed_assets_id_fk" FOREIGN KEY ("deployed_asset_id") REFERENCES "public"."deployed_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_dealer_id_accounts_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_call_logs_lead_id_idx" ON "ai_call_logs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "ai_call_logs_call_id_idx" ON "ai_call_logs" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "bolna_calls_bolna_call_id_idx" ON "bolna_calls" USING btree ("bolna_call_id");--> statement-breakpoint
CREATE INDEX "bolna_calls_lead_id_idx" ON "bolna_calls" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "bolna_calls_status_idx" ON "bolna_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bolna_calls_started_at_idx" ON "bolna_calls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "co_borrowers_lead_id_idx" ON "co_borrowers" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "dealer_agreement_events_application_id_idx" ON "dealer_agreement_events" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "dealer_agreement_events_provider_document_id_idx" ON "dealer_agreement_events" USING btree ("provider_document_id");--> statement-breakpoint
CREATE INDEX "dealer_agreement_events_created_at_idx" ON "dealer_agreement_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "dealer_agreement_signers_application_id_idx" ON "dealer_agreement_signers" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "dealer_agreement_signers_provider_document_id_idx" ON "dealer_agreement_signers" USING btree ("provider_document_id");--> statement-breakpoint
CREATE INDEX "dealer_agreement_signers_signer_status_idx" ON "dealer_agreement_signers" USING btree ("signer_status");--> statement-breakpoint
CREATE INDEX "deployed_assets_dealer_id_idx" ON "deployed_assets" USING btree ("dealer_id");--> statement-breakpoint
CREATE INDEX "deployed_assets_status_idx" ON "deployed_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "facilitation_payments_lead_id_idx" ON "facilitation_payments" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "facilitation_payments_status_idx" ON "facilitation_payments" USING btree ("facilitation_fee_status");--> statement-breakpoint
CREATE INDEX "facilitation_payments_rzp_qr_idx" ON "facilitation_payments" USING btree ("razorpay_qr_id");--> statement-breakpoint
CREATE INDEX "kyc_documents_lead_id_idx" ON "kyc_documents" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "kyc_documents_doc_type_idx" ON "kyc_documents" USING btree ("doc_type");--> statement-breakpoint
CREATE INDEX "kyc_verifications_lead_id_idx" ON "kyc_verifications" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "kyc_verifications_type_idx" ON "kyc_verifications" USING btree ("verification_type");--> statement-breakpoint
CREATE INDEX "loan_files_dealer_id_idx" ON "loan_files" USING btree ("dealer_id");--> statement-breakpoint
CREATE INDEX "loan_files_loan_status_idx" ON "loan_files" USING btree ("loan_status");--> statement-breakpoint
CREATE INDEX "loan_offers_lead_id_idx" ON "loan_offers" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_products_category_sort" ON "products" USING btree ("category_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_products_voltage_capacity" ON "products" USING btree ("voltage_v","capacity_ah");--> statement-breakpoint
CREATE INDEX "sdl_phone_idx" ON "scraped_dealer_leads" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "sdl_name_city_idx" ON "scraped_dealer_leads" USING btree ("dealer_name","location_city");--> statement-breakpoint
CREATE INDEX "sdl_source_url_idx" ON "scraped_dealer_leads" USING btree ("source_url");--> statement-breakpoint
CREATE INDEX "sdl_run_idx" ON "scraped_dealer_leads" USING btree ("scraper_run_id");--> statement-breakpoint
CREATE INDEX "sdl_assigned_to_idx" ON "scraped_dealer_leads" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "sdl_status_idx" ON "scraped_dealer_leads" USING btree ("exploration_status");--> statement-breakpoint
CREATE INDEX "ddup_run_idx" ON "scraper_dedup_logs" USING btree ("scraper_run_id");--> statement-breakpoint
CREATE INDEX "scraper_runs_status_idx" ON "scraper_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scraper_runs_triggered_by_idx" ON "scraper_runs" USING btree ("triggered_by");--> statement-breakpoint
CREATE INDEX "sq_active_idx" ON "scraper_search_queries" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "service_tickets_dealer_id_idx" ON "service_tickets" USING btree ("dealer_id");--> statement-breakpoint
CREATE INDEX "service_tickets_status_idx" ON "service_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "service_tickets_asset_id_idx" ON "service_tickets" USING btree ("deployed_asset_id");--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_expired_by_users_id_fk" FOREIGN KEY ("expired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_actor_users_id_fk" FOREIGN KEY ("lead_actor") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_actor_assigned_by_users_id_fk" FOREIGN KEY ("actor_assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_dealer_id_accounts_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_primary_product_id_products_id_fk" FOREIGN KEY ("primary_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_sm_assigned_to_users_id_fk" FOREIGN KEY ("sm_assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oem_contacts" ADD CONSTRAINT "oem_contacts_oem_id_oems_id_fk" FOREIGN KEY ("oem_id") REFERENCES "public"."oems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oem_inventory_for_pdi" ADD CONSTRAINT "oem_inventory_for_pdi_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_source_idx" ON "leads" USING btree ("lead_source");--> statement-breakpoint
CREATE INDEX "leads_interest_idx" ON "leads" USING btree ("interest_level");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("lead_status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_payment_status_idx" ON "orders" USING btree ("payment_status");--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "iot_imei_no";--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "warranty_months";--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "invoice_number";--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "invoice_date";--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "challan_number";--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "challan_date";--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "uploaded_by";--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "uploaded_at";--> statement-breakpoint
ALTER TABLE "lead_assignments" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "oem_inventory_for_pdi" DROP COLUMN "product_id";--> statement-breakpoint
ALTER TABLE "oems" DROP COLUMN "cin";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "full_name";--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_serial_number_unique" UNIQUE("serial_number");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_reference_id_unique" UNIQUE("reference_id");