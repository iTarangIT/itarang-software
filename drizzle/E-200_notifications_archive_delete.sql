-- E-200_notifications_archive_delete.sql
-- (Renumbered from E-199 — that slot was taken by E-199_nbfc_risk_card_visibility on main.)
--
-- Soft-archive + soft-delete timestamps on the CRM-wide `notifications` table,
-- so the buyback notification centre (items 12/13) can offer Archive and Delete
-- without destroying the row — the same escalation-safety reasoning that keeps
-- the buyback bell's mark-all-read scoped: a deleted notification is hidden, not
-- lost, and the audit trail survives.
--
-- MODEL: NULL archived_at = active (shown in the main feed); NULL deleted_at =
-- not deleted. So NO backfill is needed — every one of the ~997 existing rows is
-- active and undeleted by the NULL default.
--
-- Additive + idempotent (re-running is a safe no-op).
--
-- APPLIES EVERYWHERE INCLUDING PROD: unlike the buyback tables, `notifications`
-- exists on every environment (it is the whole CRM's bell). No table guard is
-- needed. Mirrored in src/lib/db/schema.ts so `db:push` users don't drop these.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;

-- The buyback feed reads `WHERE user_id = ? AND type LIKE 'buyback.%' AND
-- deleted_at IS NULL` on every poll (three roles × N open tabs). This partial
-- index keeps that scan cheap as the table grows past its current ~997 rows.
CREATE INDEX IF NOT EXISTS notifications_user_active_idx
  ON notifications (user_id)
  WHERE deleted_at IS NULL;
