-- =============================================================================
-- E-367 — AI DIALER: AUTO-ASSIGN QUALIFIED LEADS TO THE AREA ASM (route log)
-- =============================================================================
-- WHY.
--   A lead the AI dialer qualified (or that agreed to a callback / asked for a
--   person) went to the next ISR on the E-362 round-robin, whatever its city.
--   It now goes to the ASM whose territory (asm_territories, E-118) covers the
--   lead's city — city mapping beats a whole-state mapping, ties take turns —
--   and only falls back to the ISR round-robin when no ASM covers the place.
--
-- WHAT. lead_route_log — one row per automatic routing decision: the lead, the
--   kind of hand-off (qualified / sales), the rule that decided
--   (territory_city / territory_state / isr_round_robin / unassigned), the
--   state + city it was matched on, the territory row, who got it and the
--   candidates that were considered. It is the audit trail ("why did Ravi get
--   this lead?"), the source of the admin "Not covered" list, and the turn
--   order: among tied ASMs, the one whose last territory lead is oldest goes
--   next.
--
-- The switch lives in app_settings['territory_routing'] (no DDL) and ships OFF.
--
-- NOT mirrored in schema.ts — raw SQL behind a to_regclass probe
-- (src/lib/ai-dialer/territoryRouting.ts), so the code is safe before this file
-- is applied: without it routing still matches by territory, but tied ASMs are
-- picked by name rather than in turn, and nothing is logged.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_route_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         text NOT NULL,
    kind            varchar(16) NOT NULL,
    rule            varchar(32) NOT NULL,
    state           varchar(100),
    city            varchar(100),
    territory_id    uuid,
    chosen_user_id  text,
    candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

DO $do$
BEGIN
    ALTER TABLE lead_route_log
        ADD CONSTRAINT lead_route_log_rule_check
        CHECK (rule IN ('territory_city', 'territory_state', 'isr_round_robin', 'unassigned'));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'lead_route_log_rule_check exists, skip';
END;
$do$;

CREATE INDEX IF NOT EXISTS lead_route_log_user_rule_idx ON lead_route_log (chosen_user_id, rule, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_route_log_lead_idx ON lead_route_log (lead_id);
CREATE INDEX IF NOT EXISTS lead_route_log_created_idx ON lead_route_log (created_at DESC);
