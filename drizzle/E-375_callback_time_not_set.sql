-- =============================================================================
-- E-375 — AI DIALER: A CALLBACK WITH NO TIME IS FLAGGED, NOT A SILENT 11:00
--          (Priya KPI tracker task 11, D8 check, 4 Nov 2026)
-- =============================================================================
-- WHY.
--   When the dealer agreed a callback but named no time ("haan, kal call
--   karna"), the callback quietly fell due at 11:00 the next working day. The
--   ISR read 11:00 as the dealer's time. The tracker: "no time given → asked
--   once more, then flagged 'time not set', never a silent 11:00".
--
-- WHAT. lead_callbacks.time_not_set — true when the dealer named no clock time,
--   no part of the day and no hour delay; the due time is then the next working
--   day's calling-window opening, and the brief, the lead page and the ISR's
--   reminder all say "Time not set".
--
-- Read through to_jsonb / a column probe (src/lib/ai/storage/callOutcomeStore.ts
-- hasCallbackTimeNotSet), NOT mirrored in schema.ts: without it the flag lives
-- only in the brief JSON. Skips with a NOTICE when E-356 is missing.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE lead_callbacks
        ADD COLUMN IF NOT EXISTS time_not_set boolean NOT NULL DEFAULT false;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-375 skipped: lead_callbacks (E-356) does not exist yet';
END;
$do$;
