-- =============================================================================
-- E-350 — FIXED "LIMIT PASSED" RECORDS, HOT / RETRY / QUOTE CLOCKS, HOLIDAY LOG
--          (tracker IDs 85, 86 — 15 Oct rework)
-- =============================================================================
-- Requires E-337 (lead_clocks). Every block is guarded, so on a database
-- without E-337 this file only creates the holiday log.
--
-- WHY.
--   * "Limit passed" was a column of lead_clocks, which is rebuilt every hour:
--     a later call, a moved holiday or an edited history could make a miss
--     disappear. The decision is a fixed record on the day it happened.
--   * The 15 Oct check asks for new clocks: a Hot lead waiting for an owner
--     (9 office hours), a fresh 4-hour clock when a lead turns Hot, retries
--     after an unanswered call, and the CEO's 4-hour quote approval. The
--     lead_clocks.clock CHECK only allowed lead / owner / transfer.
--   * Holiday changes were not logged, and adding a past holiday rewrote past
--     results.
--
-- WHAT.
--   1. lead_clocks.clock CHECK widened to the seven kinds (dropped and re-added
--      with the larger list — it only ever accepts MORE values).
--   2. lead_limit_events — one row per missed limit, written once by the hourly
--      clock refresh (INSERT … ON CONFLICT DO NOTHING) and never updated:
--      the owner charged is the owner at the moment it fell due;
--      owner_inferred marks misses whose owner is not on record (before
--      10 Sep 2026, E-295) — left out of per-person counts. NOT back-filled
--      here: the first clock refresh after this file (scripts/refresh-lead-clocks.ts,
--      or the hourly ticker) records every miss so far under the new rules —
--      a copy of the old lead_clocks rows would charge lead-clock misses to
--      today's owner, the bug this file fixes.
--   3. holiday_calendar_log — every add / remove / rename of a holiday, with
--      who and when. The clocks read it so a holiday counts only for clocks
--      still running when it was added (src/lib/calendar/holidays.ts).
--      Holidays that exist before this file have no log row and count for
--      every clock, as before.
--
-- NOT mirrored in schema.ts: raw SQL readers behind to_regclass probes
-- (src/lib/leads/clocks.ts, src/lib/leads/limitEvents.ts), so code on a
-- database without this file keeps the E-337 behaviour.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

-- 1. Wider CHECK on lead_clocks.clock ----------------------------------------
DO $do$
BEGIN
    IF to_regclass('public.lead_clocks') IS NULL THEN
        RAISE NOTICE 'E-350: lead_clocks missing (E-337 not applied) — skipping the clock CHECK';
        RETURN;
    END IF;
    ALTER TABLE lead_clocks DROP CONSTRAINT IF EXISTS lead_clocks_clock_check;
    ALTER TABLE lead_clocks ADD CONSTRAINT lead_clocks_clock_check
        CHECK (clock IN ('lead', 'owner', 'transfer', 'hot_assign', 'hot_owner', 'retry', 'quote'));
END;
$do$;

-- 2. Fixed "Limit passed" records ---------------------------------------------
CREATE TABLE IF NOT EXISTS lead_limit_events (
    id              bigserial PRIMARY KEY,
    dealer_lead_id  text          NOT NULL,
    clock           varchar(10)   NOT NULL,
    clock_started_at timestamptz  NOT NULL,
    limit_key       varchar(60)   NOT NULL,
    limit_value     numeric(10, 2) NOT NULL,
    limit_unit      varchar(20)   NOT NULL,
    passed_at       timestamptz   NOT NULL,
    owner_id        text,
    owner_inferred  boolean       NOT NULL DEFAULT false,
    recorded_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_limit_events_clock_uniq
    ON lead_limit_events (dealer_lead_id, clock, clock_started_at);
CREATE INDEX IF NOT EXISTS lead_limit_events_passed_idx ON lead_limit_events (passed_at);
CREATE INDEX IF NOT EXISTS lead_limit_events_owner_idx ON lead_limit_events (owner_id, passed_at) WHERE owner_inferred = false;
CREATE INDEX IF NOT EXISTS lead_limit_events_lead_idx ON lead_limit_events (dealer_lead_id, passed_at);

COMMENT ON TABLE lead_limit_events IS
    'E-350 (IDs 85/86) — one fixed row per missed time limit, written once by the hourly clock refresh and never changed. owner_id = owner when it fell due; owner_inferred rows stay out of per-person counts.';

-- 3. Holiday change log -------------------------------------------------------
CREATE TABLE IF NOT EXISTS holiday_calendar_log (
    id            bigserial PRIMARY KEY,
    holiday_date  date          NOT NULL,
    action        varchar(12)   NOT NULL CHECK (action IN ('add', 'remove', 'rename')),
    holiday_name  varchar(200),
    note          text,
    changed_by    text,
    changed_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS holiday_calendar_log_date_idx ON holiday_calendar_log (holiday_date, changed_at);
CREATE INDEX IF NOT EXISTS holiday_calendar_log_changed_idx ON holiday_calendar_log (changed_at DESC);

COMMENT ON TABLE holiday_calendar_log IS
    'E-350 (ID 85) — every holiday add / remove / rename. A holiday counts for a clock only if it was on the calendar when the clock stopped; holidays with no log row count always.';
