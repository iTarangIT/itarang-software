-- E-202 — Dealer business type (New / Scrap / Both) on dealer onboarding.
--
-- The onboarding wizard already captures company_type (LEGAL structure: sole
-- proprietorship / partnership / private limited), but nothing records what kind
-- of battery business the dealer runs. The business now classifies every dealer
-- as one of:
--     'new'   — New Battery Dealer
--     'scrap' — Scrap / Old Battery Dealer
--     'both'  — handles both new and old batteries
-- selected during registration (Step 1 of the wizard).
--
-- This migration only CAPTURES the type. Nothing branches on it yet — the
-- per-type agreement templates and per-type dashboards are deliberately a later
-- change. The value is carried from dealer_onboarding_applications onto the
-- canonical dealers row at approval so downstream work has it.
--
-- varchar(16) (not an enum) to match this table family's existing convention of
-- free-text classification columns (company_type, source, payment_method) — a
-- new value never needs a type migration. Nullable + backfilled to 'new' so
-- existing dealers (all new-battery today) keep working; the wizard requires a
-- selection for every new application.
--
-- Additive + idempotent.

ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS dealer_type varchar(16);

ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS dealer_type varchar(16);

COMMENT ON COLUMN dealer_onboarding_applications.dealer_type IS
  'E-202 — dealer business type: new | scrap | both. Selected in onboarding Step 1. NULL only on legacy / non-web (WhatsApp, lead-conversion) rows until backfilled.';
COMMENT ON COLUMN dealers.dealer_type IS
  'E-202 — dealer business type (new | scrap | both), copied from the onboarding application at approval.';

-- Backfill existing rows to 'new' (every dealer onboarded so far is a new-battery
-- dealer). Idempotent: only fills rows still NULL, so a re-run — or a later
-- hand-edit — is never clobbered.
UPDATE dealer_onboarding_applications
   SET dealer_type = 'new'
 WHERE dealer_type IS NULL;

UPDATE dealers
   SET dealer_type = 'new'
 WHERE dealer_type IS NULL;
