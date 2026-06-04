-- E-156 — Fix Field Investigation re-inspection insert failure (§10.10).
--
-- ROOT CAUSE: the per-ATTEMPT FI model (one row per attempt per lead × NBFC)
-- needs a PARTIAL unique index that only constrains the single CURRENT attempt:
--   UNIQUE (lead_id, nbfc_id) WHERE is_current
-- That index swap shipped in E-148, but E-148 sits above the migration-lag
-- boundary (~E-145) and never reached this database. The per-attempt COLUMNS
-- (is_current, attempt_no, …) did land — they were added separately by E-141 —
-- so `assign` (which UPDATEs in place) works, but `reinspect` (which INSERTs a
-- SECOND row for the same lead × NBFC) violates the ORIGINAL full unique index
-- "field_investigations_lead_nbfc_unique" (E-136) that is still present.
--
-- This migration re-applies ONLY E-148's index swap, idempotently. Safe to run
-- repeatedly. The old full index guarantees ≤1 row per (lead_id, nbfc_id) today,
-- so at most one is_current row exists per pair — the partial unique index
-- builds without conflict.

DO $do$ BEGIN
  -- Replace the full (lead_id, nbfc_id) unique with a PARTIAL unique that only
  -- constrains the operative attempt. E-136 created it as a plain CREATE UNIQUE
  -- INDEX, but a past db:push may have re-materialised it as a table CONSTRAINT.
  -- DROP INDEX cannot remove a constraint and DROP CONSTRAINT cannot remove a
  -- plain index, so attempt BOTH forms — whichever exists is cleared.
  ALTER TABLE "field_investigations" DROP CONSTRAINT IF EXISTS "field_investigations_lead_nbfc_unique";
  DROP INDEX IF EXISTS "field_investigations_lead_nbfc_unique";
  CREATE UNIQUE INDEX IF NOT EXISTS "field_investigations_current_unique"
    ON "field_investigations" ("lead_id", "nbfc_id")
    WHERE "is_current";
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip: field_investigations table absent';
END; $do$;
