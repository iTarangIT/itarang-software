-- =============================================================================
-- E-335 — REPORTING LINES: who reports to whom (tracker ID 155, 2026-10-10)
-- =============================================================================
-- WHY. A manager's team view (ID 155: person picker, team total, team subtotal
-- in the daily Sales email) needs to know the team first. Today nothing in the
-- CRM says that two sales associates work under ASM Sonu.
--
-- WHAT. One nullable column on users:
--
--   users.reports_to uuid → users.id (ON DELETE SET NULL)
--
-- NULL = reports to nobody recorded. Set by Admin / CEO / Sales Head on
-- Settings › Reporting lines (PATCH /api/admin/reporting-lines), which refuses
-- a user reporting to themselves and any cycle (A → B → A). The CHECK below
-- backs the self rule in the database; cycles are checked in the route.
--
-- NOT USED FOR SCOPING YET. Nothing decides what a person may see from this
-- column; it is stored and shown only. Team views are the follow-up.
--
-- NOT mirrored in src/lib/db/schema.ts on purpose: users is read and written
-- through Drizzle all over the app (select().from(users), INSERT on sign-up),
-- and Drizzle names every schema column, so a mirrored column would break every
-- one of those on a database without this file. Readers use raw SQL behind a
-- has-column probe (src/lib/users/reportingLines.ts) and read "nobody" there.
--
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_to uuid;

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_reports_to_fkey') THEN
        ALTER TABLE users
            ADD CONSTRAINT users_reports_to_fkey
            FOREIGN KEY (reports_to) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_reports_to_not_self') THEN
        ALTER TABLE users
            ADD CONSTRAINT users_reports_to_not_self
            CHECK (reports_to IS NULL OR reports_to <> id);
    END IF;
END;
$do$;

CREATE INDEX IF NOT EXISTS users_reports_to_idx ON users (reports_to) WHERE reports_to IS NOT NULL;

COMMENT ON COLUMN users.reports_to IS
    'E-335 (ID 155) — the user this person reports to (their manager); NULL = none recorded. Set on Settings › Reporting lines. Stored and shown only — not used for access scoping yet.';
