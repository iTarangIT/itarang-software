-- E-220: how a meeting happened — ground / calling / whatsapp.
--
-- WHY
--   The CEO "Meetings (MTD)" report splits meetings by mode. `lead_visits`
--   records that a meeting happened, who held it and what came of it, but has
--   no column saying HOW: all 15 existing columns are about scheduling,
--   outcome, photos and GPS. So a WhatsApp meeting and a doorstep visit are
--   indistinguishable once written, and WhatsApp meetings have nowhere to be
--   recorded at all.
--
-- WHY A COLUMN AND NOT A SEPARATE TABLE
--   A meeting is a meeting whatever the medium — same scheduling, same
--   outcome, same follow-up. Splitting by medium would fork every query that
--   asks "did we meet this dealer" and guarantee the two halves drift.
--
-- FREE TEXT, NO CHECK AND NO ENUM, per this table family's convention
--   (cf. E-202_dealer_type, E-218_expense_buckets). The vocabulary is fixed in
--   src/lib/admin/types.ts (MEETING_MODES) and enforced by zod at the write
--   path; a DB constraint would force a migration to add a mode, and ALTER TYPE
--   on a drifting shared DB is exactly what these conventions exist to avoid.
--
-- BACKFILL
--   Existing rows are set to 'ground'. That is not a guess: every row predates
--   any other mode being recordable, and the table carries gps_check_in_lat /
--   gps_check_in_lng — it was built for physical visits. Guarded by
--   `WHERE meeting_mode IS NULL` so re-running never overwrites a real value.
--
-- NOT REQUIRED to keep existing writes working: Drizzle names this column in
-- INSERTs, but it is nullable with a default, so an unapplied environment
-- degrades to every meeting reading as 'ground' rather than 500ing. The report
-- also catches undefined_column and falls back, so it renders either way.
--
-- Additive and idempotent — safe to re-run.

-- Note: E-219 is a code-only change (the CEO Realization dashboard) and
-- deliberately has no .sql file. The gap is not a lost migration.

ALTER TABLE lead_visits
  ADD COLUMN IF NOT EXISTS meeting_mode varchar(16) DEFAULT 'ground';

COMMENT ON COLUMN lead_visits.meeting_mode IS
  'E-220: how the meeting happened — ground | calling | whatsapp. Free text; '
  'vocabulary fixed in src/lib/admin/types.ts (MEETING_MODES).';

-- Backfill only what has never been set.
UPDATE lead_visits
   SET meeting_mode = 'ground'
 WHERE meeting_mode IS NULL;

-- Drives the Meetings (MTD) report: filtered by date, grouped by mode.
CREATE INDEX IF NOT EXISTS lead_visits_mode_date_idx
  ON lead_visits (meeting_mode, actual_visit_date);
