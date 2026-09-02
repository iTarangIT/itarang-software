------------------------------------------------------------------------------
-- E-210: Ops Console — the monitoring spine.
--
-- Six tables behind /operations. The console is a thin layer: almost every
-- number it shows already exists somewhere in this codebase or on a box. The
-- job of these tables is to collect those numbers on a schedule, freeze a
-- daily snapshot, and let a page render without ever calling a vendor.
--
--   ops_metric_samples   generic time series — every collector writes here
--   ops_daily_snapshots  one frozen row per day per metric (the trend history)
--   ops_collector_runs   did a collector run, how long, did it fail
--   ops_log_events       log lines forwarded by the host agent
--   ops_alert_rules      editable thresholds
--   ops_alerts           open / resolved breaches
--
-- Conventions: value_num is numeric throughout; money is INR paise (matching
-- ai_call_logs.*_cost_cents); bytes are bytes; percents are 0-100.
--
-- Additive + idempotent. Safe to re-run: every statement is IF NOT EXISTS.
------------------------------------------------------------------------------


------------------------------------------------------------------------------
-- 1. ops_metric_samples — the raw time series.
--
-- Pruned to 30 days by runDailySnapshot(). Everything older lives on in
-- ops_daily_snapshots, so nothing that matters is lost to the prune.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_metric_samples (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable, dot-namespaced, e.g. "host.prod.disk_used_pct". Matches a
  -- MetricDef.key in src/lib/operations/registry.ts. Not a foreign key: the
  -- registry is code, and a sample whose metric was later renamed should still
  -- be readable rather than rejected at write time.
  metric_key  varchar(120) NOT NULL,
  -- Where the number came from, e.g. "host:prod" | "rds:crm" | "vendor:elevenlabs".
  source      varchar(80)  NOT NULL,
  captured_at timestamptz  NOT NULL DEFAULT NOW(),
  value_num   numeric(20,4),
  value_text  text,
  meta        jsonb,
  created_at  timestamptz  NOT NULL DEFAULT NOW()
);

-- The chart read pattern: one metric, newest first, bounded by time.
CREATE INDEX IF NOT EXISTS ops_metric_samples_key_captured_idx
  ON ops_metric_samples (metric_key, captured_at DESC);
-- The prune's read pattern, and "what landed most recently across everything".
CREATE INDEX IF NOT EXISTS ops_metric_samples_captured_idx
  ON ops_metric_samples (captured_at DESC);


------------------------------------------------------------------------------
-- 2. ops_daily_snapshots — one frozen row per day per metric per source.
--
-- NEVER pruned. This is the trend history and the one-slide board's source.
-- The UNIQUE below is what makes runDailySnapshot() re-runnable for the same
-- date without duplicating rows — it upserts on conflict.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_daily_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date         NOT NULL,
  metric_key    varchar(120) NOT NULL,
  source        varchar(80)  NOT NULL,
  -- The representative value for the day (last sample). min/max/avg describe
  -- the spread, so a disk that spiked to 96% at 03:00 and settled back is not
  -- invisible just because the last reading was calm.
  value_num     numeric(20,4),
  value_min     numeric(20,4),
  value_max     numeric(20,4),
  value_avg     numeric(20,4),
  sample_count  integer      NOT NULL DEFAULT 0,
  meta          jsonb,
  created_at    timestamptz  NOT NULL DEFAULT NOW(),
  updated_at    timestamptz  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_daily_snapshots_date_key_source_uniq
  ON ops_daily_snapshots (snapshot_date, metric_key, source);
CREATE INDEX IF NOT EXISTS ops_daily_snapshots_key_date_idx
  ON ops_daily_snapshots (metric_key, snapshot_date DESC);


