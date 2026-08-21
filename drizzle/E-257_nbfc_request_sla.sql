------------------------------------------------------------------------------
-- E-257: NBFC request SLA — time-boxed auto-routing of the NBFC ⇄ Admin ⇄
--        Dealer document-request loop.
--
-- WHAT THIS ADDS, AND WHY.
--
-- An NBFC correction / additional-document request (an nbfc_doc_requests
-- wrapper born 'nbfc_raised', or a nbfc_document_verifications verdict of
-- 'queried' / 'rejected') lands on the admin KYC-review "NBFC Actions" card and
-- waits for a human to click "Forward to dealer". Once the dealer has uploaded
-- everything, the wrapper sits at 'admin_review_upload' waiting for a human to
-- verify each child before it can be pushed back to the NBFC. The business
-- wants the admin to be the middle-man for a configurable window ONLY:
--
--   leg 1  NBFC → admin → dealer : if no admin action within the window, the
--          system forwards the request to the dealer, relaying the NBFC's own
--          comments verbatim as the dealer-facing reason.
--   leg 2  dealer → admin → NBFC : if no admin verdict within the window, the
--          system marks the uploaded children verified (review_source =
--          'system', E-246 vocabulary) and pushes the request to the NBFC.
--
-- ONE CLOCK COLUMN PER ROW. `sla_due_at` is the deadline of the CURRENT leg;
-- which leg is implied by `status` ('nbfc_raised' → forward clock,
-- 'admin_review_upload' → push clock). It is stamped when a row ENTERS a leg
-- and NULLed by whichever actor leaves it — an admin click or the sweep's claim
-- (UPDATE … SET sla_due_at = NULL … FOR UPDATE SKIP LOCKED), which is what
-- makes an expired deadline act exactly once and never retry a failed action.
--
-- WHY `*_source` COLUMNS. Every actor column touched by the sweep is already
-- nullable (other_document_requests.requested_by / reviewed_by,
-- nbfc_doc_requests.reviewed_by, nbfc_document_verifications.forwarded_by), so
-- a system action leaves the uuid NULL — but NULL is ambiguous, so an explicit
-- 'admin' | 'system' discriminator records who forwarded / pushed. Same
-- precedent as E-246 (review_source) and buyback_activity_log.role. Defaulting
-- to 'admin' makes every pre-existing row read as human-actioned, which it was.
--
-- NO BACKFILL, ON PURPOSE. sla_due_at stays NULL on every existing open
-- request and the sweep ignores NULL, so requests raised before this ships (or
-- while the feature is off) never retro-auto-route. Turning the feature on
-- affects only requests raised / uploads received after it was turned on.
--
-- REQUIRED BEFORE THE CODE DEPLOYS. Both tables are mirrored in schema.ts and
-- read with a bare db.select() (listThreadForLead, GET /api/admin/nbfc-requests)
-- — drizzle names every mirrored column, so on a database without this file
-- the admin NBFC Actions card AND the NBFC Acquire request thread fail with
-- `column "sla_due_at" does not exist`. The automation itself stays inert:
-- app_settings key 'nbfc_request_sla' ships with enabled=false.
--
-- Additive and idempotent — safe to re-run.
------------------------------------------------------------------------------

BEGIN;

-- 1. The wrapper: clock, provenance, sweep bookkeeping, structured items -------
DO $do$ BEGIN
    ALTER TABLE nbfc_doc_requests
        ADD COLUMN IF NOT EXISTS sla_due_at        timestamptz,
        ADD COLUMN IF NOT EXISTS forward_source    varchar(16) DEFAULT 'admin',
        ADD COLUMN IF NOT EXISTS push_source       varchar(16) DEFAULT 'admin',
        ADD COLUMN IF NOT EXISTS auto_forwarded_at timestamptz,
        ADD COLUMN IF NOT EXISTS auto_pushed_at    timestamptz,
        ADD COLUMN IF NOT EXISTS sla_failure       text,
        ADD COLUMN IF NOT EXISTS requested_items   jsonb DEFAULT '[]'::jsonb;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: nbfc_doc_requests does not exist';
END; $do$;

