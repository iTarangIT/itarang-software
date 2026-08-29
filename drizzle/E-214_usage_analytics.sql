------------------------------------------------------------------------------
-- E-214 — CRM usage analytics storage.
--
-- The tables behind /operations/usage: how many people actually sign in, who,
-- how often, and (from Phase 2) how long they stay. None of this is derivable
-- from anything that exists today —
--
--   · nothing is written on login. The live login is a CLIENT component
--     (src/app/(auth)/login/page.tsx) calling supabase.auth.signInWithPassword()
--     in the browser; there is no server code path that runs once per sign-in.
--   · `users` has no last_login / last_seen / login_count column.
--   · ops_log_events has no user_id — it is forwarded pm2/nginx log lines.
--   · audit_logs only records ~53 instrumented WRITE endpoints, never logins,
--     reads or navigation.
--
-- The only existing signal is Supabase's own auth.users.last_sign_in_at, which
-- collectors/team.ts already buckets into AGGREGATE counts. That stays as it is.
--
--
-- WHAT THIS DELIBERATELY DOES NOT STORE
--
--   no IP address. no user-agent. no URL or page path. no referrer.
--   no failed-login attempts.
--
-- None of the metrics this feature exists for needs any of them, and each one
-- turns a usage table into a forensics table. That line is what makes the
-- retention promise below defensible to the people being measured. If security
-- ever needs a source IP for an "unexpected login location" check, it belongs
-- additively on user_login_events (where it answers a security question) and
-- NOT on the session table. Failed logins are a security feature with their own
-- threat model, not usage analytics.
--
--
-- WHY THIS REVERSES A DOCUMENTED DECISION, AND WHAT SURVIVES IT
--
-- src/lib/operations/collectors/team.ts rejected per-user tracking, for two
-- reasons. The first — a per-user sample has no MetricDef, so nothing could
-- render or alert on it — is still true, and this migration does not violate
-- it: NO per-person row is ever written to ops_metric_samples or
-- ops_daily_snapshots. The permanent record stays aggregate-only.
--
-- What changes is the second: rather than smuggling a per-employee activity log
-- into the metric series, it gets a purpose-built table with a stated retention
-- and a stricter read guard. The scope moves; the principle does not.
--
--   user_activity_sessions   30 days   (matches SAMPLE_RETENTION_DAYS)
--   user_login_events        90 days
--   ops_daily_snapshots      forever, but AGGREGATES ONLY
--
-- Both pruned by runDailySnapshot() in src/lib/operations/daily.ts — the same
-- ticker, no second scheduler.
--
-- Strictly additive. Creates no FK, drops nothing, changes no type.
-- Re-running this file is a no-op.
------------------------------------------------------------------------------


------------------------------------------------------------------------------
-- 1. user_login_events — one row per credential entry.
--
-- Append-only, never updated.
--
-- THIS IS NOT A VISIT COUNT. Supabase refresh tokens mean somebody who signed
-- in on Monday works all week without ever re-authenticating, so this number is
-- much smaller than daily-active-users and that is correct, not a bug. DAU/WAU/
-- MAU come from user_activity_sessions; the two answer different questions and
-- the UI must say which is which.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_login_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No FK, deliberately: matches audit_logs.performed_by. A departed employee's
  -- logins must still count toward historical aggregates rather than cascade
  -- away or block the row's deletion. Read with LEFT JOIN, as team.ts does.
  user_id       uuid         NOT NULL,
  -- Role AT THE TIME. A promotion must not retroactively rewrite history.
  role_at_login varchar(50),
  -- 'password' today. Reserved for 'sso' | 'magic_link' | 'impersonation'.
  method        varchar(24)  NOT NULL DEFAULT 'password',
  occurred_at   timestamptz  NOT NULL DEFAULT NOW(),
  created_at    timestamptz  NOT NULL DEFAULT NOW()
);

-- "logins in the last 24h/7d", and the prune.
CREATE INDEX IF NOT EXISTS user_login_events_occurred_idx
  ON user_login_events (occurred_at DESC);
-- Per-user history, and the 2-minute dedupe guard the write route runs on every
-- login: equality column first, ordered column second so neither needs a sort.
CREATE INDEX IF NOT EXISTS user_login_events_user_occurred_idx
  ON user_login_events (user_id, occurred_at DESC);


