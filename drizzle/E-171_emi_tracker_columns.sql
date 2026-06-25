-- E-171 — EMI Tracker: additive columns on emi_schedules
--
-- Adds the per-installment fields the automated EMI tracker needs: the rupee
-- amount due (the debit amount), a 1-based installment sequence, an optional
-- amortization split, debit telemetry, the winning payment ref, and the
-- collection channel. All additive + idempotent — safe to re-run.
--
-- Canonical emi_schedules.status set (no DB CHECK exists, documented only):
--   scheduled | overdue | missed | paid | paid_late | failed
--
-- Source of truth: this file. Mirrored in src/lib/db/schema.ts (emiSchedules).

ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS emi_seq integer;
ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS amount numeric(12,2);
ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS principal_component numeric(12,2);
ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS interest_component numeric(12,2);
ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS payment_ref varchar(64);
ALTER TABLE emi_schedules ADD COLUMN IF NOT EXISTS collection_mode varchar(16);

-- Cheap due-selection scan for the auto-debit/aging crons.
CREATE INDEX IF NOT EXISTS emi_schedules_status_due_idx
  ON emi_schedules (status, due_date);

-- Backfill the snapshot amount from the parent loan's EMI (idempotent — only
-- rows not yet populated).
UPDATE emi_schedules es
SET amount = ls.emi
FROM loan_sanctions ls
WHERE es.loan_sanction_id = ls.id
  AND es.amount IS NULL
  AND ls.emi IS NOT NULL;

-- Backfill emi_seq as the 1-based position of each installment ordered by
-- due_date within its loan (idempotent — only rows not yet populated).
WITH seq AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY loan_sanction_id
           ORDER BY due_date, created_at
         ) AS rn
  FROM emi_schedules
)
UPDATE emi_schedules es
SET emi_seq = seq.rn
FROM seq
WHERE es.id = seq.id
  AND es.emi_seq IS NULL;