-- 2. The per-document verdict: clock + provenance ------------------------------
DO $do$ BEGIN
    ALTER TABLE nbfc_document_verifications
        ADD COLUMN IF NOT EXISTS sla_due_at     timestamptz,
        ADD COLUMN IF NOT EXISTS forward_source varchar(16) DEFAULT 'admin',
        ADD COLUMN IF NOT EXISTS sla_failure    text;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: nbfc_document_verifications does not exist';
END; $do$;

-- 3. Keep the 60s sweep off a sequential scan ---------------------------------
-- PARTIAL on purpose: only rows carrying a live clock are ever candidates, and
-- that is a vanishing fraction of the table. Drizzle's index builder has no
-- WHERE clause, so these indexes are migration-only and must never be
-- "re-created" from schema.ts.
DO $do$ BEGIN
    CREATE INDEX IF NOT EXISTS nbfc_doc_requests_sla_due_idx
        ON nbfc_doc_requests (sla_due_at)
        WHERE sla_due_at IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: nbfc_doc_requests does not exist';
END; $do$;

DO $do$ BEGIN
    CREATE INDEX IF NOT EXISTS nbfc_document_verifications_sla_due_idx
        ON nbfc_document_verifications (sla_due_at)
        WHERE sla_due_at IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: nbfc_document_verifications does not exist';
END; $do$;

-- 4. Self-documentation --------------------------------------------------------
-- No CHECK constraints on the vocabulary columns (E-246 convention): enforced
-- in the service layer, recorded here.
DO $do$ BEGIN
    EXECUTE $c$COMMENT ON COLUMN nbfc_doc_requests.sla_due_at IS
        'E-257. Deadline of the CURRENT leg of the NBFC request SLA: on status ''nbfc_raised'' it is when the sweep may auto-forward to the dealer; on ''admin_review_upload'' it is when the sweep may auto-verify the uploads and push to the NBFC. Stamped on entering the leg (createNbfcDocRequest / recomputeWrapperStatus) from app_settings.nbfc_request_sla; NULLed by any admin action or by the sweep''s claim. NULL = no clock — the state of every row that predates E-257 or entered the leg while the feature was off. Never backfill.'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_doc_requests.forward_source IS
        'E-257. Who forwarded this request to the dealer: ''admin'' (a human clicked Forward) | ''system'' (the SLA sweep). Defaults to ''admin''.'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_doc_requests.push_source IS
        'E-257. Who pushed this request back to the NBFC: ''admin'' | ''system'' (the SLA sweep verified the uploads WITHOUT a human review). Defaults to ''admin''.'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_doc_requests.auto_forwarded_at IS
        'E-257. When the SLA sweep auto-forwarded this request to the dealer. NULL when a human did it (or it has not happened).'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_doc_requests.auto_pushed_at IS
        'E-257. When the SLA sweep auto-pushed this request to the NBFC.'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_doc_requests.sla_failure IS
        'E-257. The error message from the last SLA sweep attempt on this row, when the auto action threw. The clock is already cleared, so the request stays with the admin for manual action and is never retried.'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_doc_requests.requested_items IS
        'E-257. Structured items the NBFC asked for ([{doc_label, reason, is_required}]), captured at raise so an auto-forward does not have to parse nbfc_comments. Empty for legacy rows and for request types with a single implied item.'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_document_verifications.sla_due_at IS
        'E-257. When the SLA sweep may auto-forward this ''queried''/''rejected'' verdict to the dealer. Stamped on the verdict upsert while forwarded_at IS NULL; NULLed when the verdict becomes verified/pending, when an admin forwards or answers it, or by the sweep''s claim. NULL = no clock. Never backfill.'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_document_verifications.forward_source IS
        'E-257. Who forwarded this verdict to the dealer: ''admin'' | ''system''. Defaults to ''admin''.'$c$;
    EXECUTE $c$COMMENT ON COLUMN nbfc_document_verifications.sla_failure IS
        'E-257. Error from the last SLA sweep attempt on this verdict; the row stays with the admin.'$c$;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: comments (a target table/column is absent)';
END; $do$;

COMMIT;
