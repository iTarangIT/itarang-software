CREATE TABLE "dealer_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"dealer_name" text,
	"phone" text,
	"language" text,
	"shop_name" text,
	"location" text,
	"follow_up_history" jsonb,
	"current_status" text,
	"total_attempts" integer,
	"final_intent_score" integer,
	"memory" jsonb,
	"overall_summary" text,
	"created_at" timestamp DEFAULT now(),
	"next_call_at" timestamp with time zone,
	"assigned_to" text,
	"approved_by" text,
	"rejected_by" text,
	CONSTRAINT "dealer_leads_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "scraper_leads_duplicates" (
	"id" text PRIMARY KEY NOT NULL,
	"original_lead_id" text,
	"name" text,
	"phone" text,
	"email" text,
	"website" text,
	"city" text,
	"address" text,
	"source" text,
	"status" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "leads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "leads" CASCADE;--> statement-breakpoint
ALTER TABLE "admin_kyc_reviews" DROP CONSTRAINT "admin_kyc_reviews_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_call_logs" DROP CONSTRAINT "ai_call_logs_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "assignment_change_logs" DROP CONSTRAINT "assignment_change_logs_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "bolna_calls" DROP CONSTRAINT "bolna_calls_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "call_records" DROP CONSTRAINT "call_records_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "co_borrower_documents" DROP CONSTRAINT "co_borrower_documents_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "co_borrowers" DROP CONSTRAINT "co_borrowers_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "consent_records" DROP CONSTRAINT "consent_records_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "coupon_codes" DROP CONSTRAINT "coupon_codes_used_by_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT "deals_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "deployed_assets" DROP CONSTRAINT "deployed_assets_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "facilitation_payments" DROP CONSTRAINT "facilitation_payments_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "kyc_documents" DROP CONSTRAINT "kyc_documents_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "kyc_verifications" DROP CONSTRAINT "kyc_verifications_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_assignments" DROP CONSTRAINT "lead_assignments_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_documents" DROP CONSTRAINT "lead_documents_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "loan_applications" DROP CONSTRAINT "loan_applications_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "loan_details" DROP CONSTRAINT "loan_details_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "loan_files" DROP CONSTRAINT "loan_files_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "loan_offers" DROP CONSTRAINT "loan_offers_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "other_document_requests" DROP CONSTRAINT "other_document_requests_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "personal_details" DROP CONSTRAINT "personal_details_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "scraped_dealer_leads" DROP CONSTRAINT "scraped_dealer_leads_converted_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_kyc_reviews" ADD CONSTRAINT "admin_kyc_reviews_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_logs" ADD CONSTRAINT "ai_call_logs_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_change_logs" ADD CONSTRAINT "assignment_change_logs_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bolna_calls" ADD CONSTRAINT "bolna_calls_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_records" ADD CONSTRAINT "call_records_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "co_borrower_documents" ADD CONSTRAINT "co_borrower_documents_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "co_borrowers" ADD CONSTRAINT "co_borrowers_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_codes" ADD CONSTRAINT "coupon_codes_used_by_lead_id_dealer_leads_id_fk" FOREIGN KEY ("used_by_lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployed_assets" ADD CONSTRAINT "deployed_assets_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facilitation_payments" ADD CONSTRAINT "facilitation_payments_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_documents" ADD CONSTRAINT "lead_documents_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_details" ADD CONSTRAINT "loan_details_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_files" ADD CONSTRAINT "loan_files_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_offers" ADD CONSTRAINT "loan_offers_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_document_requests" ADD CONSTRAINT "other_document_requests_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_details" ADD CONSTRAINT "personal_details_lead_id_dealer_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraped_dealer_leads" ADD CONSTRAINT "scraped_dealer_leads_converted_lead_id_dealer_leads_id_fk" FOREIGN KEY ("converted_lead_id") REFERENCES "public"."dealer_leads"("id") ON DELETE no action ON UPDATE no action;