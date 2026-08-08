------------------------------------------------------------------------------
-- E-215 — Per-module CRM usage.
--
-- E-214 answers "is the CRM used, and by how many people". This answers "WHICH
-- PARTS of it". Both are licence-and-capacity questions: six modules were built
-- for six audiences, and nothing in the codebase can currently say whether
-- /asm is a daily tool or a page three people have ever opened.
--
-- Forward-referenced from src/lib/usage/track.ts (twice, at the heartbeat flag
-- and at the external-role early return). This file is what those comments
-- promised, and it keeps both promises literally.
--
--
-- THE HARD PART: DOING THIS WITHOUT STORING A PAGE PATH
--
-- E-214's header commits, in capitals, to storing "no URL or page path". Module
-- tracking is the first feature that appears to need one, so this is where that
-- promise either holds or quietly dies.
--
-- It holds, because a module is not a path. The browser maps its own location
-- to one of a CLOSED, SEVEN-VALUE allow-list (six modules + 'other') defined in
-- src/lib/usage/constants.ts, and sends the LABEL. The path never leaves the
-- tab. `/nbfc/applications/PL-2291/documents?tab=kyc` becomes the four letters
-- `nbfc` before anything is transmitted, and there is no column here that could
-- hold the rest even if a future caller tried to send it.
--
-- The distinction is not a technicality. A path column would record which
-- application, which dealer, which lead, which search — a behavioural log of
-- individual work. A label column records that somebody was in the NBFC module.
-- The first is a forensics table; the second answers the question that was
-- actually asked.
--
--
-- AGGREGATE ONLY — THERE IS NO user_id COLUMN, AND THAT IS THE DESIGN
--
-- These tables cannot answer "which modules does Priya use". Not by policy, not
-- by a guard someone could relax later, but because the column does not exist
-- and the write path never has anywhere to put it.
--
-- That was already promised. track.ts's external-role early return says their
-- "module usage is recorded in aggregate by E-215", and honouring it for
-- externals while quietly storing per-person rows for staff would have been the
-- worse half of both options. It also means E-215 adds NO new per-person read
-- surface: the /operations/usage read-audit and the 90/30-day retention in §8
-- of the runbook cover exactly what they covered before, unchanged.
--
-- What is lost is real and worth stating: nobody can ask "is the sales team
-- actually using inside-sales, or just the two managers". The aggregate says 14
-- sessions; it cannot say whether that is 14 people once or one person 14
-- times. Distinct-session counts are the compromise — see `sessions` below.
--
--
-- WHY role_bucket IS TWO VALUES AND NOT THE ROLE
--
-- The obvious schema is (day, module, role). It re-identifies by aggregation.
-- There is exactly ONE ceo. A row saying (2026-08-08, 'nbfc', 'ceo', sessions=1)
-- is a per-person record wearing an aggregate's clothes, and the same holds for
-- every role the company staffs with one person — business_head today, others
-- tomorrow, with nothing in the schema to notice when a role thins out to one.
--
-- So the bucket is `internal` | `external`, matching EXTERNAL_ROLES in track.ts.
-- Two values, both permanently populated by dozens of people. It still answers
-- the question that motivated including externals at all — "are dealers using
-- the dealer portal" — and it cannot degrade into a name as the org changes.
--
-- If per-role breakdown is ever genuinely needed, the honest way is a minimum
-- cohort size (suppress buckets below N), added additively with the suppression
-- enforced in SQL. Do not just widen this column.
------------------------------------------------------------------------------


------------------------------------------------------------------------------
-- 1. module_usage_daily — the durable table. Counters, permanently retained.
--
-- Permanent retention is safe here for the same reason ops_daily_snapshots is:
-- it names nobody and cannot be made to. The E-214 prunes exist because those
-- rows carry a user_id; there is nothing here to expire.
--
-- Grain is one row per (day, module, bucket) = at most 7 x 2 = 14 rows/day,
-- ~5k rows/year. The cost is not size, it is CHURN: ~60 staff on a 5-minute
-- heartbeat over a 9-hour day is ~6,500 pings/day landing as UPDATEs on those
-- 14 rows. Same shape as user_activity_sessions, same treatment at the bottom.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS module_usage_daily (
  -- IST, matching every other day boundary in the console (see daily.ts).
  day          date         NOT NULL,
  -- One of MODULES in src/lib/usage/constants.ts, or 'other'. Deliberately NOT
  -- constrained by a CHECK or an enum: an unknown label must land as 'other'
  -- and be visible, not rejected. A new module shipping before this list is
  -- updated should show up as a rising 'other' row — a hint to update the list,
  -- not a swallowed write and not a failed heartbeat.
  module       varchar(32)  NOT NULL,
  -- 'internal' | 'external'. See the header for why this is not the role.
  role_bucket  varchar(16)  NOT NULL,
  -- Heartbeats attributed to this module. At the 5-minute cadence each ping is
  -- ~5 minutes of presence, so pings * 300 is the module's engaged-seconds —
  -- the same arithmetic as engagedSeconds(), without the per-session cap, which
  -- has nothing to bound it here. Treat as a coarse share-of-attention figure,
  -- not a timesheet.
  pings        integer      NOT NULL DEFAULT 0,
  -- Distinct SESSIONS that touched this module today, deduped via
  -- module_visit_keys below. The closest honest proxy for "how many people",
  -- and it overcounts: one person across two devices is two sessions.
  sessions     integer      NOT NULL DEFAULT 0,
  created_at   timestamptz  NOT NULL DEFAULT NOW(),
  updated_at   timestamptz  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, module, role_bucket)
);

