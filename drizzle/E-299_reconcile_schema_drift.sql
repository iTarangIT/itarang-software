-- E-299 — Reconcile schema.ts ↔ database drift (B2, 2026-09-19).
--
-- PROVENANCE. Generated from `scripts/audit-schema.ts`, a live read-only
-- introspection of information_schema on BOTH databases, run 2026-09-19:
--
--   database-1 (sandbox) — 31 differences
--     · table  in schema.ts, missing in DB : whatsapp_translations      (E-269, never applied here)
--     · column in schema.ts, missing in DB : deployed_assets.warranty_months (E-268, never applied here)
--     · 3 type mismatches (schema.ts wrong, DB right — fixed in schema.ts, no DDL)
--     · 24 columns + 2 tables in the DB that schema.ts did not declare
--   database-2 (prod)    — the same 24 + 2 + 3, nothing missing; plus
--     product_selections.sub_category, which is RETIRED (E-103 renamed it to
--     model_number; E-251 deliberately did not recreate it on sandbox) and is
--     allow-listed in the audit script instead of being mirrored.
--
-- WHY THE "DELIBERATELY ABSENT" COLUMNS ARE NOW MIRRORED IN schema.ts.
--   E-224, E-236, E-242, E-250, E-267, E-295 and E-296 each kept their columns
--   OFF the Drizzle object, because Drizzle names every column of a table object
--   in a bare select/insert and an unapplied migration would take the whole
--   screen down. That was the right call while one database lacked them. The
--   audit shows BOTH shared databases now carry every one of them, so the
--   reason is gone and the audit's "zero differences" goal needs them declared.
--   This file re-declares each one (IF NOT EXISTS — a no-op on both DBs today)
--   so that ANY database which has run E-299 is guaranteed to satisfy the new
--   schema.ts. ⚠ That makes E-299 REQUIRED before deploying the schema.ts that
--   ships with it, on every environment — including a personal dev DB.
--
-- WHAT IS NOT HERE.
--   · No type changes. The three mismatches (dealer_onboarding_applications.
--     dealer_confirmed_at timestamptz; inventory.inventory_type / material_code
--     text) are schema.ts being wrong about the DB; schema.ts was corrected.
--   · No DROP of anything — product_selections.sub_category stays on prod.
--
-- Strictly additive and idempotent, per CLAUDE.md. Every block is guarded with
-- IF NOT EXISTS and wrapped for undefined_table, so re-running is a no-op.
-- Verify: `node --import tsx --env-file=.env.local scripts/audit-schema.ts`
-- must print "✓ No differences." against the target DB.

BEGIN;

-- ── 1. Re-deliver E-268 (sandbox never got it) ──────────────────────────────
DO $do$
BEGIN
    ALTER TABLE deployed_assets ADD COLUMN IF NOT EXISTS warranty_months integer;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip E-299 §1: deployed_assets not present';
END;
$do$;