------------------------------------------------------------------------------
-- 2. user_activity_sessions — one row per session, UPDATED by each heartbeat.
--
-- NOT one row per ping. The arithmetic, at ~60 staff on a 5-minute heartbeat
-- over a 9-hour day:
--
--   row per ping    →  ~32,400 rows/day   ~1.0M/month  (at a 60s interval)
--   row per session →     ~120 rows/day    ~3.6k/month, plus 6,480 UPDATEs
--
-- The first would appear in the top-20 of db.table_bytes on /operations/database
-- within three weeks. The second is 0.075 writes/sec, which is noise against the
-- ~79 max_connections that db.connections_pct exists to police.
--
-- The real cost of UPDATE-in-place is dead tuples on a small hot table, which is
-- what the storage parameters at the bottom are for — not ignored, priced in.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_activity_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid         NOT NULL,
  -- Client-minted UUID held in localStorage (not sessionStorage — that is
  -- per-tab and would count one person with three tabs as three sessions).
  -- The UNIQUE below is what makes the heartbeat an idempotent upsert.
  session_id    uuid         NOT NULL,
  role_at_start varchar(50),
  started_at    timestamptz  NOT NULL DEFAULT NOW(),
  last_seen_at  timestamptz  NOT NULL DEFAULT NOW(),
  -- How many heartbeats landed. THE honest duration input:
  --   engaged_seconds = LEAST(ping_count * 300, span + 300)
  --   span_seconds    = last_seen_at - started_at
  -- A laptop that slept for three hours with a tab open produces 2 pings, so it
  -- reports 600s of engaged time and not 10,800s. The LEAST also stops a
  -- clock-skewed client inflating its own total by pinging rapidly.
  ping_count    integer      NOT NULL DEFAULT 1,
  created_at    timestamptz  NOT NULL DEFAULT NOW()
);

-- The upsert target. Without this the heartbeat would append.
CREATE UNIQUE INDEX IF NOT EXISTS user_activity_sessions_session_uniq
  ON user_activity_sessions (session_id);
-- "who is active now", DAU/WAU/MAU, and the prune.
CREATE INDEX IF NOT EXISTS user_activity_sessions_last_seen_idx
  ON user_activity_sessions (last_seen_at DESC);
-- Per-user session history.
CREATE INDEX IF NOT EXISTS user_activity_sessions_user_started_idx
  ON user_activity_sessions (user_id, started_at DESC);

-- Every heartbeat is an UPDATE, so this table churns dead tuples far faster than
-- its row count suggests. fillfactor leaves page room for HOT updates (which do
-- not rewrite the indexes); the autovacuum thresholds stop a ~150-row table
-- being vacuumed every 40 seconds under the defaults (threshold 50 + 20% scale).
--
-- Idempotent: re-running SET is a no-op. Has no Drizzle equivalent, so it does
-- not appear in the schema.ts mirror — that absence is expected, not drift.
DO $do$ BEGIN
  ALTER TABLE user_activity_sessions SET (
    fillfactor                      = 80,
    autovacuum_vacuum_scale_factor  = 0.05,
    autovacuum_vacuum_threshold     = 200,
    autovacuum_analyze_scale_factor = 0.10
  );
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'skip storage params — user_activity_sessions not present';
END; $do$;


------------------------------------------------------------------------------
-- 3. Table comments. The retention promise lives next to the data it governs.
------------------------------------------------------------------------------
DO $do$ BEGIN
  COMMENT ON TABLE user_login_events IS
    'E-214 - one row per credential entry. Pruned to 90 days by runDailySnapshot(). NOT a visit count: Supabase refresh tokens mean a signed-in user works for days without reappearing here. No IP, no user-agent, no failed attempts by design.';
  COMMENT ON TABLE user_activity_sessions IS
    'E-214 - one row per CRM session, UPDATED in place by the 5-minute heartbeat (never appended). Pruned to 30 days. engaged_seconds = LEAST(ping_count*300, span+300). No IP, no user-agent, no page paths by design.';
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip comments — tables not present';
END; $do$;
