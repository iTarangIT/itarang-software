------------------------------------------------------------------------------
-- E-246: KYC auto-approval SLA — time-boxed automation of the admin KYC review.
--
-- WHAT THIS ADDS, AND WHY.
--
-- Today every customer lead that reaches /admin/kyc-review/[leadId] waits on a
-- human: five verification cards (aadhaar, pan, bank, cibil, rc) each need an
-- Accept click, the consent record needs an Approve click, and only then does
-- the final Approve button write leads.kyc_status='step_3_cleared' and unlock
-- the dealer's Step 4. The business does not want that gate to be a person.
--
-- This file backs a "nobody acted in time, so the system acts" sweep. When the
-- dealer submits documents + coupon, an SLA deadline is stamped on the queue
-- row; when it passes with the case untouched, a ticker accepts the still-
-- PENDING cards, verifies the required supporting docs, and runs the ordinary
-- final-decision path. Consent is auto-verified the moment it is signed.
--
-- ⚠ READ THIS BEFORE APPLYING. The sweep marks identity cards accepted WITHOUT
-- calling the verification providers — no Decentro PAN/bank/bureau call, no
-- DigiLocker Aadhaar pull. api_response is left exactly as the provider did (or
-- did not) leave it, so the row never claims a check that never happened. That
-- is the point of the `*_source` columns below: after this file, "accepted" is
-- no longer proof a human or a registry looked at it, and every consumer that
-- cares must read admin_action_source too. This is a compliance decision the
-- business made deliberately; the DDL only makes it auditable.
--
-- WHY `*_source` COLUMNS RATHER THAN A SENTINEL USER. Every actor column in
-- this path (kyc_verifications.admin_action_by, other_document_requests
-- .reviewed_by, kyc_verification_metadata.final_decision_by, audit_logs
-- .performed_by) is already NULLABLE, so a system action can simply leave the
-- uuid NULL. But NULL is ambiguous — legacy rows written before the actor
-- columns existed are also NULL — so NULL alone cannot answer "did a person
-- accept this?". An explicit varchar discriminator can, and it follows the one
-- precedent already in the schema: buyback_activity_log carries a nullable
-- actor_id beside a NOT NULL role text documented as 'dealer'|'admin'|'system'.
-- Defaulting to 'admin' makes every pre-existing row read as human-actioned,
-- which is exactly what it was.
--
-- WHY THE CLOCK LIVES ON admin_verification_queue. That row is what the sweep
-- claims (FOR UPDATE SKIP LOCKED), it already carries the open/terminal status
-- vocabulary the sweep filters on, and it is already written in the same
-- transaction as the dealer's submit. kyc_verification_metadata is keyed by
-- lead_id and would survive queue churn, but the sweep would then have to join
-- to find out whether the case is still open — the claim and the deadline
-- belong on the same row.
--
-- NO BACKFILL IS INCLUDED, ON PURPOSE. sla_due_at is left NULL on every
-- existing open queue row and the sweep ignores NULL, so leads submitted before
-- this ships never retro-auto-approve. Turning the feature on affects only
-- cases submitted after it was turned on.
--
-- NOT REQUIRED FOR EXISTING BEHAVIOUR, BUT REQUIRED BEFORE THE CODE DEPLOYS.
-- All five tables below ARE mirrored in schema.ts and several are read with a
-- bare db.select().from(...) — drizzle names every column of a mirrored table
-- in its generated SQL, so on a database without this file the admin KYC review
-- page fails on its first read with `column "admin_action_source" does not
-- exist`. Apply before deploying. The automation itself stays inert regardless:
-- app_settings key 'kyc_auto_approval' ships with enabled=false.
--
-- Additive and idempotent — safe to re-run. Every block is guarded so it is a
-- reported no-op on a database missing the table.
------------------------------------------------------------------------------

BEGIN;

-- 1. Provenance on the card verdict ------------------------------------------
DO $do$ BEGIN
    ALTER TABLE kyc_verifications
        ADD COLUMN IF NOT EXISTS admin_action_source varchar(16) DEFAULT 'admin';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: kyc_verifications does not exist';
END; $do$;

-- 2. Provenance on the supporting-doc review ---------------------------------
DO $do$ BEGIN
    ALTER TABLE other_document_requests
        ADD COLUMN IF NOT EXISTS review_source varchar(16) DEFAULT 'admin';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: other_document_requests does not exist';
END; $do$;

