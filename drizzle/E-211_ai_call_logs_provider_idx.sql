------------------------------------------------------------------------------
-- E-211 — provider-scoped index on ai_call_logs.
--
-- /operations/elevenlabs reads ai_call_logs filtered by
-- `provider = 'elevenlabs'` on every panel: month to date, trailing 30 days,
-- the daily trend, the six-month rollup, the campaign-category breakdown and
-- the recent-calls list.
--
-- E-210 added ai_call_logs (ended_at), which serves the date-bounded panels,
-- but `provider` is unindexed — so every one of those queries scans a window of
-- ALL providers and discards the Bolna rows, and the all-time "total usage"
-- aggregate (which has no date bound, because "total" means total) scans the
-- whole table. At the page's 60-second auto-refresh that is a standing cost.
--
-- (provider, ended_at DESC) serves both shapes from one index: the equality
-- column first for the filter, the ordered column second for the range scan and
-- for `ORDER BY ended_at DESC LIMIT 20` without a sort.
--
-- Also speeds up the per-provider GROUP BY that /operations/spend and the
-- `spend.rollup` collector already run hourly.
--
-- Strictly additive. Creates no table, drops nothing, changes no type.
-- Re-running this file is a no-op.
------------------------------------------------------------------------------

-- The COMMENT lives inside the block too: if the table is absent the CREATE is
-- skipped, and a COMMENT on the index that was never created would then fail
-- outside the handler's reach.
DO $do$ BEGIN
  CREATE INDEX IF NOT EXISTS ai_call_logs_provider_ended_at_idx
    ON ai_call_logs (provider, ended_at DESC);

  COMMENT ON INDEX ai_call_logs_provider_ended_at_idx IS
    'E-211 — serves the per-provider cost/volume aggregates behind /operations/elevenlabs and /operations/spend.';
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip ai_call_logs — table not present';
END; $do$;
