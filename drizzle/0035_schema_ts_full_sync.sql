-- Comprehensive schema.ts → DB sync (idempotent, additive).
-- For every table in src/lib/db/schema.ts, adds any column that
-- isn't already on the target DB. Wrapped in a DO block per
-- table so missing tables don't break the script — re-runnable
-- safely against prod, sandbox, or any other env.
--
-- Strategy:
--   * NEVER drops or alters existing columns/types.
--   * Adds columns with safe defaults so NOT NULL on non-empty
--     tables doesn't violate existing rows.
--   * If the table doesn't exist (undefined_table 42P01), the
--     DO block silently skips that table.
-- Generated: 2026-04-25T09:58:55.250Z
-- Tables: 77

-- ── accounts (22 cols) ──
DO $do$
BEGIN
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "business_entity_name" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "gstin" varchar(15);
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "pan" varchar(20);
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "address_line1" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "address_line2" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "city" varchar(100);
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "state" varchar(100);
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "pincode" varchar(10);
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "bank_name" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "bank_account_number" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "ifsc_code" varchar(11);
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "bank_proof_url" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "dealer_code" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "contact_name" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "contact_email" text;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "contact_phone" varchar(20);
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active';
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "onboarding_status" varchar(30);
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "created_by" uuid;
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping accounts: table does not exist on this DB';
END;
$do$;

-- ── admin_kyc_reviews (12 cols) ──
DO $do$
BEGIN
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "review_for" varchar(20) DEFAULT 'primary' NOT NULL;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "document_id" varchar(255);
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "document_type" varchar(50);
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "outcome" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "additional_doc_requested" text;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "reviewer_id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "reviewer_notes" text;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "admin_kyc_reviews" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping admin_kyc_reviews: table does not exist on this DB';
END;
$do$;

