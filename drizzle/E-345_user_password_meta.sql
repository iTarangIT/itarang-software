-- =============================================================================
-- E-345 — WHEN EACH PASSWORD WAS LAST CHANGED (A39, 13 Oct call)
-- =============================================================================
-- WHY. Passwords were shared and never changed, so an ex-employee could log in
-- and download data. Proposed answer (13 Oct): deactivate leavers, force every
-- user to change password at next login (must_change_password, all roles),
-- 90-day expiry, log every download with the user's name. The expiry needs to
-- know when a password was last set; nothing recorded it.
--
-- WHAT. One row per user: password_changed_at, written by every path that
-- sets a password (/api/auth/change-password, its OTP confirm, reset-password)
-- and by scripts/force-password-change-all.ts (which starts the clock).
-- A user with no row has no expiry yet: the clock starts at their next change.
-- A separate table, not a users column, so the users table (read by every
-- request, Drizzle names every column) needs no migration to keep working.
--
-- NOT mirrored in schema.ts (raw SQL behind a to_regclass probe in
-- src/lib/auth/passwordMeta.ts): without it, no expiry is enforced.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_password_meta (
    user_id              text        PRIMARY KEY,
    password_changed_at  timestamptz NOT NULL,
    forced_by            text,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_password_meta IS
    'E-345 (A39) — when each user last set their password; the 90-day expiry reads it. No row = no expiry yet.';
