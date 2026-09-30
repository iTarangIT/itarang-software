-- E-315 — lead source: final vocabulary, correct doors, first source locked
-- (tracker ID 81, handover P2-9). 2026-09-30. Requires E-314.
--
-- Three tags on every lead, shown on screen as:
--   Entered via  (source_door)              how it got into the CRM — automatic
--   Found via    (source_origin)            how we found the dealer — fixed list
--   Campaign     (acquisition_campaign_id)  the event / list / batch
--
-- 1. Origin vocabulary → the agreed 8: field_walk_in, trade_event,
--    dealer_referral, oem_referral, inbound_call, scraped_listing,
--    purchased_list, digital_ad. Old values are remapped; 'other' carries
--    nothing and becomes NULL.
-- 2. Doors wrongly backfilled by E-314. Rep-created, WhatsApp Assistant and
--    AI-dialer list leads are all stored with source = 'manual_upload_lead',
--    which the E-314 trigger read as bulk_upload — and the code's later stamp
--    could not override it. They are re-derived from what each path leaves
--    behind (memory.list_import, the "Lead created" line, originator_id).
--    'dealer_referral' is an origin, not a door: those rows become rep_create.
-- 3. Scraped leads with no door are matched back to their scrape run by phone
--    (last 10 digits) — only when the lead was created at or after the scrape.
-- 4. The insert trigger no longer maps 'manual_upload_lead' (it is ambiguous);
--    every path stamps its own door. AI-dialer list rows are recognised by
--    memory.list_import.
-- 5. LOCK: once set, source_door / source_origin / acquisition_campaign_id
--    never change. A returning dealer is a Re-inquiry, never a new source.
--
-- Data changes only on rows whose values are old or wrong; re-running is a
-- no-op (the lock trigger is created last, after the corrections).
-- ⚠ Apply on every DB that has E-314, BEFORE deploying the matching code.

DO $do$
BEGIN
    -- 1. Origin remap.
    UPDATE dealer_leads SET source_origin = CASE source_origin
            WHEN 'field_visit'        THEN 'field_walk_in'
            WHEN 'trade_show'         THEN 'trade_event'
            WHEN 'referral_dealer'    THEN 'dealer_referral'
            WHEN 'referral_oem'       THEN 'oem_referral'
            WHEN 'google_maps_scrape' THEN 'scraped_listing'
            WHEN 'indiamart_scrape'   THEN 'scraped_listing'
            WHEN 'cold_call_list'     THEN 'purchased_list'
            WHEN 'whatsapp_inbound'   THEN 'inbound_call'
            WHEN 'website'            THEN 'digital_ad'
            WHEN 'social_media'       THEN 'digital_ad'
            ELSE NULL END
     WHERE source_origin IN ('field_visit', 'trade_show', 'referral_dealer', 'referral_oem',
                             'google_maps_scrape', 'indiamart_scrape', 'cold_call_list',
                             'whatsapp_inbound', 'website', 'social_media', 'other');

    -- 2. Doors wrongly set to bulk_upload.
    UPDATE dealer_leads dl SET source_door = CASE
            WHEN dl.memory ->> 'list_import' = 'true' THEN 'ai_dialer'
            WHEN EXISTS (SELECT 1 FROM lead_touchpoints t
                          WHERE t.dealer_lead_id = dl.id
                            AND t.touchpoint_type = 'lead_created'
                            AND t.remarks ILIKE 'Lead created (whatsapp assistant)%') THEN 'whatsapp_assistant'
            WHEN dl.originator_id IS NOT NULL THEN 'rep_create'
            ELSE dl.source_door END
     WHERE dl.source_door = 'bulk_upload'
       AND dl.upload_batch_id IS NULL
       AND dl.source = 'manual_upload_lead';

    UPDATE dealer_leads SET source_door = 'rep_create' WHERE source_door = 'dealer_referral';

    -- 3. Scraped leads, matched to their scrape run by phone.
    UPDATE dealer_leads dl
       SET source_door = 'scraper',
           source_origin = COALESCE(dl.source_origin, 'scraped_listing')
     WHERE dl.source_door IS NULL
       AND dl.phone IS NOT NULL
       AND EXISTS (
            SELECT 1 FROM scraped_dealer_leads s
             WHERE right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)
                 = right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10)
               AND s.created_at <= dl.created_at + INTERVAL '10 minutes');

    UPDATE dealer_leads SET source_origin = 'scraped_listing'
     WHERE source_door = 'scraper' AND source_origin IS NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'E-315 backfill skipped — apply E-314 first';
END
$do$;

-- 4. Insert trigger: the door is automatic only where the row says it
-- unambiguously; every other path stamps its own.
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
    RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- 5. The first source is locked for good.
CREATE OR REPLACE FUNCTION dealer_leads_source_lock_fn() RETURNS trigger AS $fn$
BEGIN
    IF OLD.source_door IS NOT NULL THEN NEW.source_door := OLD.source_door; END IF;
    IF OLD.source_origin IS NOT NULL THEN NEW.source_origin := OLD.source_origin; END IF;
    IF OLD.acquisition_campaign_id IS NOT NULL THEN
        NEW.acquisition_campaign_id := OLD.acquisition_campaign_id;
    END IF;
    RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dealer_leads_source_lock') THEN
        CREATE TRIGGER dealer_leads_source_lock
            BEFORE UPDATE OF source_door, source_origin, acquisition_campaign_id ON dealer_leads
            FOR EACH ROW EXECUTE FUNCTION dealer_leads_source_lock_fn();
    END IF;
END
$do$;
