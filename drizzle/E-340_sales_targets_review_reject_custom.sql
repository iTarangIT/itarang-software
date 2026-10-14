-- =============================================================================
-- E-340 — SALES TARGETS: Sales Head review, reject with comment, custom metrics
-- (2026-10-14)
-- =============================================================================
-- WHY. Team Scorecard & Target Management, item 3: the CEO creates a person's
-- targets and sends them to the Sales Head; the Sales Head reviews, may edit
-- the numbers and add or remove metrics, and sends them to the ISR / ASM, who
-- is notified (bell + email) and accepts or REJECTS them — a reject needs a
-- comment and goes back to the Sales Head and CEO. A target may also be a
-- CUSTOM metric (a name and unit typed in), whose progress is entered by hand.
--
-- WHAT CHANGED (additive; columns on sales_targets, nothing dropped):
--
--   review_requested_at / _by   when / who sent it to the Sales Head
--   rejected_at / rejected_by   the member's reject
--   reject_comment              the member's reason (required by the code)
--   custom_label  varchar(80)   a custom metric's name (metric = 'custom_<id>')
--   custom_unit   varchar(20)   its unit, free text ('₹' formats as money)
--   manual_actual numeric       a custom metric's progress, entered by hand
--   manual_actual_at / _by
--
-- status gains 'rejected' (vocabulary in src/lib/targets/rules.ts; enforced in
-- code, no CHECK, as E-303 decided).
--
-- Code on a DB without E-340: the targets page and "My targets" still load
-- (the new columns are read through to_jsonb and come back null); send for
-- review, reject, custom metrics and manual progress fail with a "column does
-- not exist" error. Apply before the code that uses them.
--
-- No backfill. Idempotent: re-running is a no-op.
-- =============================================================================

DO $do$ BEGIN
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS review_requested_at timestamptz;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS review_requested_by text;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS rejected_at        timestamptz;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS rejected_by        text;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS reject_comment     text;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS custom_label       varchar(80);
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS custom_unit        varchar(20);
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS manual_actual      numeric(14,2);
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS manual_actual_at   timestamptz;
    ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS manual_actual_by   text;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-340 skipped: sales_targets does not exist (apply E-303 first)';
END; $do$;
