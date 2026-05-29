-- E-117 — Widen score/alert loan_sanction_id references from uuid to varchar
--
-- borrower_risk_scores.loan_sanction_id and nbfc_risk_alerts.loan_sanction_id
-- were typed `uuid`, but loan_sanctions.id is varchar(255) and routinely holds
-- non-uuid identifiers (e.g. 'BAJAJ-LIVE-0001'). The uuid type made it
-- impossible to key a CDS score or a risk alert to such a loan, so the NBFC
-- Lead Intelligence "CDS Score" column and the Command Centre alert feed could
-- never resolve a borrower. This widens both columns to varchar(255).
--
-- Widening only — every uuid string fits varchar(255); this is NOT a narrowing.
-- Existing uuid values convert losslessly via ::text. No FK constraints exist
-- on either column. Idempotent: the type change is guarded, so re-running is a
-- no-op.

DO $do$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'borrower_risk_scores'
      AND column_name = 'loan_sanction_id'
  ) = 'uuid' THEN
    ALTER TABLE "borrower_risk_scores"
      ALTER COLUMN "loan_sanction_id" TYPE varchar(255)
      USING "loan_sanction_id"::text;
  END IF;

  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'nbfc_risk_alerts'
      AND column_name = 'loan_sanction_id'
  ) = 'uuid' THEN
    ALTER TABLE "nbfc_risk_alerts"
      ALTER COLUMN "loan_sanction_id" TYPE varchar(255)
      USING "loan_sanction_id"::text;
  END IF;
END
$do$;
