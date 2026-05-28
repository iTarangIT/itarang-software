-- E-126_dealer_leads_source_column.sql
--
-- Part 0 BRD §0.11 Report 5 (Source Performance) groups conversions by
-- dealer_leads.source; BRD §0.4 bulk upload must stamp each uploaded lead with
-- a source. dealer_leads currently has `provider` (the AI dialer provider, e.g.
-- 'bolna') but no lead-acquisition `source`. This migration adds it.
--
-- Canonical source values used by Part 0:
--   ai_dialer_lead  — promoted from the AI dialer pool
--   manual_upload_lead — admin bulk CSV upload (BRD §0.4)
--   reference / trade_show / other — free-form, set on upload via source_label
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS. Strictly additive — no DROP,
-- no type narrowing. Apply via pgAdmin Query Tool against AWS Postgres.

ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS source varchar(40);

-- Verification:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'dealer_leads' AND column_name = 'source';
--   -- expect one row: source / character varying
