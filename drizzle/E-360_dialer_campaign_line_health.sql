-- =============================================================================
-- E-360 — AI DIALER: PAUSE A CAMPAIGN WHEN THE CARRIER REFUSES CALLS
--          (AI Dialer Fixes D1, 10 Oct 2026)
-- =============================================================================
-- WHY.
--   When the carrier refuses a call (SIP 401/403/407, 429, a config error) the
--   dialer refunded the attempt and went straight to the next lead, so a blocked
--   line kept firing: 690 refused dials on 30 Sep, 100 more on 3 and 5 Oct, and
--   nobody was told. Each lead's attempt was refunded, but the campaign never
--   stopped itself.
--
-- WHAT.
--   dialer_campaign_line_health — one row per campaign that has ever had a
--   line-blocked dial. advanceCampaign counts line-blocked trigger failures in a
--   row (any dial that reaches the carrier resets the count); at 10 it pauses
--   the campaign, stamps pause_reason = 'carrier_refused', and sends one alert.
--   Only the manual Resume restarts it, and Resume clears the row.
--   Code: src/lib/ai-dialer/lineHealth.ts.
--
-- A NEW TABLE, not columns on dialer_campaigns: Drizzle names every mirrored
-- column in its SQL, so a column there would make this migration REQUIRED for
-- every campaign reader. NOT mirrored in schema.ts — every reader/writer is raw
-- SQL behind a to_regclass probe. Without this table the dialer behaves exactly
-- as before (no auto-pause).
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS dialer_campaign_line_health (
    campaign_id              text         PRIMARY KEY,
    consecutive_line_blocked integer      NOT NULL DEFAULT 0,
    last_carrier_error       text,
    pause_reason             text,
    paused_at                timestamptz,
    updated_at               timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE dialer_campaign_line_health IS
  'E-360 — per AI-dialer campaign: line-blocked trigger failures in a row (SIP 401/403/407/429, config error) and the carrier pause they caused. Written by src/lib/ai-dialer/lineHealth.ts; at 10 in a row the campaign is paused with pause_reason carrier_refused until a manual Resume.';
COMMENT ON COLUMN dialer_campaign_line_health.consecutive_line_blocked IS
  'Line-blocked dials in a row. Reset to 0 by any dial that reaches the carrier (rang, busy, answered, unanswered) and by Resume.';
COMMENT ON COLUMN dialer_campaign_line_health.pause_reason IS
  'carrier_refused while the campaign is paused because of it; NULL otherwise.';
