-- E-320 — lead source backfill: the leads E-314 / E-317 left without a door,
-- an origin or a campaign (tracker ID 81, review of 30 Sep 2026). 2026-10-01.
-- Requires E-314, E-317 and E-319.
--
-- DATA ONLY — no DDL. Every statement fills a value that is NULL today and
-- touches nothing that is already set, so re-running is a no-op.
--
-- ⚠ PERMANENT. The E-317 lock keeps the first door / origin / campaign a lead
-- is given; what this file writes cannot be changed afterwards by an UPDATE.
-- Run `node scripts/_apply-e319-e320.mjs <database> --dry-run` first and read
-- the counts.
--
-- 1. Doors, from what each creating path leaves on the row:
--      L-<8 chars>, no source, no batch      the scraper. `L-${nanoid(8)}` is
--                                            written only by scraper promotion
--                                            (leadStore, the promote route, the
--                                            promote-on-dial in triggerCall) —
--                                            their scraped twin was since
--                                            deleted, so E-317's phone match
--                                            missed them.
--      DL-<ms>-<8 hex>, no batch             the /leads Import modal
--                                            (crypto.randomUUID slice).
--      DL-<ms>-<anything else>               a rep (nanoid suffix: New Lead,
--                                            Add Lead, Create Lead).
--    Rows in any other shape (old uuid ids, seeds) carry no evidence and stay
--    as they are.
-- 2. Origins that follow from the door:
--      scraper                               scraped_listing
--      neodove, ai_dialer, bulk_upload       purchased_list — a calling list;
--                                            the closest of the 8 agreed values
--                                            (E-317 mapped the old
--                                            'cold_call_list' the same way).
--    Rep-created and WhatsApp leads are NOT guessed: only the person who made
--    them knows. They stay "Not recorded" until someone sets it on the lead
--    (allowed once — the lock keeps it).
-- 3. Campaigns — one per upload batch, per scrape run and per AI-dialer list,
--    each linked to the leads it brought in.

