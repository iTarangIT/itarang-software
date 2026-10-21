-- =============================================================================
-- E-355 — READY → ASSIGNED (NON-HOT) AND TWO QUOTE CLOCKS
--          (tracker IDs 85, 86 — 18 Oct rework, sheet rows 10 #1 and #5)
-- =============================================================================
-- Requires E-337 (lead_clocks) and E-350 (lead_limit_events). Every block is
-- guarded, so on a database without them this file does nothing.
--
-- WHY.
--   * Rework 1: a non-Hot sales-ready lead gets an owner within 2 working days,
--     timed like the Hot clock and recorded as a "Limit passed" — a new clock
--     kind 'ready_assign'.
--   * #5: two agreed quote limits — 'Approved quote not delivered' (same
--     working day, 'quote_deliver') and 'Dealer declined, not revised or
--     marked Lost' (2 working days, 'quote_revise').
--   lead_clocks.clock only accepts the seven E-350 kinds, and both clock
--   columns are varchar(10) — too short for 'ready_assign' / 'quote_deliver'.
--
-- WHAT.
--   1. lead_clocks.clock and lead_limit_events.clock widened varchar(10) →
--      varchar(20) (a widening: no rewrite, no data change).
--   2. lead_clocks.clock CHECK re-added with the ten kinds (accepts MORE
--      values, never fewer).
--   The new limits (ready_to_assigned, nonhot_owner_first_attempt,
--   quote_approved_not_delivered, quote_declined_not_revised) are code
--   defaults in src/lib/timeLimits/registry.ts — time_limit_settings needs no
--   change (limit_key is free text).
--
-- NOT mirrored in schema.ts (raw SQL readers). The clock refresh probes the
-- CHECK (hasWideClockKinds in src/lib/leads/clocks.ts): without this file it
-- keeps computing the E-350 kinds, so nothing breaks in either order.
-- After applying, run the clock refresh (scripts/refresh-lead-clocks.ts, or
-- wait for the hourly ticker) to fill the new clocks and their records.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    IF to_regclass('public.lead_clocks') IS NULL THEN
        RAISE NOTICE 'E-355: lead_clocks missing (E-337 not applied) — skipping';
        RETURN;
    END IF;
    IF (SELECT character_maximum_length FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'lead_clocks' AND column_name = 'clock') < 20 THEN
        ALTER TABLE lead_clocks ALTER COLUMN clock TYPE varchar(20);
    END IF;
    ALTER TABLE lead_clocks DROP CONSTRAINT IF EXISTS lead_clocks_clock_check;
    ALTER TABLE lead_clocks ADD CONSTRAINT lead_clocks_clock_check
        CHECK (clock IN ('lead', 'owner', 'transfer', 'hot_assign', 'hot_owner', 'retry', 'quote',
                         'ready_assign', 'quote_deliver', 'quote_revise'));
END;
$do$;

DO $do$
BEGIN
    IF to_regclass('public.lead_limit_events') IS NULL THEN
        RAISE NOTICE 'E-355: lead_limit_events missing (E-350 not applied) — skipping';
        RETURN;
    END IF;
    IF (SELECT character_maximum_length FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'lead_limit_events' AND column_name = 'clock') < 20 THEN
        ALTER TABLE lead_limit_events ALTER COLUMN clock TYPE varchar(20);
    END IF;
END;
$do$;
