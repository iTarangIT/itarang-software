-- Adds admin review columns to kyc_verifications. The schema in
-- src/lib/db/schema.ts already declares these, but there was no migration
-- to apply them to existing databases — the admin KYC case-review query
-- selects these columns and fails without them.

ALTER TABLE "kyc_verifications"
  ADD COLUMN IF NOT EXISTS "admin_action" varchar(30);

ALTER TABLE "kyc_verifications"
  ADD COLUMN IF NOT EXISTS "admin_action_by" uuid REFERENCES "users"("id");

ALTER TABLE "kyc_verifications"
  ADD COLUMN IF NOT EXISTS "admin_action_at" timestamp with time zone;

ALTER TABLE "kyc_verifications"
  ADD COLUMN IF NOT EXISTS "admin_action_notes" text;
