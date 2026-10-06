-- E-329 — the salesperson on a dealer onboarding, as a CRM user (tracker ID 66,
-- handover P1-3, decided 29 Sep 2026).
--
-- Until now the onboarding stored the sales manager as three typed text fields
-- (sales_manager_name / _email / _mobile). Many are blank, and typed text
-- cannot credit anyone in a report or own an account.
--
--   dealer_onboarding_applications.salesperson_user_id
--       users.id of an active ISR / ASM / Sales Head, picked from a dropdown.
--       Approval is blocked until it is set; Admin can set it at verification.
--
-- The three typed columns STAY and keep being filled (from the picked user's
-- row), because the agreement template, the notification emails and the
-- exports read them. Existing rows are not backfilled: a person picks the
-- salesperson, the system never guesses (spec ID 65, "No automatic assignment").
--
-- DDL: additive + idempotent. Mirrored in schema.ts. Re-run = no-op.

DO $do$
BEGIN
    ALTER TABLE dealer_onboarding_applications
        ADD COLUMN IF NOT EXISTS salesperson_user_id uuid;

    CREATE INDEX IF NOT EXISTS dealer_onboarding_applications_salesperson_idx
        ON dealer_onboarding_applications (salesperson_user_id)
        WHERE salesperson_user_id IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-321: dealer_onboarding_applications does not exist — skip';
END;
$do$;
