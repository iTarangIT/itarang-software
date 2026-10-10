-- =============================================================================
-- E-333 — DEALER LEADS: Undo Mark Won + Change Lost reason, replacing
--         "Correct status" (tracker IDs 80, 134, 136 — 2026-10-09)
-- =============================================================================
-- WHY. On 3 Oct business removed "Correct status" (ID 136): no person picks a
-- lead's status by hand. What it was used for gets its own action instead:
--
--   * a Won marked by mistake  → Undo Mark Won (ID 134): the rep requests it,
--     the Sales Head approves, only while the dealer has not submitted
--     onboarding. The lead returns to the stage it was at before Won, with the
--     same owner; the empty onboarding application is withdrawn; the Won stops
--     counting anywhere.
--   * a wrong Lost reason      → Change Lost reason (no DDL — it rewrites
--     dealer_leads.lost_reason and writes an old → new history row).
--   * a wrong Lost             → Reactivate (exists).
--
-- WHAT CHANGED (additive only):
--
--   lead_won_undo_requests                     new table — one row per request
--   dealer_lead_status_history.won_undone_at   set on the Mark Won row an undo
--                                              reversed; Won counters skip it
--   dealer_onboarding_applications.withdrawn_at / withdrawn_reason
--                                              the undo withdraws the draft
--                                              application ('withdrawn')
--
-- None of these columns is in schema.ts: Drizzle names every schema column in
-- its INSERTs, so adding them there would break every status write on a DB
-- without this file. Readers go through to_jsonb(...) and behave as before on
-- such a DB; only the undo itself needs the migration (it answers 503).
--
-- Idempotent: every statement is IF NOT EXISTS. Re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_won_undo_requests (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dealer_lead_id             text        NOT NULL,
    -- The status-history row of the Mark Won being undone.
    won_history_id             uuid,
    -- The stage the lead goes back to (that row's from_status).
    restore_status             varchar(50),
    onboarding_application_id  uuid,
    -- pending | approved | rejected | cancelled
    status                     varchar(16) NOT NULL DEFAULT 'pending',
    requested_by               text        NOT NULL,
    requested_at               timestamptz NOT NULL DEFAULT now(),
    request_reason             text        NOT NULL,
    decided_by                 text,
    decided_at                 timestamptz,
    decision_note              text
);

-- One open request per lead.
CREATE UNIQUE INDEX IF NOT EXISTS lead_won_undo_requests_one_pending_idx
    ON lead_won_undo_requests (dealer_lead_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS lead_won_undo_requests_decided_idx
    ON lead_won_undo_requests (status, decided_at);

DO $do$
BEGIN
    ALTER TABLE dealer_lead_status_history
        ADD COLUMN IF NOT EXISTS won_undone_at timestamptz;
EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'E-333 skip: dealer_lead_status_history does not exist';
END;
$do$;

DO $do$
BEGIN
    ALTER TABLE dealer_onboarding_applications
        ADD COLUMN IF NOT EXISTS withdrawn_at     timestamptz,
        ADD COLUMN IF NOT EXISTS withdrawn_reason text;
EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'E-333 skip: dealer_onboarding_applications does not exist';
END;
$do$;

-- Verify:
--   SELECT to_regclass('lead_won_undo_requests');
--   SELECT column_name FROM information_schema.columns
--    WHERE (table_name, column_name) IN (('dealer_lead_status_history','won_undone_at'),
--          ('dealer_onboarding_applications','withdrawn_at'),
--          ('dealer_onboarding_applications','withdrawn_reason'));
