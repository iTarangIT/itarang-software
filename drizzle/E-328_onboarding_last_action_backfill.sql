-- =============================================================================
-- E-328 — DEALER ONBOARDING: recompute "last real action" (tracker ID 122, 2026-10-05)
-- =============================================================================
-- Requires E-327. DATA ONLY, no DDL.
--
-- WHY. E-327 keeps dealer_onboarding_applications.last_action_at correct from
-- now on. Existing rows still carry the old values: NULL (so the clock fell
-- back to an updated_at the agreement sweep kept rewriting) or the creation
-- time of an application made from a converted lead.
--
-- WHAT. For every application, last_action_at becomes the latest of the dates
-- that record a dealer or iTarang action:
--     created, submitted, correction requested, re-validated, agreement last
--     initiated, signed, agreement completed, dealer confirmed, approved,
--     rejected, the latest uploaded document, the latest correction round the
--     dealer submitted
--   + updated_at, ONLY for an application whose agreement was never initiated
--     (provider_document_id IS NULL). Nothing automated writes those rows —
--     the sweep and the cached-PDF routes need an initiated agreement — so
--     there updated_at is the wizard's own autosave and is a real action.
--
-- It never LOWERS a value: GREATEST with what is already there. So re-running
-- it after E-327 has been live is a no-op, and it cannot undo a date the
-- trigger recorded. Each timestamp is read through to_jsonb, so a column a
-- particular database lacks is skipped rather than failing the statement.
-- All values are `timestamp` (no zone) holding UTC, as the application writes
-- them; the one timestamptz column is converted to UTC explicitly.
--
-- EFFECT, to expect and to tell the team about: applications whose agreement
-- has been waiting on the dealer will now show their true age. Some will show
-- "stalled" for the first time, and some will enter the 21-day drop-out review
-- on the next page load. That is the fix, not a side effect.
--
-- Dry run first: scripts/verify-id122-onboarding-clock.ts prints how many rows
-- would move and by how much, and changes nothing.
-- =============================================================================

DO $do$
DECLARE
    moved integer;
BEGIN
    WITH facts AS (
        SELECT oa.id,
               GREATEST(
                   oa.created_at,
                   (j ->> 'submitted_at')::timestamp,
                   (j ->> 'correction_requested_at')::timestamp,
                   (j ->> 'revalidated_at')::timestamp,
                   (j ->> 'agreement_last_initiated_at')::timestamp,
                   (j ->> 'signed_at')::timestamp,
                   (j ->> 'agreement_completed_at')::timestamp,
                   ((j ->> 'dealer_confirmed_at')::timestamptz AT TIME ZONE 'UTC'),
                   (j ->> 'approved_at')::timestamp,
                   (j ->> 'rejected_at')::timestamp,
                   CASE WHEN oa.provider_document_id IS NULL THEN oa.updated_at END,
                   (SELECT max(d.uploaded_at)
                      FROM dealer_onboarding_documents d
                     WHERE d.application_id = oa.id),
                   (SELECT max(r.dealer_submitted_at)
                      FROM dealer_correction_rounds r
                     WHERE r.application_id = oa.id)
               ) AS real_action_at
          FROM dealer_onboarding_applications oa
         CROSS JOIN LATERAL to_jsonb(oa) AS j
    )
    UPDATE dealer_onboarding_applications oa
       SET last_action_at = GREATEST(oa.last_action_at, f.real_action_at)
      FROM facts f
     WHERE f.id = oa.id
       AND f.real_action_at IS NOT NULL
       AND (oa.last_action_at IS NULL OR oa.last_action_at < f.real_action_at);
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'E-328: last_action_at set on % application(s)', moved;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: an onboarding table does not exist';
END;
$do$;