-- ── 2. Re-deliver E-269 (sandbox never got it) ──────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_translations (
  id              bigserial PRIMARY KEY,
  source_hash     varchar(64)  NOT NULL,
  language        varchar(16)  NOT NULL,
  kind            varchar(16)  NOT NULL,
  source_text     text         NOT NULL,
  translated_text text         NOT NULL,
  model           varchar(64),
  hit_count       integer      NOT NULL DEFAULT 0,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_translations_hash_lang_uidx
  ON whatsapp_translations (source_hash, language);

-- ── 3. Guarantee the columns schema.ts now mirrors (no-op on db-1 and db-2) ─
-- dealer_leads: E-224 (neodove_*), E-236 (last_disposition*/last_connect_status),
-- E-242 (contact_email, gstin), E-250 (intent_*), E-296 (business_type).
DO $do$
BEGIN
    ALTER TABLE dealer_leads
        ADD COLUMN IF NOT EXISTS neodove_synced_at        timestamptz,
        ADD COLUMN IF NOT EXISTS neodove_sync_status      varchar(20),
        ADD COLUMN IF NOT EXISTS last_disposition         text,
        ADD COLUMN IF NOT EXISTS last_disposition_bucket  varchar(20),
        ADD COLUMN IF NOT EXISTS last_connect_status      varchar(20),
        ADD COLUMN IF NOT EXISTS last_disposition_at      timestamptz,
        ADD COLUMN IF NOT EXISTS last_disposition_source  varchar(20),
        ADD COLUMN IF NOT EXISTS gstin                    varchar(15),
        ADD COLUMN IF NOT EXISTS contact_email            text,
        ADD COLUMN IF NOT EXISTS intent_band_source       varchar(10) NOT NULL DEFAULT 'ai',
        ADD COLUMN IF NOT EXISTS intent_overridden_by     uuid,
        ADD COLUMN IF NOT EXISTS intent_overridden_at     timestamptz,
        ADD COLUMN IF NOT EXISTS business_type            varchar(30);
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip E-299 §3: dealer_leads not present';
END;
$do$;

-- lead_touchpoints: E-236 (NeoDove call outcome), E-295 (ownership recipient).
DO $do$
BEGIN
    ALTER TABLE lead_touchpoints
        ADD COLUMN IF NOT EXISTS recording_url        text,
        ADD COLUMN IF NOT EXISTS external_agent_name  text,
        ADD COLUMN IF NOT EXISTS disposition          text,
        ADD COLUMN IF NOT EXISTS disposition_bucket   varchar(20),
        ADD COLUMN IF NOT EXISTS connect_status       varchar(20),
        ADD COLUMN IF NOT EXISTS external_stage       text,
        ADD COLUMN IF NOT EXISTS external_tag         text,
        ADD COLUMN IF NOT EXISTS from_owner_id        text,
        ADD COLUMN IF NOT EXISTS to_owner_id          text;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip E-299 §3: lead_touchpoints not present';
END;
$do$;

-- ai_call_logs: E-267.
DO $do$
BEGIN
    ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS transcript_turns jsonb;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip E-299 §3: ai_call_logs not present';
END;
$do$;

-- scraper_runs: the progress counters + heartbeat column. last_progress_at has
-- no originating E-file (it arrived by hand / db:push) but is on both DBs.
DO $do$
BEGIN
    ALTER TABLE scraper_runs
        ADD COLUMN IF NOT EXISTS new_leads_promoted              integer,
        ADD COLUMN IF NOT EXISTS new_leads_skipped_duplicate     integer,
        ADD COLUMN IF NOT EXISTS new_leads_skipped_invalid_phone integer DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_progress_at                timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip E-299 §3: scraper_runs not present';
END;
$do$;

-- ── 4. Tables that exist on both DBs with no E-file (0034_sync_with_rds era) ─
-- Nothing in src/ reads or writes either; declared in schema.ts so the audit
-- is clean. Shapes copied from information_schema on database-2.
CREATE TABLE IF NOT EXISTS admin_audit_log_exports (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by  uuid         NOT NULL,
  tenant_id     uuid,
  purpose       text         NOT NULL,
  filters       jsonb,
  row_count     integer      NOT NULL,
  storage_key   text         NOT NULL,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  expires_at    timestamptz
);
CREATE INDEX IF NOT EXISTS admin_audit_log_exports_created_at_idx   ON admin_audit_log_exports (created_at);
CREATE INDEX IF NOT EXISTS admin_audit_log_exports_requested_by_idx ON admin_audit_log_exports (requested_by);
CREATE INDEX IF NOT EXISTS admin_audit_log_exports_tenant_idx       ON admin_audit_log_exports (tenant_id);

CREATE TABLE IF NOT EXISTS scrape_batches (
  id                 varchar(255) PRIMARY KEY,
  query              text         NOT NULL,
  city               varchar(100),
  state              varchar(100),
  radius_meters      integer,
  latitude           numeric,
  longitude          numeric,
  total_results      integer      DEFAULT 0,
  new_leads_created  integer      DEFAULT 0,
  duplicates_found   integer      DEFAULT 0,
  enriched_existing  integer      DEFAULT 0,
  no_phone_count     integer      DEFAULT 0,
  status             varchar(20)  NOT NULL DEFAULT 'pending',
  error_message      text,
  initiated_by       uuid         NOT NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  completed_at       timestamptz
);

COMMIT;
