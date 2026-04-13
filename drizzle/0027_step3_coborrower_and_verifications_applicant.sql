-- Step 3 Co-Borrower & Supporting Documents Workflow (BRD §2.9.3)
-- 1. Track applicant type on kyc_verifications so co-borrower runs are scoped
-- 2. Add co_borrower_requests to track replacement attempts

ALTER TABLE "kyc_verifications"
  ADD COLUMN IF NOT EXISTS "applicant" varchar(20) NOT NULL DEFAULT 'primary';

CREATE TABLE IF NOT EXISTS "co_borrower_requests" (
  "id" varchar(255) PRIMARY KEY,
  "lead_id" varchar(255) NOT NULL REFERENCES "dealer_leads"("id") ON DELETE CASCADE,
  "attempt_number" integer NOT NULL DEFAULT 1,
  "reason" text,
  "status" varchar(30) NOT NULL DEFAULT 'open',
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "co_borrower_requests_lead_id_idx"
  ON "co_borrower_requests" ("lead_id");
