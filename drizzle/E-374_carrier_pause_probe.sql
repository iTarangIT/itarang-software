-- =============================================================================
-- E-374 — AI DIALER: CARRIER-REFUSAL PAUSE, PROBE AND PICK-UP
--          (Priya KPI tracker task 10, 4 Nov 2026)
-- =============================================================================
-- WHY.
--   E-360 paused a campaign after 10 refused dials in a row, and then waited
--   for a person. A refused afternoon still cost the whole afternoon (690
--   wasted dials on 30 Sep; 16 of 16 failed on 23 Oct). The tracker's rule:
--   pause only on SIP 401/403/407/429/503, save where the campaign stopped,
--   probe the line every 30 min inside 10:00–19:00 (up to 6 probes) and resume
--   on its own; a second pause the same day waits for a manual Resume.
--
-- WHAT. dialer_campaign_line_health (E-360) gains the pause's state:
--   block_kind             carrier | setup (a config error: never probed)
--   sip_code               the refusal code that tipped the pause
--   cursor_queue_position  queue position of the first refused lead — where
--   cursor_lead_id           the campaign picks up again
--   refunded_rows          refused rows handed back to the queue at the pause
--   pause_day, pauses_today  the IST day and how many pauses it has had
--   probe_count, next_probe_at, last_probe_at, last_probe_result
--   needs_manual_resume    second pause of the day, setup error, or 6 probes used
--   alert_sent_at          the one alert this pause sent
--
-- Columns on an existing raw-SQL table (not mirrored in schema.ts; read
-- through to_regclass / a column probe in src/lib/ai-dialer/lineHealth.ts), so
-- the code is safe in either order: without them the E-360 pause works as
-- before and nothing is probed. Skips with a NOTICE when E-360 is missing.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE dialer_campaign_line_health
        ADD COLUMN IF NOT EXISTS block_kind             varchar(10),
        ADD COLUMN IF NOT EXISTS sip_code               smallint,
        ADD COLUMN IF NOT EXISTS cursor_queue_position  integer,
        ADD COLUMN IF NOT EXISTS cursor_lead_id         text,
        ADD COLUMN IF NOT EXISTS refunded_rows          integer      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS pause_day              date,
        ADD COLUMN IF NOT EXISTS pauses_today           integer      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS probe_count            integer      NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS next_probe_at          timestamptz,
        ADD COLUMN IF NOT EXISTS last_probe_at          timestamptz,
        ADD COLUMN IF NOT EXISTS last_probe_result      text,
        ADD COLUMN IF NOT EXISTS needs_manual_resume    boolean      NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS alert_sent_at          timestamptz;

    CREATE INDEX IF NOT EXISTS dialer_campaign_line_health_probe_idx
        ON dialer_campaign_line_health (next_probe_at)
        WHERE next_probe_at IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-374 skipped: dialer_campaign_line_health (E-360) does not exist yet';
END;
$do$;
