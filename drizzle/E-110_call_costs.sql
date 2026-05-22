-- E-110: Per-call cost columns on ai_call_logs
--
-- Adds nullable cost-breakdown columns so we can capture spend per call from
-- the Bolna and ElevenLabs provider APIs, then aggregate at the campaign
-- level for the new "Cost Analytics" tab under /leads.
--
-- All values are stored as integer USD cents to keep arithmetic precise.
-- Currency conversion to INR for display happens at render time via
-- NEXT_PUBLIC_USD_TO_INR_RATE; see src/lib/currency.ts.
--
-- cost_source: 'provider_api' once we've successfully fetched from the
-- provider; 'manual' reserved for finance overrides; NULL means we haven't
-- attempted/succeeded yet (picked up by the backfill cron).
--
-- Strictly additive and idempotent — safe to re-run.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ai_call_logs') THEN
    RAISE NOTICE 'ai_call_logs table missing; skipping E-110';
    RETURN;
  END IF;

  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS total_cost_cents integer;
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS llm_cost_cents integer;
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS tts_cost_cents integer;
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS stt_cost_cents integer;
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS telephony_cost_cents integer;
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS platform_cost_cents integer;
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS cost_currency varchar(3) DEFAULT 'USD';
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS cost_source varchar(20);
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS cost_fetched_at timestamptz;
END
$do$;

-- Backfill cron picks up rows where cost_fetched_at IS NULL — index that
-- predicate so the sweep stays cheap as ai_call_logs grows.
CREATE INDEX IF NOT EXISTS ai_call_logs_cost_pending_idx
  ON ai_call_logs (ended_at)
  WHERE cost_fetched_at IS NULL;

-- Analytics queries filter by date range and join via provider+call_id. The
-- existing call_id index covers the join; add a started_at index for the
-- date-range scans used by /api/campaigns/cost-analytics.
CREATE INDEX IF NOT EXISTS ai_call_logs_started_at_idx
  ON ai_call_logs (started_at);
