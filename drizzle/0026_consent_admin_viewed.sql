-- Add admin view tracking columns to consent_records
-- Apply on AWS RDS (psql / AWS console / pgAdmin)
ALTER TABLE "consent_records"
  ADD COLUMN IF NOT EXISTS "admin_viewed_by" uuid REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "admin_viewed_at" timestamp with time zone;
