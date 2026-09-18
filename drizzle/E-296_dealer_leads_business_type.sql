-- =============================================================================
-- E-296 — DEALER LEADS: "Type of Business" (2026-09-17)
-- =============================================================================
-- WHY. The Pile B workpack asks for every CRM lead to carry what kind of
-- business it is — battery sale, buyback, finance, scrap, other — so the /leads
-- list and the Inside Sales / ASM queues can be filtered, bifurcated (per-type
-- counts above the table) and bulk-assigned by it, and so the Excel export
-- carries it. `dealer_leads` had no such column.
--
-- WHAT CHANGED (additive; nothing dropped, nothing narrowed):
--
--   dealer_leads
--     + business_type varchar(30)   NULL = not set (every pre-E-296 row).
--                                   Allowed values are enforced in code
--                                   (src/lib/leads/businessType.ts, zod), NOT by
--                                   a CHECK, so the list can grow without DDL:
--                                   battery_sale | buyback | finance | scrap | other
--     + index idx_dealer_leads_business_type
--
-- No backfill: existing leads stay NULL and render as "Not set".
--
-- The column is DELIBERATELY NOT mirrored in src/lib/db/schema.ts — same
-- treatment and same reason as E-224 / E-236 / E-242: ~20 call sites run a bare
-- `db.select().from(dealerLeads)`, and naming the column on the Drizzle object
-- would hard-fail all of them on a database that has not run this file. It is
-- written by raw `sql` UPDATEs and read via `to_jsonb(dl) ->> 'business_type'`
-- or in fail-tolerant side statements; the business_type FILTER names the
-- column directly (so it can use the index) and is emitted only when set.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS business_type varchar(30);

    CREATE INDEX IF NOT EXISTS idx_dealer_leads_business_type
        ON dealer_leads (business_type);

    COMMENT ON COLUMN dealer_leads.business_type IS
        'E-296 Type of Business: battery_sale | buyback | finance | scrap | other (enforced in code). NULL = not set.';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-296 skip: dealer_leads does not exist';
END;
$do$;
