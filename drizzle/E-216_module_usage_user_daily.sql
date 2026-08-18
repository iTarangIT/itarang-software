------------------------------------------------------------------------------
-- E-216 — Per-user module usage.
--
-- E-215 answers "WHICH PARTS of the CRM are used". This answers "BY WHOM".
--
--
-- THIS REVERSES E-215'S CENTRAL DECISION, DELIBERATELY
--
-- E-215's header states, in capitals, that module_usage_daily "has no user_id
-- column and cannot get one — that is the design", and that the absence is what
-- made counting EXTERNAL counterparties defensible at all. That reasoning was
-- sound and is not being dismissed here; it is being overruled by an explicit
-- product decision, recorded so nobody later reads this table as an oversight:
--
--   Requested 2026-08-17 by the operations owner, after the aggregate-only
--   drill-down was reviewed and judged insufficient. The question the business
--   needs answered is not "is /asm used" but "is ANIRUDH using /sales-head" —
--   a licence-allocation and adoption question about named accounts.
--
-- What that costs, stated plainly rather than buried:
--
--   · This is the first table in the codebase that records WHERE a named person
--     went inside the CRM. user_login_events records that they signed in;
--     user_activity_sessions records for how long. Neither says where.
--   · It covers EXTERNAL accounts — dealers and NBFC partners — who are
--     business counterparties under different terms from employees, not staff.
--     E-215 included them in aggregate precisely BECAUSE the aggregate could
--     not name them. That protection is gone here.
--   · The staff/partner notice is therefore a real prerequisite, not a
--     formality. /operations/usage carries a standing notice; it must be
--     updated to say module usage is now per-person before this is enabled
--     anywhere people are unaware of it.
--
-- Mitigations carried over from E-214's conventions rather than invented:
--   · 30-day retention, pruned by runDailySnapshot() — matching
--     user_activity_sessions, NOT the aggregate's permanent retention.
--   · Read-audited via recordUsageView(), like the login history.
--   · Still no path, no query string, no IP, no user-agent, no timestamp finer
--     than the IST day. The module label remains a closed allow-list value, so
--     this says "Anirudh was in sales-head on the 17th", never which record he
--     opened.
--
--
-- module_usage_daily IS KEPT, UNCHANGED
--
-- Not superseded, and not to be dropped later "because this one has more
-- detail". It survives the 30-day prune and is the only thing that can answer a
-- question about last quarter. The two are written in ONE statement so they
-- cannot disagree; see recordModuleUsage() in src/lib/usage/track.ts.
--
--
-- HISTORY CANNOT BE BACK-ATTRIBUTED
--
-- There is no backfill and there cannot be one. The user->module relationship
-- was never stored, so nothing existing can be mined for it. In particular
-- module_visit_keys must NOT be used: it holds md5(session_id, module, day) and
-- resolves only to the session's OWNER, which on live data was wrong for every
-- row tested (6 of 6), because external users get no session row at all and
-- internal users had theirs rejected by the ownership guard. Attribution starts
-- the day this is applied. Every row written before then stays aggregate.
------------------------------------------------------------------------------


