-- E-148 — BRD Addendum V0.3.1 §10 (Field Investigation — Full Spec).
-- Promotes the V0.2 simplified FI (E-136) to the V0.3.1 "Model C, pure
-- record-only" flow: the FI Coordinator picks an agent from a per-NBFC
-- directory, iTarang dispatches a single-use form link, the AGENT fills a
-- mobile field form at the customer's address (browser GPS + watermarked
-- photos), and the Coordinator reviews against auto-flags and decides
-- Pass / Fail / Re-inspection. Re-inspection creates a fresh attempt; prior
-- attempts stay in history.
--
-- Strictly additive + idempotent (per CLAUDE.md). Three tables:
--   nbfc_fi_agents            (§10.9.3) — per-NBFC lightweight agent directory
--   field_investigations      (§10.9.1) — extended; now one row PER ATTEMPT
--   field_investigation_photos(§10.9.2) — one row per uploaded photo

-- ───────────────────────────────────────────────────────────────────────────
-- 1. FI Agent Directory (§10.5 / §10.9.3). Agents are NOT iTarang users (no
--    login); these are lightweight contact records used for link dispatch and
--    selfie reference comparison.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "nbfc_fi_agents" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "nbfc_id"             integer NOT NULL,
  "tenant_id"           uuid NOT NULL,
  "name"                varchar(200) NOT NULL,
  "phone"               varchar(20) NOT NULL,
  "email"               varchar(200),
  "city"                varchar(120),
  "preferred_channel"   varchar(12) NOT NULL DEFAULT 'email',  -- 'email' | 'sms' | 'whatsapp'
  "reference_photo_url" text,                                  -- for Coordinator selfie comparison
  "active"              boolean NOT NULL DEFAULT true,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "nbfc_fi_agents_tenant_active_idx"
  ON "nbfc_fi_agents" ("tenant_id", "active");

