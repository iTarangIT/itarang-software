ALTER TABLE "dealer_onboarding_documents" DROP CONSTRAINT "dealer_onboarding_documents_application_id_dealer_onboarding_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "company_type" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "gst_number" SET DATA TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "onboarding_status" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "onboarding_status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "review_status" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "review_status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "account_number" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "agreement_status" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ALTER COLUMN "agreement_status" SET DEFAULT 'not_generated';--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "document_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "mime_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "file_size" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "uploaded_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "doc_status" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "doc_status" SET DEFAULT 'uploaded';--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "doc_status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "verification_status" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "verification_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "metadata" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "created_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" ALTER COLUMN "updated_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "dealer_user_id" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "dealer_code" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "registered_address" jsonb;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "sales_manager_name" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "sales_manager_email" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "sales_manager_mobile" varchar(20);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "itarang_signatory_1_name" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "itarang_signatory_1_email" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "itarang_signatory_1_mobile" varchar(20);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "itarang_signatory_2_name" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "itarang_signatory_2_email" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "itarang_signatory_2_mobile" varchar(20);--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "stamp_status" varchar(50) DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "completion_status" varchar(50) DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" ADD COLUMN "last_action_timestamp" timestamp;--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" DROP COLUMN "supabase_user_id";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" DROP COLUMN "approved_at";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" DROP COLUMN "rejected_at";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" DROP COLUMN "rejection_reason";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" DROP COLUMN "admin_notes";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_applications" DROP COLUMN "provider_request_id";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" DROP COLUMN "uploaded_at";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" DROP COLUMN "verified_at";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" DROP COLUMN "verified_by";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" DROP COLUMN "rejection_reason";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" DROP COLUMN "extracted_data";--> statement-breakpoint
ALTER TABLE "dealer_onboarding_documents" DROP COLUMN "api_verification_results";