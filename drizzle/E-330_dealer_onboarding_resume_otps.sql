-- =============================================================================
-- E-330 — DEALER ONBOARDING: one-time codes to resume an application (tracker ID 129, 2026-10-05)
-- =============================================================================
-- WHY. The public onboarding form could overwrite any dealer's in-progress
-- application — bank account included — for anyone who typed that dealer's
-- e-mail or dealer code. It now only updates an application for someone who
-- proves it is theirs (src/lib/onboarding/submitAccess.ts). A dealer with no
-- login proves it with a one-time code sent to the e-mail ON the application.
-- This table holds those codes.
--
-- WHAT. New table dealer_onboarding_resume_otps:
--   application_id  the application the code is for
--   code_hash       sha256 of "<application id>:<code>" — the code itself is
--                   never stored
--   sent_to         the address it was sent to (for support; already on the
--                   application)
--   expires_at      10 minutes after sending
--   attempts        wrong entries so far; the code is dead after 5
--   consumed_at     set when the code is used; a code works once
--
-- Not mirrored in schema.ts: the two routes use raw SQL and answer 503 "not
-- available yet" on a database without this table, so new code on an old DB
-- still creates NEW applications — it just cannot resume one without a login.
--
-- DDL: additive + idempotent. Re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS dealer_onboarding_resume_otps (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id uuid        NOT NULL,
    code_hash      text        NOT NULL,
    sent_to        text,
    expires_at     timestamptz NOT NULL,
    attempts       integer     NOT NULL DEFAULT 0,
    consumed_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dealer_onboarding_resume_otps_app_idx
    ON dealer_onboarding_resume_otps (application_id, created_at DESC);
