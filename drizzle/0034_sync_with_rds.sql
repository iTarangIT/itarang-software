-- 0034_sync_with_rds.sql
-- Two-way sync of src/lib/db/schema.ts ↔ AWS RDS (sandbox database-1, prod database-2).
--
-- This migration is purely destructive: drop three orphan tables that exist on
-- RDS but were never modeled in src/lib/db/schema.ts and are not referenced
-- anywhere in src/, scripts/, or legacy-vite/. Verified per user instruction.
--
-- Column-level sync (24 columns across 9 tables: campaign_segments, documents,
-- lead_documents, oem_contacts, oem_inventory_for_pdi, order_disputes,
-- pdi_records, provisions, slas) was handled by adopting the RDS shape into
-- the canonical schema rather than altering RDS, so no DDL is needed for those.
--
-- Apply order: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0034_sync_with_rds.sql
-- Take an RDS snapshot before applying — the DROPs are irreversible by re-running.

BEGIN;

-- Per user instruction: drop orphan tables (no FK references; not used by app code).
-- Sandbox already has intellicar_token and manual_consent_audits removed
-- (verified by drizzle-kit pull on 2026-04-26); IF EXISTS makes this idempotent.
-- Production state for these two is unverified at authoring time.
DROP TABLE IF EXISTS "intellicar_token";
DROP TABLE IF EXISTS "manual_consent_audits";
DROP TABLE IF EXISTS "scrape_batches";

COMMIT;
