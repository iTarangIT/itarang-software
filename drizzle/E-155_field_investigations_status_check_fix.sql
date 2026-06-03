-- E-155 — Repair the field_investigations status CHECK on environments where
-- E-148's status-check block never took (prod still carried E-136's original
-- 6-state CHECK: not_applicable/pending/assigned/in_progress/completed/failed).
--
-- The FI agent submit handler writes status='submitted', and the Coordinator
-- decision writes 'passed' / 're_inspection_requested' — none of which the stale
-- constraint allowed, so every field-form Submit failed with a CHECK violation
-- (surfaced to the agent as "Server error while saving the visit").
--
-- The new value set is a strict SUPERSET of the old one, so every existing row
-- already satisfies it — the ADD cannot fail on legacy data. Idempotent: drop
-- the constraint if present, then add the widened version.

DO $do$ BEGIN
  ALTER TABLE "field_investigations" DROP CONSTRAINT IF EXISTS "field_investigations_status_check";
  ALTER TABLE "field_investigations"
    ADD CONSTRAINT "field_investigations_status_check"
    CHECK ("status" IN (
      'not_applicable', 'pending', 'assigned', 'in_progress',
      'submitted', 'passed', 'failed', 're_inspection_requested',
      'completed'  -- legacy (E-136), kept transitional
    ));
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip: field_investigations table absent';
END; $do$;
