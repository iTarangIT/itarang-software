-- =============================================================================
-- E-341 — SALES TARGETS: the Sales Head's own target number (2026-10-14)
-- =============================================================================
-- WHY. Targets screen review (14 Oct): the "Admin add-on" column is replaced by
-- a "Sales Head target". The CEO's number goes to the ISR / ASM unless the
-- Sales Head enters one of their own — higher or LOWER — in which case the
-- Sales Head's number is what goes. Empty or 0 = use the CEO's.
--
-- WHAT CHANGED (additive; one nullable column):
--   sales_head_target  numeric(14,2) NULL, ≥ 0
--
-- Final monthly target (computed, never stored — src/lib/targets/sql.ts):
--   COALESCE(NULLIF(sales_head_target, 0), ceo_target + admin_addon)
-- admin_addon stays in the formula for old rows; it was 0 on every row of
-- database-1 and database-2 when this shipped, and the screen no longer edits it.
--
-- Code on a DB without E-341 reads the column through to_jsonb (null → the CEO
-- target); saving a Sales Head target fails with "column does not exist".
--
-- No backfill. Idempotent: re-running is a no-op.
-- =============================================================================

DO $do$ BEGIN
    ALTER TABLE sales_targets
        ADD COLUMN IF NOT EXISTS sales_head_target numeric(14,2)
        CONSTRAINT sales_targets_sales_head_target_not_negative CHECK (sales_head_target >= 0);
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-341 skipped: sales_targets does not exist (apply E-303 first)';
END; $do$;
