-- E-314 — every status moves on an event (tracker IDs 74–84, 36, 114;
-- handover P2-1 … P2-13). 2026-09-29.
--
-- DDL: additive + idempotent. New columns and one new table; nothing dropped,
-- no type narrowed, nothing SET NOT NULL on existing rows.
--
-- NOT mirrored in schema.ts, on purpose: ~20 call sites do a bare
-- db.select().from(dealerLeads) and a mirrored column missing from a DB takes
-- the leads screens down (the E-299 lesson). The new columns are read and
-- written with raw SQL by the Wave 3 code only, so on an unapplied host those
-- NEW actions fail (Mark Won, Withdraw quote, screenshot contact, source
-- capture, Number Repair) and everything that existed before keeps working.
-- ⚠ REQUIRED before the Wave 3 build is used.
--
-- dealer_leads
--   won_at, won_without_approved_quote   ID 74 — Mark Won sets Won; admin
--                                        approval of the onboarding sets Converted.
--   competitor_name                      ID 76 — "Lost to competition".
--   contactability, contactability_at,   ID 36 — dead_number / non_responsive as
--   contactability_reason                events; the lead keeps its owner of
--                                        record and goes to Number Repair.
--   sales_ready_at, sales_ready_reason   ID 82 — the dated Sales-ready event.
--   source_door, source_origin,          ID 81 — door (automatic), origin (fixed
--   acquisition_campaign_id              list), acquisition campaign.
--   onboarding_docs_submitted_at,        ID 84 — onboarding milestones on the lead.
--   agreement_outcome, onboarding_stalled_at
-- dealer_lead_commercials
--   withdrawn_by, withdraw_reason        ID 78 — withdrawn_at already exists.
-- lead_touchpoints
--   screenshot_sha256                    ID 79 — reused screenshots are flagged.
--   called_on_behalf                     ID 83 — call after "Call this lead now".
-- acquisition_campaigns (new)            ID 81 — separate from dialler campaigns.

DO $do$
BEGIN
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS won_at timestamptz;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS won_without_approved_quote boolean;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS competitor_name text;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS contactability varchar(20);
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS contactability_at timestamptz;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS contactability_reason text;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS sales_ready_at timestamptz;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS sales_ready_reason varchar(40);
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS source_door varchar(30);
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS source_origin varchar(40);
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS acquisition_campaign_id uuid;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS onboarding_docs_submitted_at timestamptz;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS agreement_outcome varchar(20);
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS onboarding_stalled_at timestamptz;

    CREATE INDEX IF NOT EXISTS dealer_leads_contactability_idx
        ON dealer_leads (contactability) WHERE contactability IS NOT NULL;
    CREATE INDEX IF NOT EXISTS dealer_leads_sales_ready_idx
        ON dealer_leads (sales_ready_at) WHERE sales_ready_at IS NOT NULL AND current_owner_id IS NULL;
END
$do$;

DO $do$
BEGIN
    ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS withdrawn_by text;
    ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS withdraw_reason text;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip dealer_lead_commercials';
END
$do$;

DO $do$
BEGIN
    ALTER TABLE lead_touchpoints ADD COLUMN IF NOT EXISTS screenshot_sha256 varchar(64);
    ALTER TABLE lead_touchpoints ADD COLUMN IF NOT EXISTS called_on_behalf boolean;
    CREATE INDEX IF NOT EXISTS lead_touchpoints_screenshot_idx
        ON lead_touchpoints (screenshot_sha256) WHERE screenshot_sha256 IS NOT NULL;
END
$do$;

CREATE TABLE IF NOT EXISTS acquisition_campaigns (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text         NOT NULL,
    origin       varchar(40),
    starts_on    date,
    ends_on      date,
    notes        text,
    created_by   text,
    created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS acquisition_campaigns_name_key ON acquisition_campaigns (lower(name));

-- ── ID 81: the door is automatic ─────────────────────────────────────────────
-- Every insert path that does not stamp source_door itself gets one derived
-- from what it already writes (source, upload_batch_id). Created only if absent.
CREATE OR REPLACE FUNCTION dealer_leads_source_door_fn() RETURNS trigger AS $fn$
BEGIN
    IF NEW.source_door IS NULL THEN
        NEW.source_door := CASE
            WHEN NEW.source = 'neodove'            THEN 'neodove'
            WHEN NEW.source = 'ai_dialer_lead'     THEN 'ai_dialer'
            WHEN NEW.upload_batch_id IS NOT NULL   THEN 'bulk_upload'
            WHEN NEW.source = 'manual_upload_lead' THEN 'bulk_upload'
            WHEN NEW.source = 'reference'          THEN 'dealer_referral'
            ELSE NULL
        END;
    END IF;
    RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dealer_leads_source_door') THEN
        CREATE TRIGGER dealer_leads_source_door
            BEFORE INSERT ON dealer_leads
            FOR EACH ROW EXECUTE FUNCTION dealer_leads_source_door_fn();
    END IF;
END
$do$;

-- Backfill (only rows with no door yet — re-run is a no-op).
UPDATE dealer_leads dl
   SET source_door = 'scraper', source_origin = COALESCE(dl.source_origin, 'google_maps_scrape')
 WHERE dl.source_door IS NULL
   AND EXISTS (SELECT 1 FROM scraped_dealer_leads s WHERE s.converted_lead_id = dl.id);

UPDATE dealer_leads
   SET source_door = CASE
            WHEN source = 'neodove'            THEN 'neodove'
            WHEN source = 'ai_dialer_lead'     THEN 'ai_dialer'
            WHEN upload_batch_id IS NOT NULL   THEN 'bulk_upload'
            WHEN source = 'manual_upload_lead' THEN 'bulk_upload'
            WHEN source = 'reference'          THEN 'dealer_referral'
            WHEN source = 'trade_show'         THEN 'rep_create'
            ELSE NULL END,
       source_origin = COALESCE(source_origin, CASE
            WHEN source = 'trade_show' THEN 'trade_show'
            WHEN source = 'reference'  THEN 'referral_dealer'
            ELSE NULL END)
 WHERE source_door IS NULL;
