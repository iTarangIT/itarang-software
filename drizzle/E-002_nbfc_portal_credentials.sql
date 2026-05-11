-- E-002 — NBFC activation: portal credentials issuance (BRD §6.0.2 Step 6)
-- Adds activated_at to nbfc and creates nbfc_portal_credentials audit table.

ALTER TABLE "nbfc"
  ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "nbfc_portal_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "nbfc_id" integer NOT NULL REFERENCES "nbfc"("id"),
  "supabase_user_id" uuid NOT NULL,
  "email_dispatched_at" timestamp with time zone,
  "dispatch_status" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "nbfc_portal_credentials_nbfc_id_idx"
  ON "nbfc_portal_credentials" ("nbfc_id");

CREATE INDEX IF NOT EXISTS "nbfc_portal_credentials_dispatch_status_idx"
  ON "nbfc_portal_credentials" ("dispatch_status");