-- ── admin_verification_queue (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "queue_type" varchar(50) DEFAULT 'kyc_verification' NOT NULL;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "lead_id" text DEFAULT '' NOT NULL;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "priority" varchar(20) DEFAULT 'normal' NOT NULL;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "assigned_to" uuid;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "submitted_by" uuid;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "status" varchar(50) DEFAULT 'pending_itarang_verification' NOT NULL;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "admin_verification_queue" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping admin_verification_queue: table does not exist on this DB';
END;
$do$;

-- ── after_sales_records (12 cols) ──
DO $do$
BEGIN
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "warranty_id" varchar(255);
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "battery_serial" varchar(255);
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "customer_id" varchar(255);
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "payment_mode" varchar(20);
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "opened_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active' NOT NULL;
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "after_sales_records" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping after_sales_records: table does not exist on this DB';
END;
$do$;

-- ── ai_call_logs (19 cols) ──
DO $do$
BEGIN
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "call_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "agent_id" varchar(255);
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "phone_number" varchar(20);
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "transcript" text;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "summary" text;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "recording_url" text;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "call_duration" integer;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "status" varchar(50);
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "provider" varchar(50);
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "model_used" varchar(100);
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "intent_score" integer;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "intent_reason" text;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "next_action" text;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping ai_call_logs: table does not exist on this DB';
END;
$do$;

-- ── app_settings (3 cols) ──
DO $do$
BEGIN
  ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "key" text DEFAULT '' NOT NULL;
  ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "value" jsonb DEFAULT '{}'::jsonb NOT NULL;
  ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping app_settings: table does not exist on this DB';
END;
$do$;

-- ── approvals (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "entity_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "entity_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "level" integer DEFAULT 0 NOT NULL;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "approver_role" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "approver_id" uuid;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "decision_at" timestamp with time zone;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "comments" text;
  ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping approvals: table does not exist on this DB';
END;
$do$;

-- ── assignment_change_logs (8 cols) ──
DO $do$
BEGIN
  ALTER TABLE "assignment_change_logs" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "assignment_change_logs" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "assignment_change_logs" ADD COLUMN IF NOT EXISTS "change_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "assignment_change_logs" ADD COLUMN IF NOT EXISTS "old_user_id" uuid;
  ALTER TABLE "assignment_change_logs" ADD COLUMN IF NOT EXISTS "new_user_id" uuid;
  ALTER TABLE "assignment_change_logs" ADD COLUMN IF NOT EXISTS "changed_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "assignment_change_logs" ADD COLUMN IF NOT EXISTS "change_reason" text;
  ALTER TABLE "assignment_change_logs" ADD COLUMN IF NOT EXISTS "changed_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping assignment_change_logs: table does not exist on this DB';
END;
$do$;

-- ── audit_logs (7 cols) ──
DO $do$
BEGIN
  ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "entity_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "entity_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "action" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "changes" jsonb;
  ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "performed_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "timestamp" timestamp DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping audit_logs: table does not exist on this DB';
END;
$do$;

-- ── battery_alerts (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "device_id" varchar(100) DEFAULT '' NOT NULL;
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "alert_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "severity" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "message" text;
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "value" numeric(10, 2);
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "threshold" numeric(10, 2);
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "acknowledged" boolean DEFAULT false;
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "acknowledged_by" text;
  ALTER TABLE "battery_alerts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping battery_alerts: table does not exist on this DB';
END;
$do$;

-- ── bolna_calls (13 cols) ──
DO $do$
BEGIN
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "bolna_call_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'initiated' NOT NULL;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "current_phase" varchar(100);
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "transcript_chunk" text;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "chunk_received_at" timestamp with time zone;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "full_transcript" text;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "transcript_fetched_at" timestamp with time zone;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "bolna_calls" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping bolna_calls: table does not exist on this DB';
END;
$do$;

-- ── call_records (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "session_id" text;
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "bolna_call_id" varchar(255);
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'queued';
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "duration_seconds" integer;
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "recording_url" text;
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "summary" text;
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "transcript" text;
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
  ALTER TABLE "call_records" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping call_records: table does not exist on this DB';
END;
$do$;

-- ── call_sessions (5 cols) ──
DO $do$
BEGIN
  ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "session_id" text;
  ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active';
  ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
  ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping call_sessions: table does not exist on this DB';
END;
$do$;

-- ── campaign_segments (10 cols) ──
DO $do$
BEGIN
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "name" text DEFAULT '' NOT NULL;
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "description" text;
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "is_prebuilt" boolean DEFAULT false;
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "filter_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL;
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "estimated_audience" integer;
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "created_by" uuid;
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "campaign_segments" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping campaign_segments: table does not exist on this DB';
END;
$do$;

-- ── campaigns (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "name" text DEFAULT '' NOT NULL;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'draft' NOT NULL;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "audience_filter" jsonb;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "message_content" text;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "total_audience" integer;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "cost" numeric(10, 2);
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
  ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping campaigns: table does not exist on this DB';
END;
$do$;

-- ── co_borrower_documents (13 cols) ──
DO $do$
BEGIN
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "co_borrower_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "document_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "document_url" text DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "file_name" text;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "file_size" integer;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "verification_status" varchar(30) DEFAULT 'pending';
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "status" varchar(30) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "ocr_data" jsonb;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "co_borrower_documents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping co_borrower_documents: table does not exist on this DB';
END;
$do$;

-- ── co_borrower_requests (8 cols) ──
DO $do$
BEGIN
  ALTER TABLE "co_borrower_requests" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrower_requests" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrower_requests" ADD COLUMN IF NOT EXISTS "attempt_number" integer DEFAULT 1 NOT NULL;
  ALTER TABLE "co_borrower_requests" ADD COLUMN IF NOT EXISTS "reason" text;
  ALTER TABLE "co_borrower_requests" ADD COLUMN IF NOT EXISTS "status" varchar(30) DEFAULT 'open' NOT NULL;
  ALTER TABLE "co_borrower_requests" ADD COLUMN IF NOT EXISTS "created_by" uuid;
  ALTER TABLE "co_borrower_requests" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "co_borrower_requests" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping co_borrower_requests: table does not exist on this DB';
END;
$do$;

-- ── co_borrowers (17 cols) ──
DO $do$
BEGIN
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "full_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "father_or_husband_name" text;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "dob" timestamp with time zone;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "phone" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "permanent_address" text;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "current_address" text;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "is_current_same" boolean DEFAULT false;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "pan_no" varchar(20);
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "aadhaar_no" varchar(20);
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "auto_filled" boolean DEFAULT false;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "kyc_status" varchar(30) DEFAULT 'not_started';
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "consent_status" varchar(30) DEFAULT 'awaiting_signature';
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "verification_submitted_at" timestamp with time zone;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "co_borrowers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping co_borrowers: table does not exist on this DB';
END;
$do$;

-- ── consent_records (22 cols) ──
DO $do$
BEGIN
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "consent_for" varchar(20) DEFAULT 'primary' NOT NULL;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "consent_type" varchar(30);
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "consent_status" varchar(30) DEFAULT 'awaiting_signature' NOT NULL;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "consent_token" varchar(255);
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "consent_link_url" text;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "consent_link_sent_at" timestamp with time zone;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "consent_delivery_channel" varchar(20);
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "esign_transaction_id" varchar(255);
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "signed_consent_url" text;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "generated_pdf_url" text;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "signed_at" timestamp with time zone;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "signer_aadhaar_masked" varchar(20);
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "esign_retry_count" integer DEFAULT 0;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "esign_error_message" text;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "verified_by" uuid;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "admin_viewed_by" uuid;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "admin_viewed_at" timestamp with time zone;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping consent_records: table does not exist on this DB';
END;
$do$;

-- ── conversation_messages (5 cols) ──
DO $do$
BEGIN
  ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "call_record_id" varchar(255);
  ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "role" text;
  ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "message" text;
  ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "timestamp" timestamp with time zone DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping conversation_messages: table does not exist on this DB';
END;
$do$;

-- ── coupon_audit_log (10 cols) ──
DO $do$
BEGIN
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "coupon_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "action" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "old_status" varchar(20);
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "new_status" varchar(20);
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "performed_by" uuid;
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "ip_address" varchar(45);
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "notes" text;
  ALTER TABLE "coupon_audit_log" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping coupon_audit_log: table does not exist on this DB';
END;
$do$;

-- ── coupon_batches (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "name" varchar(200) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "prefix" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "coupon_value" numeric(10, 2) DEFAULT '0' NOT NULL;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "total_quantity" integer DEFAULT 0 NOT NULL;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "expiry_date" timestamp with time zone;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active' NOT NULL;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "created_by" uuid;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "coupon_batches" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping coupon_batches: table does not exist on this DB';
END;
$do$;

-- ── coupon_codes (15 cols) ──
DO $do$
BEGIN
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "code" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'available' NOT NULL;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "credits_available" integer DEFAULT 1;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "discount_type" varchar(20) DEFAULT 'flat';
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "discount_value" numeric(10, 2) DEFAULT '0';
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "max_discount_cap" numeric(10, 2);
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "min_amount" numeric(10, 2);
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "used_by_lead_id" varchar(255);
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "used_by" uuid;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "validated_at" timestamp with time zone;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
  ALTER TABLE "coupon_codes" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping coupon_codes: table does not exist on this DB';
END;
$do$;

-- ── dealer_agreement_events (9 cols) ──
DO $do$
BEGIN
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "application_id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "provider_document_id" text;
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "request_id" text;
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "event_type" varchar(100) DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "signer_role" varchar(50);
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "event_status" varchar(50);
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "event_payload" jsonb;
  ALTER TABLE "dealer_agreement_events" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping dealer_agreement_events: table does not exist on this DB';
END;
$do$;

-- ── dealer_agreement_signers (17 cols) ──
DO $do$
BEGIN
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "application_id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "provider_document_id" text;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "request_id" text;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "signer_role" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "signer_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "signer_email" text;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "signer_mobile" text;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "signing_method" varchar(50);
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "provider_signer_identifier" text;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "provider_signing_url" text;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "signer_status" varchar(50) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "signed_at" timestamp;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "last_event_at" timestamp;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "provider_raw_response" jsonb;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
  ALTER TABLE "dealer_agreement_signers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping dealer_agreement_signers: table does not exist on this DB';
END;
$do$;

-- ── dealer_leads (18 cols) ──
DO $do$
BEGIN
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "id" text DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "dealer_id" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "dealer_name" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "phone" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "language" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "shop_name" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "location" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "follow_up_history" jsonb;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "current_status" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "total_attempts" integer;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "final_intent_score" integer;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "memory" jsonb;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "overall_summary" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "next_call_at" timestamp with time zone;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "assigned_to" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "approved_by" text;
  ALTER TABLE "dealer_leads" ADD COLUMN IF NOT EXISTS "rejected_by" text;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping dealer_leads: table does not exist on this DB';
END;
$do$;

-- ── dealer_onboarding_applications (56 cols) ──
DO $do$
BEGIN
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "dealer_user_id" uuid;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "company_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "company_type" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "gst_number" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "pan_number" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "cin_number" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "business_address" jsonb;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "registered_address" jsonb;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "finance_enabled" boolean DEFAULT false;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "onboarding_status" varchar(30) DEFAULT 'draft' NOT NULL;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "review_status" varchar(30) DEFAULT 'pending';
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "admin_notes" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "is_branch_dealer" boolean DEFAULT false NOT NULL;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "owner_name" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "owner_phone" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "owner_landline" varchar(20);
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "owner_email" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "sales_manager_name" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "sales_manager_email" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "sales_manager_mobile" varchar(20);
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "itarang_signatory_1_name" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "itarang_signatory_1_email" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "itarang_signatory_1_mobile" varchar(20);
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "itarang_signatory_2_name" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "itarang_signatory_2_email" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "itarang_signatory_2_mobile" varchar(20);
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "bank_name" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "account_number" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "beneficiary_name" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "ifsc_code" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "correction_remarks" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "rejection_remarks" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "dealer_account_status" varchar(30) DEFAULT 'inactive';
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "dealer_code" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "agreement_status" varchar(50);
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "agreement_language" varchar(30) DEFAULT 'english' NOT NULL;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "completion_status" varchar(30);
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "provider_document_id" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "request_id" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "provider_signing_url" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "provider_raw_response" jsonb;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "stamp_status" varchar(30);
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "stamp_certificate_ids" jsonb;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "last_action_timestamp" timestamp;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "signed_at" timestamp;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "signed_agreement_url" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "signed_agreement_storage_path" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "audit_trail_url" text;
  ALTER TABLE "dealer_onboarding_applications" ADD COLUMN IF NOT EXISTS "audit_trail_storage_path" text;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping dealer_onboarding_applications: table does not exist on this DB';
END;
$do$;

-- ── dealer_onboarding_documents (21 cols) ──
DO $do$
BEGIN
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "application_id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "document_type" varchar(100) DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "bucket_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "storage_path" text DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "file_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "file_url" text;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "mime_type" varchar(100);
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "file_size" bigint;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "uploaded_by" uuid;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "uploaded_at" timestamp DEFAULT now() NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "doc_status" varchar(30) DEFAULT 'uploaded' NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "verification_status" varchar(30) DEFAULT 'pending';
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "verified_at" timestamp;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "verified_by" uuid;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "extracted_data" jsonb;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "api_verification_results" jsonb;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
  ALTER TABLE "dealer_onboarding_documents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping dealer_onboarding_documents: table does not exist on this DB';
END;
$do$;

-- ── dealer_subscriptions (8 cols) ──
DO $do$
BEGIN
  ALTER TABLE "dealer_subscriptions" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_subscriptions" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_subscriptions" ADD COLUMN IF NOT EXISTS "plan_name" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "dealer_subscriptions" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active' NOT NULL;
  ALTER TABLE "dealer_subscriptions" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "dealer_subscriptions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
  ALTER TABLE "dealer_subscriptions" ADD COLUMN IF NOT EXISTS "features" jsonb;
  ALTER TABLE "dealer_subscriptions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping dealer_subscriptions: table does not exist on this DB';
END;
$do$;

-- ── deals (25 cols) ──
DO $do$
BEGIN
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "products" jsonb DEFAULT '{}'::jsonb NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "line_total" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "gst_amount" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "transportation_cost" numeric(10, 2) DEFAULT '0' NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "transportation_gst_percent" integer DEFAULT 18 NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "total_payable" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "payment_term" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "credit_period_months" integer;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "deal_status" varchar(50) DEFAULT 'pending_approval_l1' NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "is_immutable" boolean DEFAULT false NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "invoice_number" text;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "invoice_url" text;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "invoice_issued_at" timestamp with time zone;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "expired_by" uuid;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "expired_at" timestamp with time zone;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "expiry_reason" text;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "rejected_by" uuid;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp with time zone;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping deals: table does not exist on this DB';
END;
$do$;

-- ── deployed_assets (34 cols) ──
DO $do$
BEGIN
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "inventory_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "deal_id" varchar(255);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "customer_name" text;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "customer_phone" varchar(20);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "serial_number" varchar(255);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "asset_category" varchar(20);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "asset_type" varchar(50);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "model_type" text;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "deployment_date" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "deployment_location" text;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "latitude" numeric(10, 8);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "longitude" numeric(11, 8);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "qr_code_url" text;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "qr_code_data" text;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "payment_type" varchar(20);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "payment_status" varchar(20) DEFAULT 'pending';
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "battery_health_percent" numeric(5, 2);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "last_voltage" numeric(5, 2);
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "last_soc" integer;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "last_telemetry_at" timestamp with time zone;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "telemetry_data" jsonb;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "total_cycles" integer;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "warranty_start_date" timestamp with time zone;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "warranty_end_date" timestamp with time zone;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "warranty_status" varchar(20) DEFAULT 'active';
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active' NOT NULL;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "last_maintenance_at" timestamp with time zone;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "next_maintenance_due" timestamp with time zone;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "deployed_assets" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping deployed_assets: table does not exist on this DB';
END;
$do$;

-- ── deployment_history (7 cols) ──
DO $do$
BEGIN
  ALTER TABLE "deployment_history" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "deployment_history" ADD COLUMN IF NOT EXISTS "deployed_asset_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "deployment_history" ADD COLUMN IF NOT EXISTS "action" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "deployment_history" ADD COLUMN IF NOT EXISTS "description" text;
  ALTER TABLE "deployment_history" ADD COLUMN IF NOT EXISTS "performed_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "deployment_history" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
  ALTER TABLE "deployment_history" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping deployment_history: table does not exist on this DB';
END;
$do$;

-- ── device_battery_map (12 cols) ──
DO $do$
BEGIN
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "device_id" varchar(100) DEFAULT '' NOT NULL;
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "battery_serial" varchar(100);
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "vehicle_number" varchar(50);
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "vehicle_type" varchar(50);
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "customer_name" text;
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "customer_phone" varchar(20);
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active';
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "installed_at" timestamp with time zone;
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
  ALTER TABLE "device_battery_map" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping device_battery_map: table does not exist on this DB';
END;
$do$;

-- ── digilocker_transactions (26 cols) ──
DO $do$
BEGIN
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "verification_id" varchar(255);
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "reference_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "decentro_txn_id" varchar(255);
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "session_id" varchar(255);
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "status" varchar(30) DEFAULT 'initiated' NOT NULL;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "customer_phone" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "customer_email" varchar(255);
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "digilocker_url" text;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "short_url" text;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "notification_channel" varchar(10) DEFAULT 'sms' NOT NULL;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "link_sent_at" timestamp with time zone;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "link_opened_at" timestamp with time zone;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "customer_authorized_at" timestamp with time zone;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "digilocker_raw_response" jsonb;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "aadhaar_extracted_data" jsonb;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "cross_match_result" jsonb;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "aadhaar_pdf" bytea;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "sms_message_id" varchar(255);
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "sms_delivered_at" timestamp with time zone;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "sms_failed_reason" text;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "sms_attempts" integer DEFAULT 0 NOT NULL;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "digilocker_transactions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping digilocker_transactions: table does not exist on this DB';
END;
$do$;

-- ── documents (5 cols) ──
DO $do$
BEGIN
  ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "document_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "file_url" text DEFAULT '' NOT NULL;
  ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping documents: table does not exist on this DB';
END;
$do$;

-- ── facilitation_payments (27 cols) ──
DO $do$
BEGIN
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "payment_method" varchar(30);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "facilitation_fee_base_amount" numeric(10, 2) DEFAULT '1500.00' NOT NULL;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "coupon_code" varchar(50);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "coupon_id" varchar(255);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "coupon_discount_type" varchar(20);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "coupon_discount_value" numeric(10, 2);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "coupon_discount_amount" numeric(10, 2) DEFAULT '0';
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "facilitation_fee_final_amount" numeric(10, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "razorpay_qr_id" varchar(255);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "razorpay_qr_status" varchar(30);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "razorpay_qr_image_url" text;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "razorpay_qr_short_url" text;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "razorpay_qr_expires_at" timestamp with time zone;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "razorpay_payment_id" varchar(255);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "razorpay_order_id" varchar(255);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "razorpay_payment_status" varchar(30);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "utr_number_manual" varchar(100);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "payment_screenshot_url" text;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "facilitation_fee_status" varchar(30) DEFAULT 'UNPAID' NOT NULL;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "payment_paid_at" timestamp with time zone;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "payment_verified_at" timestamp with time zone;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "payment_verification_source" varchar(30);
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "created_by" uuid;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "facilitation_payments" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping facilitation_payments: table does not exist on this DB';
END;
$do$;

-- ── inventory (33 cols) ──
DO $do$
BEGIN
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "product_id" uuid;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "oem_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "oem_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "asset_category" text DEFAULT '' NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "asset_type" text DEFAULT '' NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "model_type" text DEFAULT '' NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "is_serialized" boolean DEFAULT true NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "serial_number" varchar(255);
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "batch_number" varchar(255);
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "iot_imei_no" varchar(255);
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "quantity" integer;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "manufacturing_date" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "expiry_date" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "inventory_amount" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "gst_percent" numeric(5, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "gst_amount" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "final_amount" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "oem_invoice_number" text DEFAULT '' NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "oem_invoice_date" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "oem_invoice_url" text;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "product_manual_url" text;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "warranty_document_url" text;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'in_transit' NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "warehouse_location" text;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "linked_lead_id" varchar(255);
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "dispatch_date" timestamp with time zone;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "soc_percent" numeric(5, 2);
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "soc_last_sync_at" timestamp with time zone;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping inventory: table does not exist on this DB';
END;
$do$;

-- ── kyc_data_audit (9 cols) ──
DO $do$
BEGIN
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "field_name" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "field_value" varchar(200);
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "data_source" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "entered_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "entered_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "reason" text;
  ALTER TABLE "kyc_data_audit" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping kyc_data_audit: table does not exist on this DB';
END;
$do$;

-- ── kyc_documents (14 cols) ──
DO $do$
BEGIN
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "doc_for" varchar(20) DEFAULT 'customer' NOT NULL;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "doc_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "file_url" text DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "file_name" text;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "file_size" integer;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "verification_status" varchar(30) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "failed_reason" text;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "ocr_data" jsonb;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "api_response" jsonb;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping kyc_documents: table does not exist on this DB';
END;
$do$;

-- ── kyc_verification_metadata (17 cols) ──
DO $do$
BEGIN
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "lead_id" text DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "submission_timestamp" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "case_type" varchar(20);
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "coupon_code" varchar(50);
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "coupon_status" varchar(20) DEFAULT 'reserved' NOT NULL;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "documents_count" integer DEFAULT 0 NOT NULL;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "consent_verified" boolean DEFAULT false NOT NULL;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "dealer_edits_locked" boolean DEFAULT false NOT NULL;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "verification_started_at" timestamp with time zone;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "first_api_execution_at" timestamp with time zone;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "first_api_type" varchar(50);
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "final_decision" varchar(30);
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "final_decision_at" timestamp with time zone;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "final_decision_by" uuid;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "final_decision_notes" text;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "kyc_verification_metadata" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping kyc_verification_metadata: table does not exist on this DB';
END;
$do$;

-- ── kyc_verifications (19 cols) ──
DO $do$
BEGIN
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "verification_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "applicant" varchar(20) DEFAULT 'primary' NOT NULL;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "status" varchar(30) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "api_provider" varchar(50);
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "api_request" jsonb;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "api_response" jsonb;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "failed_reason" text;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "match_score" numeric(5, 2);
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "admin_action" varchar(30);
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "admin_action_by" uuid;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "admin_action_at" timestamp with time zone;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "admin_action_notes" text;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "kyc_verifications" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping kyc_verifications: table does not exist on this DB';
END;
$do$;

-- ── lead_assignments (9 cols) ──
DO $do$
BEGIN
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "lead_owner" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "assigned_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "lead_actor" uuid;
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "actor_assigned_by" uuid;
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "actor_assigned_at" timestamp with time zone;
  ALTER TABLE "lead_assignments" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping lead_assignments: table does not exist on this DB';
END;
$do$;

-- ── lead_documents (7 cols) ──
DO $do$
BEGIN
  ALTER TABLE "lead_documents" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "lead_documents" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "lead_documents" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "lead_documents" ADD COLUMN IF NOT EXISTS "user_id" uuid;
  ALTER TABLE "lead_documents" ADD COLUMN IF NOT EXISTS "doc_type" varchar(100) DEFAULT '' NOT NULL;
  ALTER TABLE "lead_documents" ADD COLUMN IF NOT EXISTS "storage_path" text DEFAULT '' NOT NULL;
  ALTER TABLE "lead_documents" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping lead_documents: table does not exist on this DB';
END;
$do$;

-- ── leads (84 cols) ──
DO $do$
BEGIN
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "owner_name" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "owner_contact" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "full_name" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "phone" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "mobile" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "business_name" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "owner_email" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "state" varchar(100);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "city" varchar(100);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "shop_address" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "local_address" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "permanent_address" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "current_address" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "vehicle_rc" varchar(50);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "dob" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "father_or_husband_name" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "status" varchar(50);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "kyc_status" varchar(30);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "payment_method" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "consent_status" varchar(30);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_source" varchar(50);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_type" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_status" varchar(50);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_score" integer;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "interest_level" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "reference_id" varchar(255);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "uploader_id" uuid;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "vehicle_ownership" varchar(50);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "vehicle_owner_name" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "vehicle_owner_phone" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "battery_type" varchar(50);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "asset_model" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "asset_price" numeric(12, 2);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "family_members" integer;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "driving_experience" integer;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "is_current_same" boolean DEFAULT false;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "product_category_id" varchar(255);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "product_type_id" varchar(255);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "primary_product_id" uuid;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "interested_in" jsonb;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "battery_order_expected" integer;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "investment_capacity" numeric(12, 2);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "business_type" varchar(50);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "qualified_by" uuid;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "qualified_at" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "qualification_notes" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "converted_deal_id" varchar(255);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "converted_at" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "total_ai_calls" integer DEFAULT 0;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "last_ai_call_at" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "last_call_outcome" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "last_call_status" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "conversation_summary" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ai_priority_score" numeric(5, 2);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "next_call_after" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "next_call_at" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "do_not_call" boolean DEFAULT false;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ai_managed" boolean DEFAULT false;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ai_owner" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "manual_takeover" boolean DEFAULT false;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "last_ai_action_at" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "intent_score" integer;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "intent_reason" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "call_priority" integer DEFAULT 0;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "workflow_step" integer DEFAULT 1;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "auto_filled" boolean DEFAULT false;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ocr_status" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ocr_error" text;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "coupon_code" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "coupon_status" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "kyc_score" integer;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "kyc_completed_at" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "has_co_borrower" boolean DEFAULT false;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "has_additional_docs_required" boolean DEFAULT false;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "interim_step_status" varchar(20);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "kyc_draft_data" jsonb;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sm_review_status" varchar(30);
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "submitted_to_sm_at" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sm_assigned_to" uuid;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sold_at" timestamp with time zone;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping leads: table does not exist on this DB';
END;
$do$;

-- ── loan_applications (12 cols) ──
DO $do$
BEGIN
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "applicant_name" text;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "loan_amount" numeric(12, 2);
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "documents_uploaded" boolean DEFAULT false;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "company_validation_status" varchar(20) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "facilitation_fee_status" varchar(20) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "application_status" varchar(20) DEFAULT 'new' NOT NULL;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "facilitation_fee_amount" numeric(10, 2);
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "created_by" uuid;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "loan_applications" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping loan_applications: table does not exist on this DB';
END;
$do$;

-- ── loan_details (10 cols) ──
DO $do$
BEGIN
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "loan_required" boolean DEFAULT false;
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "loan_amount" numeric(12, 2);
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "interest_rate" numeric(5, 2);
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "tenure_months" integer;
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "processing_fee" numeric(10, 2);
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "emi" numeric(10, 2);
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "down_payment" numeric(12, 2);
  ALTER TABLE "loan_details" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping loan_details: table does not exist on this DB';
END;
$do$;

-- ── loan_files (27 cols) ──
DO $do$
BEGIN
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "loan_application_id" varchar(255);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "borrower_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "co_borrower_name" text;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "loan_amount" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "interest_rate" numeric(5, 2);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "tenure_months" integer;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "emi_amount" numeric(10, 2);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "down_payment" numeric(12, 2);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "processing_fee" numeric(10, 2);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "disbursal_status" varchar(30) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "disbursed_amount" numeric(12, 2);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "disbursed_at" timestamp with time zone;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "disbursal_reference" text;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "total_paid" numeric(12, 2) DEFAULT '0';
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "total_outstanding" numeric(12, 2);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "next_emi_date" timestamp with time zone;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "emi_schedule" jsonb;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "overdue_amount" numeric(12, 2) DEFAULT '0';
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "overdue_days" integer DEFAULT 0;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "loan_status" varchar(30) DEFAULT 'active' NOT NULL;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "closure_date" timestamp with time zone;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "closure_type" varchar(20);
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "loan_files" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping loan_files: table does not exist on this DB';
END;
$do$;

-- ── loan_offers (13 cols) ──
DO $do$
BEGIN
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "financier_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "loan_amount" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "interest_rate" numeric(5, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "tenure_months" integer DEFAULT 0 NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "emi" numeric(10, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "processing_fee" numeric(10, 2);
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "notes" text;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "loan_offers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping loan_offers: table does not exist on this DB';
END;
$do$;

-- ── loan_payments (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "loan_file_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "payment_type" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "amount" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "payment_mode" varchar(30);
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "transaction_id" text;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "payment_date" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "emi_month" integer;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'completed' NOT NULL;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "receipt_url" text;
  ALTER TABLE "loan_payments" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping loan_payments: table does not exist on this DB';
END;
$do$;

-- ── loan_sanctions (22 cols) ──
DO $do$
BEGIN
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "product_selection_id" varchar(255);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "loan_amount" numeric(12, 2);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "down_payment" numeric(12, 2);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "file_charge" numeric(12, 2);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "subvention" numeric(12, 2);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "disbursement_amount" numeric(12, 2);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "emi" numeric(12, 2);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "tenure_months" integer;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "roi" numeric(5, 2);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "loan_approved_by" text;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "loan_file_number" varchar(100);
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "status" varchar(30) DEFAULT 'sanctioned' NOT NULL;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "sanctioned_by" uuid;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "sanctioned_at" timestamp with time zone DEFAULT now();
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "dealer_approved" boolean DEFAULT false;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "dealer_approved_at" timestamp with time zone;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "dealer_approved_by" uuid;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping loan_sanctions: table does not exist on this DB';
END;
$do$;

-- ── notifications (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "id" text DEFAULT '' NOT NULL;
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "user_id" uuid;
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "lead_id" varchar(100);
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "title" text DEFAULT '' NOT NULL;
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "message" text DEFAULT '' NOT NULL;
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "data" jsonb;
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "read" boolean DEFAULT false;
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;
  ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping notifications: table does not exist on this DB';
END;
$do$;

-- ── oem_contacts (7 cols) ──
DO $do$
BEGIN
  ALTER TABLE "oem_contacts" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "oem_contacts" ADD COLUMN IF NOT EXISTS "oem_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "oem_contacts" ADD COLUMN IF NOT EXISTS "contact_role" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "oem_contacts" ADD COLUMN IF NOT EXISTS "contact_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "oem_contacts" ADD COLUMN IF NOT EXISTS "contact_phone" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "oem_contacts" ADD COLUMN IF NOT EXISTS "contact_email" text DEFAULT '' NOT NULL;
  ALTER TABLE "oem_contacts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping oem_contacts: table does not exist on this DB';
END;
$do$;

-- ── oem_inventory_for_pdi (8 cols) ──
DO $do$
BEGIN
  ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN IF NOT EXISTS "provision_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN IF NOT EXISTS "inventory_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN IF NOT EXISTS "serial_number" varchar(255);
  ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN IF NOT EXISTS "oem_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN IF NOT EXISTS "pdi_status" varchar(20) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN IF NOT EXISTS "pdi_record_id" varchar(255);
  ALTER TABLE "oem_inventory_for_pdi" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping oem_inventory_for_pdi: table does not exist on this DB';
END;
$do$;

-- ── oems (17 cols) ──
DO $do$
BEGIN
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "business_entity_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "gstin" varchar(15) DEFAULT '' NOT NULL;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "pan" varchar(10);
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "address_line1" text;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "address_line2" text;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "city" text;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "state" text;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "pincode" varchar(6);
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "bank_name" text;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "bank_account_number" text DEFAULT '' NOT NULL;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "ifsc_code" varchar(11) DEFAULT '' NOT NULL;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "bank_proof_url" text;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active' NOT NULL;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "created_by" uuid;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "oems" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping oems: table does not exist on this DB';
END;
$do$;

-- ── order_disputes (13 cols) ──
DO $do$
BEGIN
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "order_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "dispute_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "description" text DEFAULT '' NOT NULL;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "photos_urls" jsonb;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "assigned_to" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "resolution_status" varchar(50) DEFAULT 'open' NOT NULL;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "resolution_details" text;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "action_taken" text;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "resolved_by" uuid;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "order_disputes" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping order_disputes: table does not exist on this DB';
END;
$do$;

-- ── orders (26 cols) ──
DO $do$
BEGIN
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "provision_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "oem_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "account_id" varchar(255);
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "order_items" jsonb DEFAULT '{}'::jsonb NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "total_amount" numeric(12, 2) DEFAULT 0 NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_term" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "credit_period_days" integer;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pi_url" text;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pi_amount" numeric(12, 2);
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "invoice_url" text;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "grn_id" text;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "grn_date" timestamp with time zone;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_status" varchar(20) DEFAULT 'unpaid' NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_amount" numeric(12, 2) DEFAULT '0' NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_mode" varchar(50);
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "transaction_id" text;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_date" timestamp with time zone;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "order_status" varchar(50) DEFAULT 'pi_awaited' NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_status" varchar(20) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "expected_delivery_date" timestamp with time zone;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "actual_delivery_date" timestamp with time zone;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "reorder_tat_days" integer;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping orders: table does not exist on this DB';
END;
$do$;

-- ── other_document_requests (16 cols) ──
DO $do$
BEGIN
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "doc_for" varchar(20) DEFAULT 'primary' NOT NULL;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "doc_label" text DEFAULT '' NOT NULL;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "doc_key" varchar(100) DEFAULT '' NOT NULL;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "is_required" boolean DEFAULT true;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "file_url" text;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "upload_status" varchar(20) DEFAULT 'not_uploaded' NOT NULL;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "requested_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "uploaded_at" timestamp with time zone;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "upload_token" varchar(255);
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "token_expires_at" timestamp with time zone;
  ALTER TABLE "other_document_requests" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping other_document_requests: table does not exist on this DB';
END;
$do$;

-- ── otp_confirmations (16 cols) ──
DO $do$
BEGIN
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "otp_type" varchar(50) DEFAULT 'dispatch_confirmation' NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "otp_hash" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "phone_sent_to" varchar(20);
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "send_count" integer DEFAULT 1 NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "is_used" boolean DEFAULT false NOT NULL;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "used_by" uuid;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "override_by_admin" boolean DEFAULT false;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "override_reason" text;
  ALTER TABLE "otp_confirmations" ADD COLUMN IF NOT EXISTS "override_by" uuid;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping otp_confirmations: table does not exist on this DB';
END;
$do$;

-- ── pdi_records (23 cols) ──
DO $do$
BEGIN
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "oem_inventory_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "provision_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "service_engineer_id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "iot_imei_no" varchar(255);
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "physical_condition" text DEFAULT '' NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "discharging_connector" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "charging_connector" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "productor_sticker" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "voltage" numeric(5, 2);
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "soc" integer;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "capacity_ah" numeric(6, 2);
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "resistance_mohm" numeric(6, 2);
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "temperature_celsius" numeric(5, 2);
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "latitude" numeric(10, 8) DEFAULT 0 NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "longitude" numeric(11, 8) DEFAULT 0 NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "location_address" text;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "product_manual_url" text;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "warranty_document_url" text;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "pdi_photos" jsonb;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "pdi_status" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "failure_reason" text;
  ALTER TABLE "pdi_records" ADD COLUMN IF NOT EXISTS "inspected_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping pdi_records: table does not exist on this DB';
END;
$do$;

-- ── personal_details (25 cols) ──
DO $do$
BEGIN
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "aadhaar_no" varchar(20);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "pan_no" varchar(20);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "dob" timestamp with time zone;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "email" text;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "income" numeric(12, 2);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "finance_type" varchar(50);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "financier" varchar(100);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "asset_type" varchar(50);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "vehicle_rc" varchar(50);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "loan_type" varchar(100);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "father_husband_name" text;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "marital_status" varchar(20);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "spouse_name" text;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "local_address" text;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "bank_account_number" text;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "bank_ifsc" varchar(11);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "bank_name" text;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "bank_branch" text;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "dob_confidence" numeric(5, 2);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "name_confidence" numeric(5, 2);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "address_confidence" numeric(5, 2);
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "ocr_processed_at" timestamp with time zone;
  ALTER TABLE "personal_details" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping personal_details: table does not exist on this DB';
END;
$do$;

-- ── product_categories (6 cols) ──
DO $do$
BEGIN
  ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "name" text DEFAULT '' NOT NULL;
  ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "slug" text DEFAULT '' NOT NULL;
  ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
  ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "product_categories" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping product_categories: table does not exist on this DB';
END;
$do$;

-- ── product_selections (18 cols) ──
DO $do$
BEGIN
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "lead_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "battery_serial" varchar(255);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "charger_serial" varchar(255);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "paraphernalia" jsonb;
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "category" varchar(100);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "sub_category" varchar(100);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "battery_price" numeric(12, 2);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "charger_price" numeric(12, 2);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "paraphernalia_cost" numeric(12, 2);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "dealer_margin" numeric(12, 2);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "final_price" numeric(12, 2);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "payment_mode" varchar(20);
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "admin_decision" varchar(30) DEFAULT 'pending';
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "submitted_by" uuid;
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone DEFAULT now();
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping product_selections: table does not exist on this DB';
END;
$do$;

-- ── products (17 cols) ──
DO $do$
BEGIN
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "category_id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "name" text DEFAULT '' NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "slug" text DEFAULT '' NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "voltage_v" integer;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "capacity_ah" integer;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sku" text DEFAULT '' NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "hsn_code" varchar(8);
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "price" integer;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "asset_type" varchar(50);
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_serialized" boolean DEFAULT true NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "warranty_months" integer DEFAULT 0 NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active' NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping products: table does not exist on this DB';
END;
$do$;

-- ── provisions (10 cols) ──
DO $do$
BEGIN
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "oem_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "oem_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "products" jsonb DEFAULT '{}'::jsonb NOT NULL;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "expected_delivery_date" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'pending' NOT NULL;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "remarks" text;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "provisions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping provisions: table does not exist on this DB';
END;
$do$;

-- ── scraper_runs (15 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "id" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "status" text;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "triggered_by" text;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "started_at" timestamp DEFAULT now();
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "total_found" integer;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "new_leads_saved" integer;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "duplicates_skipped" integer;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "cleaned_leads" integer;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "duration_ms" integer;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "error_message" text;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "search_queries" json;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "total_chunks" integer DEFAULT 0;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "completed_chunks" integer DEFAULT 0;
  ALTER TABLE "scraper_runs" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_runs: table does not exist on this DB';
END;
$do$;

-- ── scraped_dealer_leads (24 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "scraper_run_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "dealer_name" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "phone" varchar(20);
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "location_city" varchar(100);
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "location_state" varchar(100);
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "source_url" text;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "email" varchar(255);
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "gst_number" varchar(20);
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "business_type" varchar(50);
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "products_sold" text;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "website" text;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "quality_score" integer;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "phone_valid" boolean;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "assigned_to" uuid;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "assigned_by" uuid;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "exploration_status" varchar(30) DEFAULT 'unassigned' NOT NULL;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "exploration_notes" text;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "explored_at" timestamp with time zone;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "converted_lead_id" varchar(255);
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "scraped_dealer_leads" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraped_dealer_leads: table does not exist on this DB';
END;
$do$;

-- ── scraper_city_queue (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "id" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "base_query" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "state" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "city" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "full_query" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending';
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "leads_found" integer DEFAULT 0;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "new_leads" integer DEFAULT 0;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "duplicates" integer DEFAULT 0;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "scraped_at" timestamp;
  ALTER TABLE "scraper_city_queue" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_city_queue: table does not exist on this DB';
END;
$do$;

-- ── scraper_dedup_logs (9 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "scraper_run_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "raw_dealer_name" text;
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "raw_phone" varchar(20);
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "raw_location" text;
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "raw_source_url" text;
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "skip_reason" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "matched_lead_id" varchar(255);
  ALTER TABLE "scraper_dedup_logs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_dedup_logs: table does not exist on this DB';
END;
$do$;

-- ── scraper_leads (10 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "id" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "name" text;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "phone" text;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "email" text;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "website" text;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "city" text;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "address" text;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "source" text;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "status" text;
  ALTER TABLE "scraper_leads" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_leads: table does not exist on this DB';
END;
$do$;

-- ── scraper_leads_duplicates (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "id" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "original_lead_id" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "name" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "phone" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "email" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "website" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "city" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "address" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "source" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "status" text;
  ALTER TABLE "scraper_leads_duplicates" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_leads_duplicates: table does not exist on this DB';
END;
$do$;

-- ── scraper_raw (4 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_raw" ADD COLUMN IF NOT EXISTS "id" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_raw" ADD COLUMN IF NOT EXISTS "run_id" text;
  ALTER TABLE "scraper_raw" ADD COLUMN IF NOT EXISTS "raw_data" text;
  ALTER TABLE "scraper_raw" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_raw: table does not exist on this DB';
END;
$do$;

-- ── scraper_run_chunks (8 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_run_chunks" ADD COLUMN IF NOT EXISTS "id" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_run_chunks" ADD COLUMN IF NOT EXISTS "run_id" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_run_chunks" ADD COLUMN IF NOT EXISTS "combination_query" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_run_chunks" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL;
  ALTER TABLE "scraper_run_chunks" ADD COLUMN IF NOT EXISTS "leads_count" integer DEFAULT 0;
  ALTER TABLE "scraper_run_chunks" ADD COLUMN IF NOT EXISTS "error_message" text;
  ALTER TABLE "scraper_run_chunks" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now();
  ALTER TABLE "scraper_run_chunks" ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_run_chunks: table does not exist on this DB';
END;
$do$;

-- ── scraper_schedules (9 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "frequency" varchar(20) DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "day_of_week" integer;
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "time_of_day" varchar(5) DEFAULT '03:00' NOT NULL;
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp with time zone;
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "scraper_schedules" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_schedules: table does not exist on this DB';
END;
$do$;

-- ── scraper_search_queries (6 cols) ──
DO $do$
BEGIN
  ALTER TABLE "scraper_search_queries" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_search_queries" ADD COLUMN IF NOT EXISTS "query_text" text DEFAULT '' NOT NULL;
  ALTER TABLE "scraper_search_queries" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
  ALTER TABLE "scraper_search_queries" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "scraper_search_queries" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "scraper_search_queries" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping scraper_search_queries: table does not exist on this DB';
END;
$do$;

-- ── service_tickets (21 cols) ──
DO $do$
BEGIN
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "deployed_asset_id" varchar(255);
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "customer_name" text;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "customer_phone" varchar(20);
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "issue_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "issue_description" text DEFAULT '' NOT NULL;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "priority" varchar(20) DEFAULT 'medium' NOT NULL;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "photos_urls" jsonb;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "assigned_to" uuid;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "status" varchar(30) DEFAULT 'open' NOT NULL;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "resolution_type" varchar(50);
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "resolution_notes" text;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "resolved_by" uuid;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "sla_deadline" timestamp with time zone;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "sla_breached" boolean DEFAULT false;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "created_by" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "service_tickets" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping service_tickets: table does not exist on this DB';
END;
$do$;

-- ── slas (11 cols) ──
DO $do$
BEGIN
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "workflow_step" varchar(100) DEFAULT '' NOT NULL;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "entity_type" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "entity_id" varchar(255) DEFAULT '' NOT NULL;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "assigned_to" uuid;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "sla_deadline" timestamp DEFAULT now() NOT NULL;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active' NOT NULL;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "escalated_to" uuid;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "escalated_at" timestamp;
  ALTER TABLE "slas" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping slas: table does not exist on this DB';
END;
$do$;

-- ── users (12 cols) ──
DO $do$
BEGIN
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text DEFAULT '' NOT NULL;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" text DEFAULT '' NOT NULL;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" varchar(50) DEFAULT '' NOT NULL;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dealer_id" varchar(255);
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" text;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping users: table does not exist on this DB';
END;
$do$;
