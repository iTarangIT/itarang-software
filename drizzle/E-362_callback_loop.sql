-- =============================================================================
-- E-362 — AI DIALER: THE CALLBACK LOOP (AI Dialer Fixes D8, 10 Oct 2026)
-- =============================================================================
-- WHY.
--   A callback Priya promised became a lead_callbacks row (E-356) and a bell
--   to admins, and stopped there: no named ISR, no reminder, no chase, and any
--   NeoDove call — even one that did not connect — closed it.
--
-- WHAT. lead_callbacks gains what the loop needs (src/lib/ai-dialer/callbackLoop.ts):
--   kind              sales | complaint | qualified (Qualified, no time agreed)
--   brief             the call brief shown to the ISR and sent to NeoDove
--   reminded_at       15 min before due: reminder sent (and NeoDove push)
--   neodove_pushed_at when the lead was pushed into the ISR's NeoDove campaign
--   escalated_at      30 min overdue with no call: Sales Head told
--   push_attempts     NeoDove calls that did not connect (3 → Not reached)
--   A partial index serves the 5-minute ticker.
--
-- The settings (callback owners, NeoDove push on/off) live in app_settings
-- under 'callback_loop' — no DDL.
--
-- NOT mirrored in schema.ts — every reader is raw SQL behind a column probe,
-- so the code is safe before this file is applied (the loop simply waits).
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE lead_callbacks ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'sales';
    ALTER TABLE lead_callbacks ADD COLUMN IF NOT EXISTS brief jsonb;
    ALTER TABLE lead_callbacks ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
    ALTER TABLE lead_callbacks ADD COLUMN IF NOT EXISTS neodove_pushed_at timestamptz;
    ALTER TABLE lead_callbacks ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
    ALTER TABLE lead_callbacks ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS lead_callbacks_loop_due_idx
        ON lead_callbacks (due_at)
        WHERE owner_type = 'sales' AND status = 'open';

    COMMENT ON COLUMN lead_callbacks.kind IS
      'E-362 — sales (a callback agreed), complaint (closed only when resolved), qualified (Qualified with no time agreed).';
    COMMENT ON COLUMN lead_callbacks.brief IS
      'E-362 — the call brief: purpose, shop, city, person, product lines, volume, promise, open questions.';
    COMMENT ON COLUMN lead_callbacks.push_attempts IS
      'E-362 — NeoDove calls on this callback that did not connect; at 3 it closes as Not reached.';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: lead_callbacks (E-356) is not here yet';
END;
$do$;
