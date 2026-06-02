-- E-135 — BRD Addendum V0.2 §10 (Video KYC, Active Video Liveness).
-- A Stage-1 verification track that runs post-routing on the NBFC side (NOT at
-- Step 2). Per-NBFC choice (Service Opt-In vkyc_mode):
--   Q1a Own VKYC      — B2-B: iTarang triggers + records; NBFC runs its vendor.
--   Q1b iTarang VKYC  — iTarang operates the Decentro Active Liveness flow;
--                        a flat fee per RUN applies (§8.2), hence per-attempt rows.
--
-- Canonical status (§9.3 pattern) drives all logic; provider_raw_* is for
-- display/audit only. Strictly additive + idempotent.

-- One track row per (lead × NBFC). Retried sessions append video_kyc_attempts.
CREATE TABLE IF NOT EXISTS "video_kyc_verifications" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id"              varchar(50) NOT NULL,
  "nbfc_id"              integer NOT NULL,
  "tenant_id"           uuid NOT NULL,
  "vkyc_ref"             varchar(64) NOT NULL,
  "mode"                 varchar(16) NOT NULL,           -- 'own' | 'itarang'
  "status"               varchar(20) NOT NULL DEFAULT 'pending',
  -- Decoded signals (Q1b Decentro Active Liveness; null for Own VKYC).
  "match_score"          numeric(5, 2),
  "liveliness"           varchar(16),
  "static_risk"          boolean,
  "prerecorded_risk"     boolean,
  "face_match_score"     numeric(5, 2),
  "geo_location"         jsonb,
  -- Provider raw layer (display/audit only).
  "provider_name"        varchar(80),
  "provider_raw_status"  varchar(120),
  "provider_raw_payload" jsonb,
  "failure_reason"       text,
  "triggered_by"         uuid,
  "triggered_at"         timestamptz,
  "completed_at"         timestamptz,
  -- Admin verification card decision.
  "admin_action"         varchar(16),                   -- 'accepted' | 'rejected'
  "admin_action_by"      uuid,
  "admin_action_at"      timestamptz,
  "admin_action_notes"   text,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "video_kyc_verifications_lead_nbfc_unique"
  ON "video_kyc_verifications" ("lead_id", "nbfc_id");
CREATE UNIQUE INDEX IF NOT EXISTS "video_kyc_verifications_ref_unique"
  ON "video_kyc_verifications" ("vkyc_ref");
CREATE INDEX IF NOT EXISTS "video_kyc_verifications_tenant_status_idx"
  ON "video_kyc_verifications" ("tenant_id", "status");

DO $do$ BEGIN
  ALTER TABLE "video_kyc_verifications"
    ADD CONSTRAINT "video_kyc_verifications_status_check"
    CHECK ("status" IN ('not_applicable', 'pending', 'in_progress', 'verified', 'failed'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: video_kyc_verifications_status_check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "video_kyc_verifications"
    ADD CONSTRAINT "video_kyc_verifications_mode_check"
    CHECK ("mode" IN ('own', 'itarang'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: video_kyc_verifications_mode_check exists';
END; $do$;

-- One row per SESSION RUN — the billing unit for the iTarang VKYC flat fee
-- (§8.2: charged whenever a session runs, including losing/failed leads).
CREATE TABLE IF NOT EXISTS "video_kyc_attempts" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "verification_id"      uuid NOT NULL,
  "lead_id"              varchar(50) NOT NULL,
  "nbfc_id"              integer NOT NULL,
  "tenant_id"           uuid NOT NULL,
  "attempt_ref"          varchar(80),
  "provider_txn_id"      varchar(120),
  "session_url"          text,
  "status"               varchar(20) NOT NULL DEFAULT 'in_progress',
  "provider_raw_status"  varchar(120),
  "provider_raw_payload" jsonb,
  "charged"              boolean NOT NULL DEFAULT false,
  "charged_ledger_id"    uuid,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "video_kyc_attempts_verification_idx"
  ON "video_kyc_attempts" ("verification_id");
CREATE INDEX IF NOT EXISTS "video_kyc_attempts_txn_idx"
  ON "video_kyc_attempts" ("provider_txn_id");

COMMENT ON TABLE "video_kyc_verifications" IS
  'Addendum V0.2 §10 — per (lead × NBFC) Video KYC track. mode own=B2-B trigger+record, itarang=Decentro Active Liveness. Canonical status drives logic; provider_raw_* is display/audit only.';
COMMENT ON TABLE "video_kyc_attempts" IS
  'Addendum V0.2 §10/§8.2 — one row per VKYC session run; the billing unit for the iTarang VKYC flat fee (charged on every run, incl. losing/failed leads).';