------------------------------------------------------------------------------
-- 1. module_usage_user_daily
--
-- Grain is one row per (day, module, user). At ~60 staff x maybe 3 modules each
-- that is ~180 rows/day, ~5.5k live at any time under the 30-day prune — small,
-- but it churns like its aggregate sibling (one UPDATE per heartbeat), so it
-- gets the same storage treatment at the bottom of this file.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS module_usage_user_daily (
  -- IST, matching module_usage_daily and every other day boundary in the
  -- console (see daily.ts). Joining the two on `day` therefore needs no
  -- conversion.
  day           date         NOT NULL,

  -- One of MODULES in src/lib/usage/constants.ts, or 'other'. No CHECK, for the
  -- same reason as E-215: an unknown label must land as 'other' and stay
  -- visible rather than fail somebody's heartbeat. normaliseModule() enforces
  -- the allow-list.
  module        varchar(32)  NOT NULL,

  -- No FK to users, matching the audit_logs / user_login_events convention: a
  -- departed employee's history must neither cascade away nor block the delete.
  user_id       uuid         NOT NULL,

  -- The role AS IT WAS AT PING TIME. Deliberately stored rather than joined
  -- from users.role at read time: a promotion or a role correction must not
  -- silently rewrite last month's attribution into something that never
  -- happened. Nullable because requireAuth() can return a user whose role has
  -- not resolved.
  role_at_ping  varchar(48),

  -- internal | external. STORED, not derived at read time. EXTERNAL_ROLES is a
  -- TypeScript set that can change; a derived bucket would then silently
  -- disagree with the module_usage_daily rows written under the old rule, and
  -- the two tables would stop being comparable with nothing to notice it.
  role_bucket   varchar(16)  NOT NULL,

  -- Heartbeats attributed to this person on this module on this day. Multiply
  -- by HEARTBEAT_SECONDS for time; it is a 5-minute sample, not a timesheet.
  pings         integer      NOT NULL DEFAULT 0,

  -- Distinct sessions, counted via the existing module_visit_keys dedupe.
  sessions      integer      NOT NULL DEFAULT 0,

  -- E-216 also fixes the counter-inflation bug E-215 shipped with:
  -- recordModuleUsage() had no equivalent of recordHeartbeat's 240-second
  -- guard, so module time ran ~12.5% ahead of "Time in CRM" on measured data
  -- (63 module pings against 56 accepted session pings). This column is the
  -- anchor that guard needs, and because the aggregate's increment is now
  -- conditional on this row accepting the ping, BOTH tables are protected by
  -- one rule. 240s is 80% of the 300s cadence — ordinary timer drift always
  -- passes, a client looping at 1Hz gets one increment per four minutes.
  last_ping_at  timestamptz  NOT NULL DEFAULT NOW(),

  created_at    timestamptz  NOT NULL DEFAULT NOW(),
  updated_at    timestamptz  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (day, module, user_id)
);

-- The prune's index (30-day DELETE by day).
CREATE INDEX IF NOT EXISTS module_usage_user_daily_day_idx
  ON module_usage_user_daily (day);

-- The drill-down's index: one module, newest days first.
CREATE INDEX IF NOT EXISTS module_usage_user_daily_module_idx
  ON module_usage_user_daily (module, day DESC);

-- Per-person history for one account, across modules.
CREATE INDEX IF NOT EXISTS module_usage_user_daily_user_idx
  ON module_usage_user_daily (user_id, day DESC);


------------------------------------------------------------------------------
-- 2. Storage parameters for the churning table.
--
-- Same shape and same reasoning as module_usage_daily and
-- user_activity_sessions: every heartbeat is an UPDATE, so dead tuples
-- accumulate far faster than the row count suggests. fillfactor leaves page
-- room for HOT updates; the autovacuum thresholds stop a small table waiting
-- for a percentage-based trigger it would take days to reach.
--
-- Drizzle cannot express these, so their absence from schema.ts is EXPECTED and
-- is not drift.
------------------------------------------------------------------------------
DO $do$
BEGIN
  ALTER TABLE module_usage_user_daily SET (
    fillfactor                      = 70,
    autovacuum_vacuum_scale_factor  = 0.0,
    autovacuum_vacuum_threshold     = 200,
    autovacuum_analyze_scale_factor = 0.0,
    autovacuum_analyze_threshold    = 200
  );
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'module_usage_user_daily missing - skipping storage params';
END;
$do$;


COMMENT ON TABLE module_usage_user_daily IS
  'E-216 - per-user module usage, grain (day, module, user_id). Pruned to 30 days by runDailySnapshot(); read-audited via recordUsageView(). Stores no path, query, IP, user-agent, or sub-day timestamp. Reverses E-215 no-user_id by explicit product decision - see the migration header. History before this migration cannot be attributed and must not be reconstructed from module_visit_keys.';
