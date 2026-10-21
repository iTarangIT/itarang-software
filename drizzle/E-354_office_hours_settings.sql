-- =============================================================================
-- E-354 — OFFICE HOURS AS A DATED ADMIN SETTING (tracker ID 85 #8, 18 Oct sheet row 40)
-- =============================================================================
-- WHY. The office calendar's working weekdays (Monday–Saturday) and office
-- hours (10:00–19:00 IST) were constants in code (src/lib/leads/workingHours.ts,
-- the `EXTRACT(DOW) <> 0` in src/lib/calendar/holidays.ts). Every working-hour
-- and working-day limit is counted on them, so changing them needed a deploy
-- and nobody could see which hours a past report used.
--
-- WHAT. One table, office_hours_settings, APPEND-ONLY like time_limit_settings
-- (E-337): one row per change — the IST day it takes effect, the opening and
-- closing hour, the working weekdays (0 = Sunday … 6 = Saturday), who set it
-- and why (required). The hours in force on day D are the latest row with
-- effective_from <= D; none = Monday–Saturday 10:00–19:00. The table IS the
-- change log Admin and the CEO read on Admin › Settings › Time limits.
--
-- Readers go through src/lib/calendar/officeHoursStore.ts behind a
-- to_regclass() probe, so code on a database without this file keeps the
-- Mon–Sat 10–19 rule and the Admin form answers "not set up". No seed row:
-- an empty table IS the default. Mirrored in schema.ts (officeHoursSettings);
-- nothing else reads it through Drizzle, so applying it late breaks nothing.
--
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS office_hours_settings (
    id                bigserial    PRIMARY KEY,
    effective_from    date         NOT NULL,
    start_hour        integer      NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
    end_hour          integer      NOT NULL CHECK (end_hour BETWEEN 1 AND 24),
    working_weekdays  integer[]    NOT NULL,
    note              text         NOT NULL,
    set_by            uuid,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT office_hours_settings_hours_chk CHECK (start_hour < end_hour),
    CONSTRAINT office_hours_settings_weekdays_chk
        CHECK (cardinality(working_weekdays) BETWEEN 1 AND 7 AND working_weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6])
);

CREATE INDEX IF NOT EXISTS office_hours_settings_effective_idx
    ON office_hours_settings (effective_from DESC, created_at DESC);

COMMENT ON TABLE office_hours_settings IS
    'E-354 (ID 85 #8) — append-only log of office-hours changes; hours in force on day D = latest row with effective_from <= D, else Mon–Sat 10:00–19:00 IST (src/lib/calendar/officeHours.ts).';
