-- =============================================================================
-- E-338 — REPORTING LINES WITH HISTORY (tracker ID 155, 2026-10-12)
-- =============================================================================
-- Requires E-335 (users.reports_to).
--
-- WHY. Business (8 Oct): a "Reports to" line has a start date, and changes are
-- kept as history "so past numbers stay with the manager of that time". E-335
-- stored only the current manager. A manager (anyone with people reporting to
-- them) now also sees the team's leads and may reassign leads within the team,
-- so who the team is must be recorded, dated and auditable.
--
-- WHAT. New table user_reporting_lines — one row per period a person reported
-- to a manager:
--
--   user_id         the person
--   manager_id      whom they reported to in that period
--   effective_from  first day of the period (date, India calendar day)
--   effective_to    first day they NO LONGER report to this manager
--                   (exclusive end); NULL = the current, open line
--   changed_by      who recorded it (NULL for the backfill)
--   reason          optional note
--
-- The line in force on day D is the row with effective_from <= D AND
-- (effective_to IS NULL OR effective_to > D). A line started and replaced on
-- the same day has effective_to = effective_from and never matches a day.
-- At most one open row per person (partial UNIQUE).
--
-- users.reports_to (E-335) stays the CURRENT manager and is kept in sync by
-- the writer (src/lib/users/reportingLines.ts setReportsTo): start dates are
-- today or earlier, so the open row and users.reports_to always agree.
--
-- BACKFILL. One open row per user whose users.reports_to is set and who has no
-- row yet, starting 2026-10-10 (the day E-335 shipped — no line can be older).
-- Re-running inserts nothing.
--
-- Mirrored in src/lib/db/schema.ts (userReportingLines). Readers use raw SQL
-- behind a to_regclass probe, so code on a database without this file keeps
-- the E-335 behaviour (current manager only, no history) — safe in either
-- order. Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_reporting_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manager_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    effective_from  date NOT NULL,
    effective_to    date,
    changed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    reason          text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_reporting_lines_not_self CHECK (manager_id <> user_id),
    CONSTRAINT user_reporting_lines_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_reporting_lines_one_open_uq
    ON user_reporting_lines (user_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS user_reporting_lines_manager_open_idx
    ON user_reporting_lines (manager_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS user_reporting_lines_user_from_idx
    ON user_reporting_lines (user_id, effective_from);

-- Backfill from E-335. Skipped (with a notice) on a database without
-- users.reports_to; dynamic SQL so the statement is not parsed there.
DO $do$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'reports_to'
    ) THEN
        EXECUTE $sql$
            INSERT INTO user_reporting_lines (user_id, manager_id, effective_from, reason)
            SELECT u.id, u.reports_to, DATE '2026-10-10', 'Backfilled from users.reports_to (E-338)'
            FROM users u
            WHERE u.reports_to IS NOT NULL
              AND u.reports_to <> u.id
              AND NOT EXISTS (SELECT 1 FROM user_reporting_lines l WHERE l.user_id = u.id)
        $sql$;
    ELSE
        RAISE NOTICE 'E-338: users.reports_to missing (apply E-335 first) — backfill skipped';
    END IF;
END;
$do$;

COMMENT ON TABLE user_reporting_lines IS
    'E-338 (ID 155) — dated history of who reports to whom. Open row (effective_to NULL) = current manager, kept equal to users.reports_to. effective_to is exclusive.';
