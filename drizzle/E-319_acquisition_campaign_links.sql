-- E-319 — acquisition campaigns become usable (tracker ID 81, handover P2-9).
-- 2026-10-01. Requires E-314 (acquisition_campaigns, dealer_leads.source_*)
-- and E-317 (the source lock).
--
-- E-314 created acquisition_campaigns with no writer, reader or screen. This
-- adds what the campaign layer needs:
--
-- acquisition_campaigns
--   kind        how the campaign came to exist:
--                 manual        a person named it (a trade event, an ad, a list)
--                 upload_batch  one bulk-upload batch
--                 scrape_run    one scrape run
--                 dialer_list   one AI-dialer list upload
--   is_active   an inactive campaign stays on its leads but leaves the pickers.
--   updated_at
-- upload_batches.acquisition_campaign_id   the batch's campaign.
-- scraper_runs.acquisition_campaign_id     the run's campaign.
--
-- Insert trigger: a NeoDove-born lead has no person to ask, so its origin is
-- pre-filled (purchased_list — a calling list). Only NeoDove is pre-filled
-- here: every other door stamps its own origin in code AFTER the insert, and
-- the E-317 lock would keep a value the trigger wrote first (the mistake E-317
-- had to undo for doors).
--
-- DDL: additive + idempotent. Nothing dropped, no type narrowed. The two NOT
-- NULL columns carry a DEFAULT and the table has no rows on either database.
--
-- NOT mirrored in schema.ts, like the rest of E-314: upload_batches and
-- scraper_runs are written through Drizzle, which names every column of the
-- table object in its INSERT — a mirrored column missing from a database takes
-- bulk upload and the scraper down there. The new columns are read and written
-- by raw SQL only, so an unapplied host loses the campaign link and nothing
-- else.

DO $do$
BEGIN
    ALTER TABLE acquisition_campaigns ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'manual';
    ALTER TABLE acquisition_campaigns ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE acquisition_campaigns ADD COLUMN IF NOT EXISTS updated_at timestamptz;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip acquisition_campaigns — apply E-314 first';
END
$do$;

DO $do$
BEGIN
    ALTER TABLE upload_batches ADD COLUMN IF NOT EXISTS acquisition_campaign_id uuid;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip upload_batches';
END
$do$;

DO $do$
BEGIN
    ALTER TABLE scraper_runs ADD COLUMN IF NOT EXISTS acquisition_campaign_id uuid;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip scraper_runs';
END
$do$;

DO $do$
BEGIN
    CREATE INDEX IF NOT EXISTS dealer_leads_acquisition_campaign_idx
        ON dealer_leads (acquisition_campaign_id) WHERE acquisition_campaign_id IS NOT NULL;
EXCEPTION WHEN undefined_column THEN RAISE NOTICE 'skip campaign index — apply E-314 first';
END
$do$;

-- The door rules are E-317's, unchanged. New: the NeoDove origin.
CREATE OR REPLACE FUNCTION dealer_leads_source_door_fn() RETURNS trigger AS $fn$
BEGIN
    IF NEW.source_door IS NULL THEN
        NEW.source_door := CASE
            WHEN NEW.source = 'neodove'                 THEN 'neodove'
            WHEN NEW.source = 'ai_dialer_lead'          THEN 'ai_dialer'
            WHEN NEW.memory ->> 'list_import' = 'true'  THEN 'ai_dialer'
            WHEN NEW.upload_batch_id IS NOT NULL        THEN 'bulk_upload'
            ELSE NULL
        END;
    END IF;
    IF NEW.source_origin IS NULL AND NEW.source_door = 'neodove' THEN
        NEW.source_origin := 'purchased_list';
    END IF;
    RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
