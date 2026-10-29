-- =============================================================================
-- E-363 — VERIFIED FIELD VISITS (tracker ID 196, PJP phase 1, Kartik 27 Oct)
-- =============================================================================
-- WHY.
--   A visit could be logged from anywhere, back-dated, with a gallery photo or
--   none. Travel expenses (ID 197) need proof that someone was at the shop.
--
-- WHAT.
--   1. visit_captures — one row per camera photo taken from the visit form:
--      who, which lead or account, the stamped photo, its SHA-256, the phone's
--      live location and accuracy, and the SERVER time it arrived. The same
--      photo can never be used twice (unique on the hash). visit_id is set
--      when a visit uses the capture.
--   2. lead_visits gains account_id (visits on an existing counter, My
--      Dealers), gps_accuracy_m, captured_at, photo_sha256, capture_id and
--      verified (true = live GPS within 100 m + camera photo, via a capture).
--      dealer_lead_id may now be NULL for a visit on an account with no lead
--      (widening only); a NOT VALID check keeps one of the two set on new rows.
--
-- NOT mirrored in schema.ts — the new columns are written and read with raw
-- SQL behind a probe (src/lib/visits/verifiedStore.ts), so the code is safe
-- before this file is applied: without it visits log as before, unverified.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS visit_captures (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         text NOT NULL,
    dealer_lead_id  text,
    account_id      varchar(255),
    photo_url       text NOT NULL,
    photo_sha256    varchar(64) NOT NULL,
    gps_lat         numeric(10, 7) NOT NULL,
    gps_lng         numeric(10, 7) NOT NULL,
    gps_accuracy_m  numeric(8, 1) NOT NULL,
    captured_at     timestamptz NOT NULL DEFAULT now(),
    visit_id        uuid,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS visit_captures_photo_sha256_key ON visit_captures (photo_sha256);
CREATE INDEX IF NOT EXISTS visit_captures_user_idx ON visit_captures (user_id, captured_at);

COMMENT ON TABLE visit_captures IS
  'E-363 / ID 196 — a camera photo + live location taken from the visit form; server-stamped. One photo, one visit.';

DO $do$
BEGIN
    ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS account_id varchar(255);
    ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS gps_accuracy_m numeric(8, 1);
    ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS captured_at timestamptz;
    ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS photo_sha256 varchar(64);
    ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS capture_id uuid;
    ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS verified boolean DEFAULT false;

    -- Widening only: a visit on an account (My Dealers) may have no lead.
    ALTER TABLE lead_visits ALTER COLUMN dealer_lead_id DROP NOT NULL;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_visits_lead_or_account_chk') THEN
        ALTER TABLE lead_visits
            ADD CONSTRAINT lead_visits_lead_or_account_chk
            CHECK (dealer_lead_id IS NOT NULL OR account_id IS NOT NULL) NOT VALID;
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS lead_visits_photo_sha256_key
        ON lead_visits (photo_sha256) WHERE photo_sha256 IS NOT NULL;
    CREATE INDEX IF NOT EXISTS lead_visits_account_idx
        ON lead_visits (account_id) WHERE account_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS lead_visits_asm_actual_idx
        ON lead_visits (asm_id, actual_visit_date) WHERE actual_visit_date IS NOT NULL;

    COMMENT ON COLUMN lead_visits.verified IS
      'E-363 / ID 196 — true = logged with the phone''s live location (100 m or better) and a camera photo stamped by the server.';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: lead_visits not present';
END;
$do$;