-- "the last 30 days, by module" — the only read shape the console uses. The PK
-- already leads on day, so this exists for the DESC ordering the page wants.
CREATE INDEX IF NOT EXISTS module_usage_daily_day_idx
  ON module_usage_daily (day DESC);


------------------------------------------------------------------------------
-- 2. module_visit_keys — transient dedupe so `sessions` can count distinctly.
--
-- Counting distinct sessions per module per day requires remembering which
-- sessions have already been counted. Storing session_id would have undone the
-- whole design: user_activity_sessions maps session_id -> user_id for 30 days,
-- so a plaintext session id here would be a per-person module log reachable by
-- one JOIN.
--
-- So the row is an md5 of (session_id, module, day) and nothing else. No user
-- id, no session id, no module in the clear, no timestamp beyond the day.
--
-- RESIDUAL EXPOSURE, stated rather than glossed: md5 over a known input space is
-- reversible by anyone who can already read user_activity_sessions, by
-- recomputing the hash for every live session x 7 modules. That is cheap. The
-- defence is not the hash, it is the two-day prune below — the join window is
-- 48 hours rather than the sessions table's 30 days — plus the fact that the
-- attacker in that scenario already has direct DB access. Do not describe this
-- column as anonymised to anyone; it is deduplication that declines to make
-- re-identification convenient.
--
-- Pruned by runDailySnapshot() at 2 days. Two, not one: the prune runs on an IST
-- day boundary and a session live across midnight must not have its key vanish
-- while it is still pinging, which would double-count it into the new day.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS module_visit_keys (
  -- md5(session_id || ':' || module || ':' || day) — 32 hex chars, computed in
  -- SQL by the write path so the plaintext never occupies a column.
  visit_key    char(32)     PRIMARY KEY,
  -- Kept in the clear ONLY so the prune can range-scan. Carries no information
  -- that the retention window does not already imply.
  day          date         NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT NOW()
);

-- The prune's index. Without it the daily DELETE seq-scans a table that exists
-- purely to be deleted from.
CREATE INDEX IF NOT EXISTS module_visit_keys_day_idx
  ON module_visit_keys (day);


------------------------------------------------------------------------------
-- 3. Storage parameters for the churning table.
--
-- Identical reasoning to user_activity_sessions in E-214: ~6,500 UPDATEs/day
-- against 14 live rows means every one of those rows is rewritten hundreds of
-- times a day, and at the default fillfactor of 100 each rewrite goes to a new
-- page. Left alone, a 14-row table bloats to megabytes and its index degrades.
--
-- fillfactor 70 (tighter than E-214's 80 — the update-to-row ratio here is two
-- orders of magnitude worse) leaves in-page room for HOT updates, and the
-- aggressive autovacuum thresholds are scaled for a table where "20% of rows
-- changed" is reached within seconds and is therefore useless as a trigger.
--
-- ALTER, not part of CREATE TABLE, so re-running this file fixes the parameters
-- on a database where the table was created before this block existed.
--
-- Drizzle cannot express storage parameters. Their absence from schema.ts is
-- expected and is NOT drift.
------------------------------------------------------------------------------
ALTER TABLE module_usage_daily SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 200,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 200
);


COMMENT ON TABLE module_usage_daily IS
  'E-215. Per-module usage counters, aggregate only — no user_id by design. '
  'Grain (day, module, role_bucket); role_bucket is internal|external, never '
  'the role, because single-holder roles would re-identify. Permanent.';

COMMENT ON TABLE module_visit_keys IS
  'E-215. Two-day dedupe so module_usage_daily.sessions counts distinct '
  'sessions. md5(session_id, module, day) — not anonymised, see the migration '
  'header. Pruned by runDailySnapshot().';
