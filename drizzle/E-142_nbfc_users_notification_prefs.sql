-- E-142 — nbfc_users.notification_prefs
--
-- The per-user notification preferences column exists in src/lib/db/schema.ts
-- and is written by /api/nbfc/users/notification-prefs (the "My notification
-- preferences" card on /nbfc/settings), but it was never migrated to the DB,
-- so the UPDATE failed with `column "notification_prefs" does not exist`.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS with a NOT NULL default so
-- existing rows backfill to an empty object. Re-running is a no-op.

ALTER TABLE nbfc_users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
