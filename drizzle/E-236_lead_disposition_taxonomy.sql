------------------------------------------------------------------------------
-- E-236 — Persist the call-centre disposition, so it can be filtered on.
--
-- PROBLEM. Every NeoDove webhook already carries the CC team's disposition:
-- `lead_tag_name` holds the L3 the agent tapped ("Price High", "REJECTED BY
-- US"), `lead_stage_name` the funnel stage, `lead_status_name` a label.
-- parseInboundEvent() extracts all three — and then remarksFor() flattens them
-- into ONE PROSE STRING on lead_touchpoints.remarks:
--
--   "[NeoDove] Disposition: Interested · Stage: Cold · Tag: Service Issue"
--
-- Prose cannot be filtered, grouped or counted. "Show me every lead marked
-- Price High" — the question the whole telecalling loop exists to answer — was
-- unanswerable in the CRM, so a sales head had to read NeoDove's own dashboard
-- to see the funnel their own leads were in.
--
-- WHY TWO TABLES AND NOT ONE.
--   * lead_touchpoints gets the per-call record. A lead is called many times and
--     each call has its own disposition; that history is the evidence behind any
--     later dispute and must not be overwritten.
--   * dealer_leads gets a denormalised "latest". The /leads list renders 50 rows
--     a page and its WHERE clause has to be indexable — resolving "the most
--     recent NeoDove touchpoint per lead" through a lateral join for a filter
--     that runs on every keystroke is the thing this column exists to avoid.
--     Exactly the reasoning E-224 used for neodove_sync_status.
--
-- WHY THE BUCKET IS STORED AND NOT DERIVED AT QUERY TIME. The L3 → L2 mapping
-- lives in src/lib/leads/dispositions.ts and has one genuine ambiguity
-- ("Commercials Explained" is listed under both Warm and Hot), resolved using
-- NeoDove's stage on the event. That resolution needs the event, which the
-- query does not have. Storing the answer means the filter and the chip on the
-- row can never disagree, and it keeps a 37-arm CASE out of the hot path.
--
-- ⚠ NONE OF THESE COLUMNS ARE MIRRORED IN src/lib/db/schema.ts.
-- Same hard rule as E-224's two dealer_leads columns and E-226's two
-- lead_touchpoints columns, for the same reason: drizzle names EVERY column of
-- a table object in its INSERT and in a bare db.select(), so listing them here
-- would break every touchpoint write and every `db.select().from(dealerLeads)`
-- on any database where this file has not been applied — which today includes
-- prod (db-2). They are written by best-effort raw UPDATEs in
-- src/lib/neodove/inbound.ts, run AFTER writeTouchpoint's transaction commits,
-- and read by raw sql`` in src/lib/leads/leadListQuery.ts, which already builds
-- its WHERE out of raw fragments. A missing column costs a disposition label,
-- never a touchpoint.
--
-- The filter predicates are emitted ONLY when the filter is set, so a database
-- without this migration keeps serving /leads correctly for everyone who does
-- not touch the new filter.
--
-- Strictly additive and idempotent, per CLAUDE.md. Guarded: prod has neither
-- E-224 nor E-226, so each block is a no-op there rather than an error.
------------------------------------------------------------------------------

-- ── dealer_leads: the latest disposition, for the list filter ──────────────
DO $do$
BEGIN
    ALTER TABLE dealer_leads
        -- L3. Canonical casing when the value is in the sheet, the raw NeoDove
        -- string when it is not — an unmapped disposition is still evidence a
        -- human made the call, and dropping it is how a vocabulary change in
        -- NeoDove's settings would go unnoticed for weeks.
        ADD COLUMN IF NOT EXISTS last_disposition        text,
        -- L2: Cold | Warm | Hot | Converted | Lost. NULL for a not-connected
        -- reason (the sheet gives those no bucket) and for an unmapped value.
        ADD COLUMN IF NOT EXISTS last_disposition_bucket varchar(20),
        -- L1: connected | not_connected.
        ADD COLUMN IF NOT EXISTS last_connect_status     varchar(20),
        -- When the CALL happened, not when we wrote the row. The inbound update
        -- is guarded on this so a replayed or out-of-order webhook cannot
        -- overwrite a newer disposition with an older one.
        ADD COLUMN IF NOT EXISTS last_disposition_at     timestamptz,
        -- 'neodove' today. Present so an inside-sales rep logging a call by hand
        -- against the same vocabulary needs no further migration, and so a
        -- report can say where a number came from.
        ADD COLUMN IF NOT EXISTS last_disposition_source varchar(20);

    -- Partial: most leads have never been dispositioned, and those rows would
    -- otherwise be most of the index. Column order matches how the filter
    -- narrows — L1, then L2, then L3 — so a prefix of the filter still uses it.
    CREATE INDEX IF NOT EXISTS dealer_leads_disposition_idx
        ON dealer_leads (last_connect_status, last_disposition_bucket, last_disposition)
        WHERE last_disposition IS NOT NULL;

    COMMENT ON COLUMN dealer_leads.last_disposition IS
        'E-236: L3 of the CC disposition tree from the most recent call. Denormalised from lead_touchpoints so the /leads filter is indexable. NOT mirrored in schema.ts - see the file header.';
    COMMENT ON COLUMN dealer_leads.last_disposition_bucket IS
        'E-236: L2 - Cold/Warm/Hot/Converted/Lost. NULL for not-connected reasons and for dispositions outside the sheet. Resolved by src/lib/leads/dispositions.ts, never derived in SQL.';
    COMMENT ON COLUMN dealer_leads.last_connect_status IS
        'E-236: L1 - connected | not_connected.';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: dealer_leads absent';
END;
$do$;


-- ── lead_touchpoints: the per-call record ─────────────────────────────────
DO $do$
BEGIN
    ALTER TABLE lead_touchpoints
        ADD COLUMN IF NOT EXISTS disposition        text,
        ADD COLUMN IF NOT EXISTS disposition_bucket varchar(20),
        ADD COLUMN IF NOT EXISTS connect_status     varchar(20),
        -- The external system's OWN words, kept verbatim beside the classified
        -- values. When NeoDove changes its stage or tag vocabulary, this is what
        -- makes the change diagnosable without re-reading every raw payload out
        -- of neodove_sync_events.
        ADD COLUMN IF NOT EXISTS external_stage     text,
        ADD COLUMN IF NOT EXISTS external_tag       text;

    CREATE INDEX IF NOT EXISTS lead_touchpoints_disposition_idx
        ON lead_touchpoints (disposition, performed_at DESC)
        WHERE disposition IS NOT NULL;

    COMMENT ON COLUMN lead_touchpoints.disposition IS
        'E-236: the disposition for THIS call. Written by a raw UPDATE after the touchpoint transaction commits, not by drizzle - see E-226 for the same treatment and the same reason.';
    COMMENT ON COLUMN lead_touchpoints.external_tag IS
        'E-236: NeoDove lead_tag_name, verbatim. The live account puts the CC sheet''s L3 values here rather than in lead_status_name, which is why the classifier reads tag first.';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: lead_touchpoints absent (E-113 not applied)';
END;
$do$;
