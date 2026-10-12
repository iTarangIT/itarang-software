-- =============================================================================
-- E-337 — TIME LIMITS AS DATED ADMIN SETTINGS + LEAD CLOCKS (tracker IDs 85, 86)
-- =============================================================================
-- WHY. Every time limit in the lead module (first attempt, field visit after a
-- transfer, idle bands, onboarding drop-out, …) was a constant in code, so a
-- change needed a deploy and nobody could see which value a past report used.
-- And nothing measured how fast a lead or a new owner was first attempted, so
-- the daily Sales email's "First attempt within limit" / "Time limits missed"
-- rows read "Not measured yet".
--
-- WHAT. Two tables, both read through to_regclass() guards (src/lib/timeLimits,
-- src/lib/leads/clocks), so code on a database without this file uses the code
-- defaults and shows no clocks:
--
--   time_limit_settings  APPEND-ONLY. One row per change: the limit, its value,
--                        the IST day it takes effect, who changed it and why.
--                        The value in force on day D is the latest row with
--                        effective_from <= D; none = the code default. The
--                        table IS the change log the CEO reads (ID 85: "every
--                        change logged; the CEO sees the log").
--
--   lead_clocks          Derived, rewritten by the hourly clock refresh
--                        (src/lib/leads/clocks.ts). One row per clock:
--                          lead      — from sales-ready to the first call or
--                                      visit by anyone
--                          owner     — from each assignment to the first call
--                                      or visit by THAT owner
--                          transfer  — from a move to Transferred_to_ASM to
--                                      the ASM's first visit
--                        with the limit in force when the clock started, when
--                        it fell due and, if missed, when it was passed (the
--                        "Limit passed" event). owner_inferred / start_inferred
--                        flag rows rebuilt from assigned_at / created_at
--                        because no history row exists (ID 86: back-filled,
--                        inferred owners flagged). Safe to TRUNCATE: the next
--                        refresh rebuilds it.
--
-- The ASM transfer-visit limit (ID 77.1, app_settings) moves into the new store
-- with its current value, dated the day it was last saved.
--
-- NOT mirrored in schema.ts on purpose (new tables, raw SQL readers behind a
-- has-table probe), so an unapplied migration breaks nothing.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS time_limit_settings (
    id              bigserial PRIMARY KEY,
    limit_key       varchar(60)    NOT NULL,
    value           numeric(10, 2) NOT NULL CHECK (value > 0),
    effective_from  date           NOT NULL,
    note            text,
    changed_by      uuid,
    changed_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS time_limit_settings_key_idx
    ON time_limit_settings (limit_key, effective_from DESC, changed_at DESC);

COMMENT ON TABLE time_limit_settings IS
    'E-337 (ID 85) — append-only log of time-limit changes; value in force on day D = latest row with effective_from <= D, else the code default (src/lib/timeLimits/registry.ts).';

-- ID 77.1's limit, carried over once with its current value.
INSERT INTO time_limit_settings (limit_key, value, effective_from, note, changed_by, changed_at)
SELECT 'asm_transfer_first_visit',
       (s.value ->> 'days')::numeric,
       (COALESCE(s.updated_at, now()) AT TIME ZONE 'Asia/Kolkata')::date,
       'Carried over from the ASM visit limit setting (E-337)',
       CASE WHEN (s.value ->> 'updated_by') ~ '^[0-9a-f-]{36}$' THEN (s.value ->> 'updated_by')::uuid END,
       COALESCE(s.updated_at, now())
  FROM app_settings s
 WHERE s.key = 'asm_transfer_visit_limit_days'
   AND (s.value ->> 'days') ~ '^[0-9]+$'
   AND (s.value ->> 'days')::int > 0
   AND NOT EXISTS (SELECT 1 FROM time_limit_settings t WHERE t.limit_key = 'asm_transfer_first_visit');

CREATE TABLE IF NOT EXISTS lead_clocks (
    id                       bigserial PRIMARY KEY,
    dealer_lead_id           text         NOT NULL,
    clock                    varchar(10)  NOT NULL CHECK (clock IN ('lead', 'owner', 'transfer')),
    owner_id                 text,
    owner_inferred           boolean      NOT NULL DEFAULT false,
    start_inferred           boolean      NOT NULL DEFAULT false,
    started_at               timestamptz  NOT NULL,
    ended_at                 timestamptz,
    first_attempt_at         timestamptz,
    first_attempt_kind       varchar(10),
    first_contact_at         timestamptz,
    attempt_working_minutes  integer,
    contact_working_minutes  integer,
    limit_key                varchar(60),
    limit_value              numeric(10, 2),
    due_at                   timestamptz,
    limit_passed_at          timestamptz,
    computed_at              timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_clocks_lead_clock_start_uniq
    ON lead_clocks (dealer_lead_id, clock, started_at);
CREATE INDEX IF NOT EXISTS lead_clocks_started_idx ON lead_clocks (clock, started_at);
CREATE INDEX IF NOT EXISTS lead_clocks_passed_idx
    ON lead_clocks (limit_passed_at) WHERE limit_passed_at IS NOT NULL;

COMMENT ON TABLE lead_clocks IS
    'E-337 (ID 86) — derived lead / owner / transfer clocks, rebuilt hourly by src/lib/leads/clocks.ts; limit_passed_at is the "Limit passed" event. Safe to truncate.';
