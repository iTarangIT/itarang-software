-- Brings prod (AWS RDS) up to parity with sandbox + adds dealer_leads.dealer_id
-- (missing on both DBs, which is why GET /api/dealer-leads errors with
-- "column dealer_leads.dealer_id does not exist" and the /leads UI shows
-- "No dealer leads found" even though POST succeeds).
--
-- Designed to be re-run safely:
--   • Every statement uses IF NOT EXISTS / DEFAULT so it never fails on a
--     partially-applied DB, regardless of whether columns/tables already exist
--     or whether existing rows would violate NOT NULL.
--   • Each statement is independent, so even if pgAdmin runs in autocommit
--     one failure won't roll back the rest.
--   • Existing rows on tables with new NOT NULL columns get the column's
--     DEFAULT value — no manual backfill required.

-- ─── 1. New: kyc_data_audit (sequence → table → ownership → index) ─────────

CREATE SEQUENCE IF NOT EXISTS "kyc_data_audit_id_seq" AS integer START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS "kyc_data_audit" (
  "id"          integer       PRIMARY KEY DEFAULT nextval('kyc_data_audit_id_seq'::regclass),
  "lead_id"     varchar(255),
  "field_name"  varchar(50),
  "field_value" varchar(500),
  "data_source" varchar(20),
  "entered_by"  uuid,
  "entered_at"  timestamptz   DEFAULT now(),
  "reason"      text,
  "created_at"  timestamptz   NOT NULL DEFAULT now()
);

ALTER SEQUENCE "kyc_data_audit_id_seq" OWNED BY "kyc_data_audit"."id";

CREATE INDEX IF NOT EXISTS "kyc_audit_lead_idx" ON "kyc_data_audit" ("lead_id");

-- ─── 2. dealer_onboarding_applications ────────────────────────────────────

ALTER TABLE "dealer_onboarding_applications"
  ADD COLUMN IF NOT EXISTS "agreement_language" varchar(30) NOT NULL DEFAULT 'english';

ALTER TABLE "dealer_onboarding_applications"
  ADD COLUMN IF NOT EXISTS "is_branch_dealer"   boolean     NOT NULL DEFAULT false;

-- ─── 3. digilocker_transactions ───────────────────────────────────────────

ALTER TABLE "digilocker_transactions"
  ADD COLUMN IF NOT EXISTS "sms_message_id"    varchar(255);

ALTER TABLE "digilocker_transactions"
  ADD COLUMN IF NOT EXISTS "sms_delivered_at"  timestamptz;

ALTER TABLE "digilocker_transactions"
  ADD COLUMN IF NOT EXISTS "sms_failed_reason" text;

ALTER TABLE "digilocker_transactions"
  ADD COLUMN IF NOT EXISTS "sms_attempts"      integer     NOT NULL DEFAULT 0;

-- ─── 4. other_document_requests ───────────────────────────────────────────
-- document_name on sandbox is NOT NULL with no default. Adding it that way
-- against a table with existing rows raises 23502. Giving it DEFAULT ''
-- backfills existing rows automatically, satisfies NOT NULL, and matches
-- sandbox's nullability. New inserts that don't specify the column will get
-- '' — drop the default after backfilling real values if that's a concern:
--   ALTER TABLE other_document_requests ALTER COLUMN document_name DROP DEFAULT;

ALTER TABLE "other_document_requests"
  ADD COLUMN IF NOT EXISTS "document_name" text        NOT NULL DEFAULT '';

ALTER TABLE "other_document_requests"
  ADD COLUMN IF NOT EXISTS "document_url"  text;

ALTER TABLE "other_document_requests"
  ADD COLUMN IF NOT EXISTS "status"        varchar(20) DEFAULT 'pending';

-- ─── 5. dealer_leads.dealer_id (the leads-page bug fix) ───────────────────
-- src/lib/db/schema.ts:3039 declares this column. Drizzle's
-- db.select().from(dealerLeads) projects all 18 declared columns, so the
-- absence of dealer_id makes GET /api/dealer-leads return success:false
-- and the UI silently shows "No dealer leads found".

ALTER TABLE "dealer_leads"
  ADD COLUMN IF NOT EXISTS "dealer_id" text;
