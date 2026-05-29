-- E-130 — BRD Addendum V0.1 (25 May 2026) foundation
-- Phase 1 of the addendum roadmap (plan: do-it-wobbly-knuth.md). Strictly
-- additive + idempotent. Adds the data-layer pieces every later phase depends
-- on: Step 1 lead-form fields, Product Selection §5.3 columns, the
-- credit-bureau abstraction handle, and a discriminator on loan_sanctions so
-- an NBFC user can be the sanctioning party.
--
-- DDL only. NULL allowed everywhere so back-fill is unnecessary; the API
-- layer enforces "required for finance leads" so cash leads are unaffected.
-- product_selections.admin_decision is left in place — Phase 2 will hide the
-- admin product panel, and a future migration removes the column after the
-- new flow is proven (per CLAUDE.md two-migration destructive rule).

-- --- leads (Addendum §3.2, §3.3) -------------------------------------------
ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "resident_status" varchar(20),
  ADD COLUMN IF NOT EXISTS "has_health_insurance" boolean,
  ADD COLUMN IF NOT EXISTS "has_life_insurance" boolean;

DO $do$ BEGIN
  ALTER TABLE "leads"
    ADD CONSTRAINT "leads_resident_status_check"
    CHECK ("resident_status" IS NULL OR "resident_status" IN ('owned', 'rented'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: leads_resident_status_check exists';
END; $do$;

-- --- product_selections (Addendum §5.3) -----------------------------------
ALTER TABLE "product_selections"
  ADD COLUMN IF NOT EXISTS "battery_photo_urls" jsonb,
  ADD COLUMN IF NOT EXISTS "charger_photo_urls" jsonb,
  ADD COLUMN IF NOT EXISTS "selected_nbfcs" jsonb,
  ADD COLUMN IF NOT EXISTS "customer_disclosure_ack" boolean;

COMMENT ON COLUMN "product_selections"."battery_photo_urls" IS
  'Addendum §5.1 — serial close-up + unit photo, dealer-captured. JSON array of object URLs.';
COMMENT ON COLUMN "product_selections"."charger_photo_urls" IS
  'Addendum §5.1 — serial close-up + unit photo, dealer-captured. JSON array of object URLs.';
COMMENT ON COLUMN "product_selections"."selected_nbfcs" IS
  'Addendum §5.3 — 1 or 2 NBFCs the customer picked at Section G. JSON array of nbfc_id strings.';
COMMENT ON COLUMN "product_selections"."customer_disclosure_ack" IS
  'Addendum §5.2 — checkbox confirming the customer was told each selected NBFC verifies independently.';
COMMENT ON COLUMN "product_selections"."admin_decision" IS
  'DEPRECATED by Addendum V0.1 §5.1. Admin no longer acts on product selection. Column kept until the new flow is proven; removed in a follow-up migration.';

-- --- nbfc_loan_products (Addendum §4.3) -----------------------------------
-- Bureau-abstracted credit gate. Phase 1 ships the column; Phase 3 swaps the
-- live provider from CIBIL to Equifax. Default 'equifax' for new rows;
-- existing rows stay NULL (treated as 'cibil' legacy at the app layer until
-- backfilled in Phase 3).
ALTER TABLE "nbfc_loan_products"
  ADD COLUMN IF NOT EXISTS "credit_bureau" varchar(20) DEFAULT 'equifax';

DO $do$ BEGIN
  ALTER TABLE "nbfc_loan_products"
    ADD CONSTRAINT "nbfc_loan_products_credit_bureau_check"
    CHECK ("credit_bureau" IS NULL OR "credit_bureau" IN ('equifax', 'cibil', 'crif', 'experian'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_loan_products_credit_bureau_check exists';
END; $do$;

COMMENT ON COLUMN "nbfc_loan_products"."credit_bureau" IS
  'Addendum §4.3 — which bureau provider this scheme uses. Phase 1 ships the handle; Phase 3 wires Equifax behind it. Reserved values: equifax (default), cibil (legacy), crif, experian.';

-- --- loan_sanctions (Addendum §10/10) -------------------------------------
-- The current `sanctioned_by` uuid points at admin users. Addendum makes the
-- NBFC the sanctioning party. Add a discriminator instead of changing the FK
-- so legacy rows stay valid and the app layer can resolve sanctioned_by to
-- the right user table.
ALTER TABLE "loan_sanctions"
  ADD COLUMN IF NOT EXISTS "sanctioned_by_type" varchar(20);

DO $do$ BEGIN
  ALTER TABLE "loan_sanctions"
    ADD CONSTRAINT "loan_sanctions_sanctioned_by_type_check"
    CHECK ("sanctioned_by_type" IS NULL OR "sanctioned_by_type" IN ('admin', 'nbfc_user'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: loan_sanctions_sanctioned_by_type_check exists';
END; $do$;

COMMENT ON COLUMN "loan_sanctions"."sanctioned_by_type" IS
  'Addendum §10/10 — admin or nbfc_user; resolves which user table sanctioned_by points at. NULL on legacy rows means admin (pre-addendum default).';
