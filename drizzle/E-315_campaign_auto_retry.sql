-- E-315 — AI dialer campaigns redial unreached leads automatically.
--
-- DDL: additive + idempotent. Safe to run any number of times.
--
-- WHY
--   A campaign dialled each lead exactly once: busy / no response / silent /
--   hung up were as final as a conversation, and the campaign closed the moment
--   its queue emptied. Campaigns ended ~9% connected (Hanumangarh, 28 Sept:
--   2 of 23). The only redial was the manual "Retry unreached" button, which
--   spawns a separate campaign per click.
--
--   Now the SAME campaign keeps redialling: up to max_retries extra dials per
--   lead, increasing gaps, always inside calling hours. Policy lives in
--   src/lib/ai-dialer/retryPolicy.ts; the single writer is
--   campaignTracker.recordAttemptOutcome.
--
-- COLUMNS
--   dialer_campaigns.max_retries       NULL = auto-retry off. Every existing
--                                      campaign stays NULL, so nothing old is
--                                      reopened; createCampaign sets 3.
--   dialer_campaign_leads.attempt_count     dials placed for this row.
--   dialer_campaign_leads.next_attempt_at   set = a retry is due at this time.
--                                           status keeps the LATEST outcome
--                                           (e.g. 'busy') meanwhile, so the
--                                           campaign tiles stay truthful.
--   dialer_campaign_leads.attempt_history   [{n,status,outcome,at,call_id}]
--
-- MIRRORED in src/lib/db/schema.ts — apply to BOTH databases before the code
-- deploys (Drizzle names every column in its SELECTs).

DO $do$
BEGIN
    ALTER TABLE dialer_campaigns
        ADD COLUMN IF NOT EXISTS max_retries integer;

    ALTER TABLE dialer_campaign_leads
        ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
    ALTER TABLE dialer_campaign_leads
        ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
    ALTER TABLE dialer_campaign_leads
        ADD COLUMN IF NOT EXISTS attempt_history jsonb NOT NULL DEFAULT '[]'::jsonb;

    -- The claim + wake-up ticker predicate: due retries per campaign.
    CREATE INDEX IF NOT EXISTS idx_dialer_campaign_leads_retry_due
        ON dialer_campaign_leads (campaign_id, next_attempt_at)
        WHERE next_attempt_at IS NOT NULL;

    COMMENT ON COLUMN dialer_campaigns.max_retries IS
        'E-315 — automatic redials per unreached lead; NULL = auto-retry off';
    COMMENT ON COLUMN dialer_campaign_leads.attempt_count IS
        'E-315 — dials placed for this row (first call + retries)';
    COMMENT ON COLUMN dialer_campaign_leads.next_attempt_at IS
        'E-315 — when set, the row is redialled at/after this time; status keeps the latest outcome';
    COMMENT ON COLUMN dialer_campaign_leads.attempt_history IS
        'E-315 — [{n,status,outcome,at,call_id}] one entry per finished attempt';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-315 skipped: dialer_campaigns / dialer_campaign_leads missing';
END;
$do$;
