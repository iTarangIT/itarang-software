CREATE TABLE IF NOT EXISTS "admin_verification_queue" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "queue_type" varchar(50) DEFAULT 'kyc_verification' NOT NULL,
  "lead_id" text NOT NULL,
  "priority" varchar(20) DEFAULT 'normal' NOT NULL,
  "assigned_to" uuid,
  "submitted_by" uuid,
  "status" varchar(50) DEFAULT 'pending_itarang_verification' NOT NULL,
  "submitted_at" timestamp with time zone,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "admin_verification_queue_lead_id_dealer_leads_id_fk"
    FOREIGN KEY ("lead_id") REFERENCES "dealer_leads"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "admin_verification_queue_assigned_to_users_id_fk"
    FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "admin_verification_queue_submitted_by_users_id_fk"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "kyc_verification_metadata" (
  "lead_id" text PRIMARY KEY NOT NULL,
  "submission_timestamp" timestamp with time zone NOT NULL,
  "case_type" varchar(20),
  "coupon_code" varchar(50),
  "coupon_status" varchar(20) DEFAULT 'reserved' NOT NULL,
  "documents_count" integer DEFAULT 0 NOT NULL,
  "consent_verified" boolean DEFAULT false NOT NULL,
  "dealer_edits_locked" boolean DEFAULT false NOT NULL,
  "verification_started_at" timestamp with time zone,
  "first_api_execution_at" timestamp with time zone,
  "first_api_type" varchar(50),
  "final_decision" varchar(30),
  "final_decision_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kyc_verification_metadata_lead_id_dealer_leads_id_fk"
    FOREIGN KEY ("lead_id") REFERENCES "dealer_leads"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "admin_verification_queue_lead_idx"
  ON "admin_verification_queue" ("lead_id");
CREATE INDEX IF NOT EXISTS "admin_verification_queue_status_idx"
  ON "admin_verification_queue" ("status");
CREATE INDEX IF NOT EXISTS "admin_verification_queue_assigned_idx"
  ON "admin_verification_queue" ("assigned_to");
CREATE INDEX IF NOT EXISTS "admin_verification_queue_created_idx"
  ON "admin_verification_queue" ("created_at");
CREATE INDEX IF NOT EXISTS "kyc_verification_metadata_coupon_idx"
  ON "kyc_verification_metadata" ("coupon_code");
CREATE INDEX IF NOT EXISTS "kyc_verification_metadata_coupon_status_idx"
  ON "kyc_verification_metadata" ("coupon_status");
