-- =============================================================================
-- E-346 — DEALER LEADS: server-written Overall Summary + typed notes (2026-10-16)
-- =============================================================================
-- WHY. Tracker ID 118, option B (Kartik, 10 Oct): "the server writes the
-- summary itself, refreshes it when a new call transcript arrives, and typed
-- notes get their own field." Until now the lead page generated the summary
-- in the browser and saved it; once saved it was never refreshed, and Edit
-- lead › Notes › Summary wrote into the same column.
--
-- WHAT CHANGED (additive; two nullable columns on dealer_leads):
--   summary_notes       text         what a person types (Edit lead › Notes)
--   overall_summary_at  timestamptz  when the server last wrote overall_summary
--
-- The server (src/lib/leads/overallSummary.ts) rewrites overall_summary after
-- a call when a transcript is newer than overall_summary_at. On its first
-- write to a lead it copies the old overall_summary into summary_notes when
-- that is still empty, so nothing typed before is lost.
--
-- NOT mirrored in schema.ts on purpose: dealer_leads is written by many
-- Drizzle INSERTs that would fail on a database without these columns (same
-- as E-236 / E-295). Readers use to_jsonb; writers are raw. Code on a DB
-- without E-346 only fills an EMPTY summary and cannot save typed notes
-- (Edit lead says so).
--
-- No backfill. Idempotent: re-running is a no-op.
-- =============================================================================

DO $do$ BEGIN
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS summary_notes text;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS overall_summary_at timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-346 skipped: dealer_leads does not exist';
END; $do$;

COMMENT ON COLUMN dealer_leads.summary_notes IS
    'E-346 / ID 118 option B: notes typed on Edit lead. overall_summary is written by the server from call transcripts.';
COMMENT ON COLUMN dealer_leads.overall_summary_at IS
    'E-346: when the server last wrote overall_summary (refreshed when a newer call transcript exists).';