------------------------------------------------------------------------------
-- 3. ops_collector_runs — "is the monitoring itself alive?"
--
-- Modelled on risk_runs (E-187), including its lock. Without this table a
-- silently-dead collector reads as "everything is green", which is the exact
-- failure mode this console exists to prevent.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_collector_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id    varchar(80)  NOT NULL,
  -- 'ticker' (the 60s in-process timer) | 'manual' (the Run now button).
  -- NOT named "trigger": that is a reserved word in Postgres and would need
  -- quoting forever. Same reasoning as risk_runs.triggered_by.
  triggered_by    varchar(16)  NOT NULL,
  actor_user_id   uuid,
  status          varchar(16)  NOT NULL DEFAULT 'running', -- running|completed|failed
  started_at      timestamptz  NOT NULL DEFAULT NOW(),
  finished_at     timestamptz,
  duration_ms     integer,
  samples_written integer      NOT NULL DEFAULT 0,
  error           text
);

-- The lock. At most one running row per collector, enforced by the database
-- rather than by a check-then-insert that two concurrent ticks can both win.
-- A crashed run leaves a stale 'running' row; the runner reaps those (marks
-- them 'failed') before it tries to insert, so this cannot wedge permanently.
CREATE UNIQUE INDEX IF NOT EXISTS ops_collector_runs_one_active_idx
  ON ops_collector_runs (collector_id) WHERE status = 'running';

-- "When did each collector last finish?" — the due-calculation and the
-- freshness footer both read this.
CREATE INDEX IF NOT EXISTS ops_collector_runs_collector_started_idx
  ON ops_collector_runs (collector_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ops_collector_runs_started_idx
  ON ops_collector_runs (started_at DESC);


------------------------------------------------------------------------------
-- 4. ops_log_events — log lines pushed by ops-agent.
--
-- Pruned to 14 days. `fingerprint` is a hash of service + level + the message
-- with volatile parts (ids, numbers, timestamps) normalised out, so the UI can
-- group "same error, 4,812 times" instead of rendering 4,812 rows. That
-- grouping is not cosmetic — see src/lib/log.ts for why this codebase treats
-- unbounded repeated logging as an outage risk.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_log_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host        varchar(32)  NOT NULL,  -- prod | sandbox | iot
  service     varchar(120) NOT NULL,  -- pm2 process name, or 'nginx'
  level       varchar(16)  NOT NULL,  -- error | warn | info
  message     text         NOT NULL,  -- truncated to 2000 chars at ingest
  logged_at   timestamptz  NOT NULL,
  fingerprint varchar(64)  NOT NULL,
  meta        jsonb,
  created_at  timestamptz  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ops_log_events_logged_idx
  ON ops_log_events (logged_at DESC);
CREATE INDEX IF NOT EXISTS ops_log_events_level_logged_idx
  ON ops_log_events (level, logged_at DESC);
CREATE INDEX IF NOT EXISTS ops_log_events_fingerprint_idx
  ON ops_log_events (fingerprint);
CREATE INDEX IF NOT EXISTS ops_log_events_host_logged_idx
  ON ops_log_events (host, logged_at DESC);


------------------------------------------------------------------------------
-- 5. ops_alert_rules — editable thresholds.
--
-- Seeded from the warn/crit defaults on MetricDef the first time the runner
-- sees a metric, then owned by whoever edits them in /operations/alerts. The
-- seed never overwrites an existing row (ON CONFLICT DO NOTHING) — a threshold
-- someone tuned by hand must survive a deploy.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_alert_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key       varchar(120) NOT NULL,
  -- '*' means "any source" — one rule covers host:prod, host:sandbox and
  -- host:iot rather than needing three near-identical rows.
  source           varchar(80)  NOT NULL DEFAULT '*',
  -- 'gt' = breach when value > threshold (a lower_is_better metric such as
  -- disk_used_pct); 'lt' = breach when value < threshold (a higher_is_better
  -- metric such as connection headroom).
  comparator       varchar(4)   NOT NULL DEFAULT 'gt',
  warn_threshold   numeric(20,4),
  crit_threshold   numeric(20,4),
  enabled          boolean      NOT NULL DEFAULT true,
  -- Minimum gap between notifications for the same rule, so a metric sitting
  -- on the boundary and flapping cannot mail the team every 60 seconds.
  cooldown_minutes integer      NOT NULL DEFAULT 60,
  notify_channels  jsonb        NOT NULL DEFAULT '["inapp"]'::jsonb,
  created_at       timestamptz  NOT NULL DEFAULT NOW(),
  updated_at       timestamptz  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ops_alert_rules_key_source_uniq
  ON ops_alert_rules (metric_key, source);


------------------------------------------------------------------------------
-- 6. ops_alerts — open / resolved breaches.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid,
  metric_key      varchar(120) NOT NULL,
  source          varchar(80)  NOT NULL,
  severity        varchar(8)   NOT NULL,  -- warn | crit
  value_num       numeric(20,4),
  threshold       numeric(20,4),
  message         text         NOT NULL,
  opened_at       timestamptz  NOT NULL DEFAULT NOW(),
  resolved_at     timestamptz,
  notified_at     timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  status          varchar(16)  NOT NULL DEFAULT 'open'  -- open | acknowledged | resolved
);