-- 3. Provenance on the consent verification ----------------------------------
DO $do$ BEGIN
    ALTER TABLE consent_records
        ADD COLUMN IF NOT EXISTS verification_source varchar(16) DEFAULT 'admin';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: consent_records does not exist';
END; $do$;

-- 4. Provenance on the final decision ----------------------------------------
DO $do$ BEGIN
    ALTER TABLE kyc_verification_metadata
        ADD COLUMN IF NOT EXISTS final_decision_source varchar(16) DEFAULT 'admin';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: kyc_verification_metadata does not exist';
END; $do$;

-- 5. The SLA clock, on the row the sweep claims ------------------------------
DO $do$ BEGIN
    ALTER TABLE admin_verification_queue
        ADD COLUMN IF NOT EXISTS sla_due_at           timestamptz,
        ADD COLUMN IF NOT EXISTS auto_approved_at     timestamptz,
        ADD COLUMN IF NOT EXISTS auto_approval_result varchar(24);
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: admin_verification_queue does not exist';
END; $do$;

-- 6. Keeps the 60s sweep off a sequential scan -------------------------------
-- PARTIAL on purpose: the sweep only ever looks at open, not-yet-swept rows,
-- and that is a vanishing fraction of the queue's lifetime rows. Drizzle's
-- index builder has no WHERE clause, so this index is migration-only and must
-- never be "re-created" from schema.ts — a same-named index built without the
-- predicate would still satisfy a name-only check while scanning the whole
-- table on every tick.
DO $do$ BEGIN
    CREATE INDEX IF NOT EXISTS admin_verification_queue_sla_due_idx
        ON admin_verification_queue (sla_due_at)
        WHERE auto_approved_at IS NULL
          AND status = 'pending_itarang_verification';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: admin_verification_queue does not exist';
END; $do$;

-- 7. Self-documentation ------------------------------------------------------
-- No CHECK constraints, per the convention this repo follows for the same
-- reason elsewhere (E-202/E-218/E-226/E-231/E-232/E-238/E-240): the vocabulary
-- is enforced by the route/service layer and recorded here. A CHECK would also
-- make adding a third source value a migration rather than a code change.
DO $do$ BEGIN
    EXECUTE $c$COMMENT ON COLUMN kyc_verifications.admin_action_source IS
        'Who produced admin_action: ''admin'' (a human clicked Accept/Reject) | ''system'' (E-246 SLA sweep auto-accepted it WITHOUT calling the provider). Defaults to ''admin'' so every pre-E-246 row reads as human-actioned. Never infer this from a NULL admin_action_by — that is also NULL on legacy rows.'$c$;
    EXECUTE $c$COMMENT ON COLUMN other_document_requests.review_source IS
        'Who set upload_status: ''admin'' | ''system'' (E-246 SLA sweep). Defaults to ''admin''.'$c$;
    EXECUTE $c$COMMENT ON COLUMN consent_records.verification_source IS
        'Who set consent_status to verified: ''admin'' (KYC review panel) | ''system'' (E-246 auto-verify on signature). Defaults to ''admin''. Note the OTP path has auto-completed consent since E-180 and predates this column, so older OTP rows read ''admin''.'$c$;
    EXECUTE $c$COMMENT ON COLUMN kyc_verification_metadata.final_decision_source IS
        'Who made final_decision: ''admin'' | ''system'' (E-246 SLA sweep). Defaults to ''admin''.'$c$;
    EXECUTE $c$COMMENT ON COLUMN admin_verification_queue.sla_due_at IS
        'E-246. When the KYC auto-approval sweep may act on this case: submitted_at + app_settings.kyc_auto_approval.slaHours, stamped at dealer submit. NULL means never auto-approve — the state of every row that predates E-246, and of every row submitted while the feature is disabled.'$c$;
    EXECUTE $c$COMMENT ON COLUMN admin_verification_queue.auto_approved_at IS
        'E-246. When the sweep processed this case. Non-NULL is the idempotency guard: a row is claimed at most once regardless of outcome, so a blocked case is never retried.'$c$;
    EXECUTE $c$COMMENT ON COLUMN admin_verification_queue.auto_approval_result IS
        'E-246 outcome: ''approved'' (final decision written, Step 4 unlocked) | ''blocked'' (an admin had already rejected a card, so the approve gate legitimately refused and the case stays with the admin) | ''skipped_disabled''. No CHECK — see the file header.'$c$;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: comments (a target table/column is absent)';
END; $do$;

COMMIT;