DO $do$
BEGIN
    -- 1. Doors.
    UPDATE dealer_leads
       SET source_door = 'scraper',
           source_origin = COALESCE(source_origin, 'scraped_listing')
     WHERE source_door IS NULL
       AND source IS NULL
       AND upload_batch_id IS NULL
       AND id ~ '^L-[A-Za-z0-9_-]{8}$';

    UPDATE dealer_leads
       SET source_door = CASE WHEN id ~ '^DL-[0-9]+-[0-9a-f]{8}$' THEN 'bulk_upload' ELSE 'rep_create' END
     WHERE source_door IS NULL
       AND (source IS NULL OR source = 'manual_upload_lead')
       AND upload_batch_id IS NULL
       AND COALESCE(memory ->> 'list_import', '') <> 'true'
       AND id ~ '^DL-[0-9]+-';

    -- 2. Origins that follow from the door.
    UPDATE dealer_leads SET source_origin = 'scraped_listing'
     WHERE source_origin IS NULL AND source_door = 'scraper';

    UPDATE dealer_leads SET source_origin = 'purchased_list'
     WHERE source_origin IS NULL AND source_door IN ('neodove', 'ai_dialer', 'bulk_upload');

    -- 3a. One campaign per upload batch that brought in leads.
    INSERT INTO acquisition_campaigns (name, origin, kind, starts_on, created_by, notes)
    SELECT 'Upload · ' || COALESCE(NULLIF(btrim(b.source_label), ''), b.file_name)
               || ' · ' || to_char(b.created_at, 'DD Mon YYYY') || ' · ' || left(b.batch_id::text, 8),
           (SELECT mode() WITHIN GROUP (ORDER BY dl.source_origin)
              FROM dealer_leads dl WHERE dl.upload_batch_id = b.batch_id),
           'upload_batch', b.created_at::date, b.uploaded_by,
           'Backfilled by E-320 from upload batch ' || b.batch_id::text
      FROM upload_batches b
     WHERE b.acquisition_campaign_id IS NULL
       AND EXISTS (SELECT 1 FROM dealer_leads dl WHERE dl.upload_batch_id = b.batch_id)
    ON CONFLICT (lower(name)) DO NOTHING;

    UPDATE upload_batches b
       SET acquisition_campaign_id = c.id
      FROM acquisition_campaigns c
     WHERE b.acquisition_campaign_id IS NULL
       AND c.kind = 'upload_batch'
       AND lower(c.name) = lower('Upload · ' || COALESCE(NULLIF(btrim(b.source_label), ''), b.file_name)
               || ' · ' || to_char(b.created_at, 'DD Mon YYYY') || ' · ' || left(b.batch_id::text, 8));

    UPDATE dealer_leads dl
       SET acquisition_campaign_id = b.acquisition_campaign_id
      FROM upload_batches b
     WHERE dl.upload_batch_id = b.batch_id
       AND dl.acquisition_campaign_id IS NULL
       AND b.acquisition_campaign_id IS NOT NULL;

    -- 3b. One campaign per scrape run. A scraped lead belongs to the run whose
    --     scraped record carries its phone (last 10 digits) — the record made
    --     just before the lead when there are several.
    DROP TABLE IF EXISTS e320_lead_run;
    CREATE TEMP TABLE e320_lead_run AS
    SELECT DISTINCT ON (dl.id) dl.id AS lead_id, s.scraper_run_id AS run_id
      FROM dealer_leads dl
      JOIN scraped_dealer_leads s
        ON right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)
         = right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10)
     WHERE dl.source_door = 'scraper'
       AND dl.acquisition_campaign_id IS NULL
       AND dl.phone IS NOT NULL
       AND length(regexp_replace(dl.phone, '[^0-9]', '', 'g')) >= 10
     ORDER BY dl.id,
              (s.created_at <= dl.created_at + INTERVAL '10 minutes') DESC,
              abs(extract(epoch FROM (dl.created_at - s.created_at)));

    INSERT INTO acquisition_campaigns (name, origin, kind, starts_on, created_by, notes)
    SELECT 'Scrape · ' || left(COALESCE(
                   CASE jsonb_typeof(r.search_queries)
                        WHEN 'string' THEN r.search_queries #>> '{}'
                        WHEN 'array'  THEN r.search_queries ->> 0
                        ELSE NULL END, 'run'), 80)
               || ' · ' || to_char(r.started_at, 'DD Mon YYYY') || ' · ' || right(r.id, 8),
           'scraped_listing', 'scrape_run', r.started_at::date, r.triggered_by::text,
           'Backfilled by E-320 from scrape run ' || r.id
      FROM scraper_runs r
     WHERE r.acquisition_campaign_id IS NULL
       AND EXISTS (SELECT 1 FROM e320_lead_run m WHERE m.run_id = r.id)
    ON CONFLICT (lower(name)) DO NOTHING;

    UPDATE scraper_runs r
       SET acquisition_campaign_id = c.id
      FROM acquisition_campaigns c
     WHERE r.acquisition_campaign_id IS NULL
       AND c.kind = 'scrape_run'
       AND c.notes = 'Backfilled by E-320 from scrape run ' || r.id;

    UPDATE dealer_leads dl
       SET acquisition_campaign_id = r.acquisition_campaign_id
      FROM e320_lead_run m
      JOIN scraper_runs r ON r.id = m.run_id
     WHERE dl.id = m.lead_id
       AND dl.acquisition_campaign_id IS NULL
       AND r.acquisition_campaign_id IS NOT NULL;

    DROP TABLE IF EXISTS e320_lead_run;

    -- 3c. One campaign per AI-dialer list (memory.list_name).
    INSERT INTO acquisition_campaigns (name, origin, kind, starts_on, notes)
    SELECT 'List · ' || btrim(dl.memory ->> 'list_name'),
           'purchased_list', 'dialer_list', min(dl.created_at)::date,
           'Backfilled by E-320 from the AI-dialer list of this name'
      FROM dealer_leads dl
     WHERE dl.source_door = 'ai_dialer'
       AND dl.acquisition_campaign_id IS NULL
       AND NULLIF(btrim(dl.memory ->> 'list_name'), '') IS NOT NULL
     GROUP BY btrim(dl.memory ->> 'list_name')
    ON CONFLICT (lower(name)) DO NOTHING;

    UPDATE dealer_leads dl
       SET acquisition_campaign_id = c.id
      FROM acquisition_campaigns c
     WHERE dl.source_door = 'ai_dialer'
       AND dl.acquisition_campaign_id IS NULL
       AND c.kind = 'dialer_list'
       AND lower(c.name) = lower('List · ' || btrim(dl.memory ->> 'list_name'));
EXCEPTION WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE 'E-320 skipped — apply E-314, E-317 and E-319 first';
END
$do$;