-- Dedup: at most one OPEN alert per (metric_key, source), so a metric sitting
-- on its threshold and flapping cannot spawn a new row every tick. Same trick
-- telemetry_alerts uses (E-049).
CREATE UNIQUE INDEX IF NOT EXISTS ops_alerts_open_uniq
  ON ops_alerts (metric_key, source) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS ops_alerts_opened_idx
  ON ops_alerts (opened_at DESC);
CREATE INDEX IF NOT EXISTS ops_alerts_status_opened_idx
  ON ops_alerts (status, opened_at DESC);


------------------------------------------------------------------------------
-- 7. Indexes on EXISTING tables that the Ops Console reads.
--
-- Both are additive, both fix a sequential scan that exists today, and both
-- are wrapped so this migration still applies on a database that predates the
-- table in question rather than aborting halfway through.
------------------------------------------------------------------------------

-- Every cost query in src/lib/campaigns/cost-analytics-query.ts filters on
-- ai_call_logs.ended_at, and the table has indexes on lead_id, call_id and
-- started_at but not on ended_at. The spend module makes those queries run on
-- a schedule rather than only when someone opens Cost Analytics.
DO $do$ BEGIN
  CREATE INDEX IF NOT EXISTS ai_call_logs_ended_at_idx
    ON ai_call_logs (ended_at);
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip ai_call_logs — table not present';
END; $do$;

-- The vendor-usage rollup groups kyc_verifications by api_provider, which has
-- no index today.
DO $do$ BEGIN
  CREATE INDEX IF NOT EXISTS kyc_verifications_api_provider_idx
    ON kyc_verifications (api_provider);
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip kyc_verifications — table not present';
END; $do$;


------------------------------------------------------------------------------
-- Column comments — these tables are read by people debugging an incident at
-- an unsociable hour, so the schema explains itself.
------------------------------------------------------------------------------
COMMENT ON TABLE  ops_metric_samples  IS 'E-210 — Ops Console raw time series. Pruned to 30 days; the daily rollup in ops_daily_snapshots is the permanent record.';
COMMENT ON TABLE  ops_daily_snapshots IS 'E-210 — Ops Console daily rollup. Never pruned. Source of the one-slide board and every trend chart.';
COMMENT ON TABLE  ops_collector_runs  IS 'E-210 — one row per collector invocation. The partial unique index on (collector_id) WHERE status = ''running'' is the single-flight lock.';
COMMENT ON TABLE  ops_log_events      IS 'E-210 — log lines forwarded by ops-agent. Pruned to 14 days. Grouped in the UI by fingerprint.';
COMMENT ON TABLE  ops_alert_rules     IS 'E-210 — editable thresholds. Seeded from registry defaults on first sight of a metric; hand edits are never overwritten.';
COMMENT ON TABLE  ops_alerts          IS 'E-210 — open/resolved threshold breaches. Partial unique on (metric_key, source) WHERE resolved_at IS NULL prevents duplicate rows from a flapping metric.';