DO $do$ BEGIN
  ALTER TABLE "nbfc_fi_agents"
    ADD CONSTRAINT "nbfc_fi_agents_channel_check"
    CHECK ("preferred_channel" IN ('email', 'sms', 'whatsapp'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_fi_agents_channel_check exists';
END; $do$;

COMMENT ON TABLE "nbfc_fi_agents" IS
  'Addendum V0.3.1 §10.5/§10.9.3 — per-NBFC FI agent directory. Lightweight contact records; agents are not iTarang users.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Extend field_investigations to the full §10 model (one row per ATTEMPT).
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "attempt_no"            integer NOT NULL DEFAULT 1;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "is_current"            boolean NOT NULL DEFAULT true;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "assigned_agent_id"     uuid;            -- FK → nbfc_fi_agents (added below)
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "link_token"            varchar(80);
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "link_sent_at"          timestamptz;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "link_channel"          varchar(12);     -- 'email' | 'sms' | 'whatsapp'
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "link_expires_at"       timestamptz;     -- = assigned_at + 48h
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "submitted_at"          timestamptz;     -- agent's Submit timestamp
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "gps_server_timestamp"  timestamptz;     -- server time at form-open GPS capture
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "stated_lat"            numeric(10, 7);  -- geocoded address anchor
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "stated_lng"            numeric(10, 7);
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "distance_from_address_m" numeric(10, 2); -- haversine(captured, stated)
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "address_match"         varchar(10);     -- 'matches' | 'partial' | 'no'
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "address_match_notes"   text;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "customer_present"      boolean;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "customer_present_notes" text;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "agent_declaration_at"  timestamptz;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "decision"              varchar(16);     -- 'pass' | 'fail' | 're_inspection'
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "decision_reason"       text;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "decided_by"            uuid;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "decided_at"            timestamptz;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "reopened_by"           uuid;            -- NBFC Admin reopen audit (§10.8.2)
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "reopened_at"           timestamptz;
ALTER TABLE "field_investigations" ADD COLUMN IF NOT EXISTS "reopen_reason"         text;

-- FK assigned_agent_id → nbfc_fi_agents(id) (idempotent).
DO $do$ BEGIN
  ALTER TABLE "field_investigations"
    ADD CONSTRAINT "field_investigations_agent_fk"
    FOREIGN KEY ("assigned_agent_id") REFERENCES "nbfc_fi_agents"("id");
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: field_investigations_agent_fk exists';
END; $do$;

-- Status CHECK → 8 canonical states (§10.4). 'completed' kept transitional so
-- the backfill below is safe even if it has not run yet.
DO $do$ BEGIN
  ALTER TABLE "field_investigations" DROP CONSTRAINT IF EXISTS "field_investigations_status_check";
  ALTER TABLE "field_investigations"
    ADD CONSTRAINT "field_investigations_status_check"
    CHECK ("status" IN (
      'not_applicable', 'pending', 'assigned', 'in_progress',
      'submitted', 'passed', 'failed', 're_inspection_requested',
      'completed'  -- legacy (E-136) — backfilled to 'passed' below
    ));
END; $do$;

-- address_match / decision domain CHECKs (idempotent).
DO $do$ BEGIN
  ALTER TABLE "field_investigations"
    ADD CONSTRAINT "field_investigations_address_match_check"
    CHECK ("address_match" IS NULL OR "address_match" IN ('matches', 'partial', 'no'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: field_investigations_address_match_check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "field_investigations"
    ADD CONSTRAINT "field_investigations_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('pass', 'fail', 're_inspection'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: field_investigations_decision_check exists';
END; $do$;

-- Backfill legacy E-136 rows to the new vocabulary.
UPDATE "field_investigations"
  SET "status" = 'passed', "decision" = 'pass'
  WHERE "status" = 'completed';
UPDATE "field_investigations"
  SET "decision" = 'fail'
  WHERE "status" = 'failed' AND "decision" IS NULL;

-- One row per attempt now: replace the (lead_id, nbfc_id) unique with a
-- PARTIAL unique that only constrains the single current attempt.
DROP INDEX IF EXISTS "field_investigations_lead_nbfc_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "field_investigations_current_unique"
  ON "field_investigations" ("lead_id", "nbfc_id")
  WHERE "is_current";
CREATE INDEX IF NOT EXISTS "field_investigations_link_token_idx"
  ON "field_investigations" ("link_token")
  WHERE "link_token" IS NOT NULL;

COMMENT ON TABLE "field_investigations" IS
  'Addendum V0.3.1 §10.9.1 — Field Investigation, one row PER ATTEMPT per (lead × NBFC). Model C pure record-only: agent fills mobile form via single-use link; Coordinator reviews + decides. is_current flags the operative attempt; 8 canonical states (§10.4).';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. FI photos (§10.9.2) — one row per uploaded photo, watermarked at capture.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "field_investigation_photos" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "field_investigation_id" uuid NOT NULL,
  "photo_type"             varchar(24) NOT NULL,  -- exterior|customer_at_residence|corroborator|agent_selfie|extra
  "image_url"              text NOT NULL,
  "gps_lat"                numeric(10, 7),
  "gps_lng"                numeric(10, 7),
  "gps_server_timestamp"   timestamptz,
  "watermark_applied"      boolean NOT NULL DEFAULT false,
  "exif_data"              jsonb,
  "uploaded_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "field_investigation_photos_fi_idx"
  ON "field_investigation_photos" ("field_investigation_id");

DO $do$ BEGIN
  ALTER TABLE "field_investigation_photos"
    ADD CONSTRAINT "field_investigation_photos_fi_fk"
    FOREIGN KEY ("field_investigation_id") REFERENCES "field_investigations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: field_investigation_photos_fi_fk exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "field_investigation_photos"
    ADD CONSTRAINT "field_investigation_photos_type_check"
    CHECK ("photo_type" IN ('exterior', 'customer_at_residence', 'corroborator', 'agent_selfie', 'extra'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: field_investigation_photos_type_check exists';
END; $do$;

COMMENT ON TABLE "field_investigation_photos" IS
  'Addendum V0.3.1 §10.9.2 — one row per FI photo. Watermarked with GPS + server timestamp at capture; structured GPS also stored.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Per-NBFC FI configuration (§10.7/§10.8.2/§15.4.2). JSON keeps the agent
--    form + review parameters NBFC-configurable without column churn.
--    Default: { reinspection_cap: null (unlimited), gps_denied_block: true,
--    camera_only: true, required_photos: [exterior, customer_at_residence,
--    corroborator, agent_selfie] }.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "nbfc_service_config"
  ADD COLUMN IF NOT EXISTS "fi_config" jsonb NOT NULL DEFAULT
  '{"reinspection_cap": null, "gps_denied_block": true, "camera_only": true, "required_photos": ["exterior", "customer_at_residence", "corroborator", "agent_selfie"]}'::jsonb;
