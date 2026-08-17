------------------------------------------------------------------------------
-- E-247: put customer consent on the KYC auto-approval SLA clock.
--
-- WHAT CHANGES, AND WHY.
--
-- E-246 shipped consent auto-verification as an IMMEDIATE action: the moment a
-- consent reached a signed-but-unverified state it was marked verified, with no
-- waiting period. Two problems surfaced the first time it ran for real.
--
-- 1. NO WINDOW TO OBJECT IN. An admin who wanted to reject a bad consent had no
--    opportunity — it was already verified before the review screen could be
--    opened. Every other half of E-246 gives the human a window first; consent
--    was the odd one out.
--
-- 2. THE SWEEP HAD NO SCOPE GUARD — this is the serious one. E-246's card sweep
--    is opt-in per case: it only ever claims a queue row whose `sla_due_at` was
--    stamped AT SUBMISSION, so switching the feature on cannot reach backwards.
--    The consent backstop had no equivalent; it selected on `consent_status`
--    alone, across the whole table. Enabling the feature therefore verified
--    EVERY pending consent in the database retroactively, including ones signed
--    months earlier that nobody had reviewed. That is exactly what happened on
--    sandbox on 2026-08-17: 14 real consents flipped in one tick, and the
--    documented "enabling it never reaches back to older cases" guarantee was
--    quietly false for this path. On production it would have cleared every
--    outstanding customer consent the instant the box was ticked.
--
-- THE FIX IS THE COLUMN BELOW. `auto_verify_due_at` is STAMPED when a consent
-- enters a signed-but-unverified state, exactly as `admin_verification_queue
-- .sla_due_at` is stamped at dealer submit. It is NULL for every consent that
-- predates this file and for every consent signed while the feature is off, and
-- the sweep skips NULL — so the retroactive sweep is structurally impossible
-- rather than merely discouraged. There is deliberately NO BACKFILL for the
-- same reason.
--
-- No idempotency marker column is needed: verifying moves `consent_status` to
-- 'verified', which removes the row from the eligible set. A consent an admin
-- rejects moves to 'admin_rejected' and is likewise never eligible again.
--
-- REQUIRED BEFORE THE CODE DEPLOYS. `consent_records` is mirrored in schema.ts
-- and read with bare `db.select()` in several places (the KYC review page among
-- them), and Drizzle names every column of a mirrored table in its generated
-- SQL — so on a database without this file the consent panel fails on its first
-- read with `column "auto_verify_due_at" does not exist`. Apply before
-- deploying. The automation stays inert regardless: `app_settings` key
-- `kyc_auto_approval` ships `enabled=false`.
--
-- Additive and idempotent — safe to re-run. Guarded so it is a reported no-op
-- on a database without the table.
------------------------------------------------------------------------------

BEGIN;

-- 1. The consent SLA deadline ------------------------------------------------
DO $do$ BEGIN
    ALTER TABLE consent_records
        ADD COLUMN IF NOT EXISTS auto_verify_due_at timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: consent_records does not exist';
END; $do$;

-- 2. Keeps the 60s sweep off a sequential scan -------------------------------
-- PARTIAL, and the predicate is the whole point: it encodes the same "only
-- consents this feature actually admitted" rule the sweep relies on. Drizzle's
-- index builder has no WHERE clause, so this index is migration-only and must
-- never be recreated from schema.ts — a same-named index built without the
-- predicate would satisfy a name-only check while scanning every consent row on
-- every tick, and CREATE INDEX IF NOT EXISTS could never repair it afterwards.
DO $do$ BEGIN
    CREATE INDEX IF NOT EXISTS consent_records_auto_verify_due_idx
        ON consent_records (auto_verify_due_at)
        WHERE auto_verify_due_at IS NOT NULL
          AND consent_status IN ('esign_completed', 'admin_review_pending', 'manual_uploaded');
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: consent_records does not exist';
END; $do$;

-- 3. Self-documentation ------------------------------------------------------
DO $do$ BEGIN
    EXECUTE $c$COMMENT ON COLUMN consent_records.auto_verify_due_at IS
        'E-247. When the KYC auto-approval sweep may verify this consent: stamped as the moment it entered a signed-but-unverified state plus app_settings.kyc_auto_approval.slaMinutes. NULL means never auto-verify — the state of every consent predating E-247 and of every consent signed while the feature is off. The sweep skips NULL, which is what makes enabling the feature unable to reach backwards; do NOT backfill this column.'$c$;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: comment (target table/column absent)';
END; $do$;

COMMIT;
