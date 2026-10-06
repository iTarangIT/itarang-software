-- =============================================================================
-- E-331 — DEALER LEADS: retire the "Finance" business type (2026-10-06)
-- =============================================================================
-- WHY. Admin asked for "Finance" to be removed from Type of Business and every
-- lead already marked Finance to become Battery Sale. A financed sale is still a
-- battery sale; the separate value only split the per-type counts.
--
-- WHAT CHANGED (data only; no DDL):
--
--   dealer_leads.business_type   'finance'  →  'battery_sale'
--
-- business_type is varchar(30) with NO enum and NO CHECK (E-296), so the value
-- set lives only in src/lib/leads/businessType.ts. That file drops "finance" in
-- the same release and normalizeBusinessType now maps finance / financing / loan
-- to battery_sale, so nothing can write 'finance' again. The E-304 audit
-- trigger records each converted row in dealer_lead_field_changes.
--
-- DEPLOY ORDER. Ship the code first, then run this. In between, a 'finance' row
-- just renders as "Not set" (unknown value); nothing errors.
--
-- Idempotent: the second run updates 0 rows.
-- =============================================================================

DO $do$
BEGIN
    UPDATE dealer_leads
       SET business_type = 'battery_sale'
     WHERE business_type = 'finance';

    COMMENT ON COLUMN dealer_leads.business_type IS
        'E-296 Type of Business: battery_sale | buyback | scrap | other (enforced in code; finance retired in E-331). NULL = not set.';
EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'E-331 skip: dealer_leads does not exist';
    WHEN undefined_column THEN
        RAISE NOTICE 'E-331 skip: dealer_leads.business_type does not exist (E-296 not applied)';
END;
$do$;

-- Verify (expect no 'finance' row):
--   SELECT business_type, count(*) FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC;
