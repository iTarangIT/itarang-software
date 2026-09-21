-- =============================================================================
-- E-304 — DEALER LEADS: interest history + field-change audit (2026-09-21)
-- =============================================================================
-- WHY. Reporting Review v1.0 sheet 9 (lead event log, Requirements #34 / #44)
-- names two event sources that did not exist:
--   * interest history — "how interest changed". E-301 stamps WHEN the rating
--     last changed (interest_changed_at) but keeps no history; only manual
--     overrides (interest_level_overrides) were ever recorded.
--   * field-change audit — #44 "Log details change": what was edited on a
--     lead, from what to what.
--
-- WHAT CHANGED (additive; two new tables and one trigger):
--
--   dealer_lead_interest_history   one row per rating change
--     dealer_lead_id, from_level, to_level, changed_by, changed_at
--   dealer_lead_field_changes      one row per edited field per update
--     dealer_lead_id, field, old_value, new_value, changed_by, changed_at
--
--   trigger dealer_leads_audit (AFTER INSERT OR UPDATE ON dealer_leads)
--     * interest_level set or changed (case-insensitively) → history row
--     * any AUDITED field changed → field-change row. Audited = what a person
--       edits: name, shop, phone, language, address / location, GSTIN, email,
--       business type, segments, next follow-up, payment intent. NOT status,
--       owner or interest (their own event types), and not bookkeeping columns
--       (updated_at, last_touchpoint_at, counters, AI state).
--     A DB trigger rather than app code: dozens of paths write dealer_leads,
--     and an audit that depends on every one remembering is not an audit.
--
-- WHO. The trigger reads current_setting('app.actor_id', true). The lead edit
-- route and the interest-level route set it for their transaction
-- (src/lib/leads/actorContext.ts); every other writer leaves it empty and the
-- row records changed_by = NULL ("not recorded") rather than a guess.
--
-- No backfill: history starts when this is applied. Older manual interest
-- overrides remain readable from interest_level_overrides, and the event log
-- merges both without double-counting.
--
-- Safe in either order: old code on a new DB works (the trigger only writes the
-- new tables), and new code on an old DB still exports — the event log reads
-- these tables only when they exist.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS dealer_lead_interest_history (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dealer_lead_id text        NOT NULL,
    from_level     varchar(20),
    to_level       varchar(20),
    changed_by     text,
    changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dealer_lead_interest_history_lead_idx
    ON dealer_lead_interest_history (dealer_lead_id, changed_at);
CREATE INDEX IF NOT EXISTS dealer_lead_interest_history_at_idx
    ON dealer_lead_interest_history (changed_at);

CREATE TABLE IF NOT EXISTS dealer_lead_field_changes (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dealer_lead_id text        NOT NULL,
    field          varchar(60) NOT NULL,
    old_value      text,
    new_value      text,
    changed_by     text,
    changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dealer_lead_field_changes_lead_idx
    ON dealer_lead_field_changes (dealer_lead_id, changed_at);
CREATE INDEX IF NOT EXISTS dealer_lead_field_changes_at_idx
    ON dealer_lead_field_changes (changed_at);

CREATE OR REPLACE FUNCTION dealer_leads_audit_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    actor  text := NULLIF(current_setting('app.actor_id', true), '');
    j_old  jsonb;
    j_new  jsonb;
    col    text;
    -- Keep in step with AUDITED_LEAD_FIELDS in src/lib/leads/eventLog.ts.
    cols   text[] := ARRAY[
        'dealer_name', 'shop_name', 'phone', 'language', 'location', 'state',
        'city', 'area', 'pincode', 'gstin', 'contact_email', 'business_type',
        'segments', 'address_notes', 'next_follow_up_at', 'preliminary_payment_intent'
    ];
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.interest_level IS NOT NULL THEN
            INSERT INTO dealer_lead_interest_history (dealer_lead_id, from_level, to_level, changed_by)
            VALUES (NEW.id, NULL, NEW.interest_level, actor);
        END IF;
        RETURN NULL;
    END IF;

    IF lower(NEW.interest_level) IS DISTINCT FROM lower(OLD.interest_level) THEN
        INSERT INTO dealer_lead_interest_history (dealer_lead_id, from_level, to_level, changed_by)
        VALUES (NEW.id, OLD.interest_level, NEW.interest_level, actor);
    END IF;

    j_old := to_jsonb(OLD);
    j_new := to_jsonb(NEW);
    FOREACH col IN ARRAY cols LOOP
        IF (j_old ->> col) IS DISTINCT FROM (j_new ->> col) THEN
            INSERT INTO dealer_lead_field_changes
                (dealer_lead_id, field, old_value, new_value, changed_by)
            VALUES (NEW.id, col, left(j_old ->> col, 1000), left(j_new ->> col, 1000), actor);
        END IF;
    END LOOP;
    RETURN NULL;
END;
$fn$;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'dealer_leads_audit' AND tgrelid = 'dealer_leads'::regclass
    ) THEN
        CREATE TRIGGER dealer_leads_audit
            AFTER INSERT OR UPDATE ON dealer_leads
            FOR EACH ROW EXECUTE FUNCTION dealer_leads_audit_fn();
    END IF;
END;
$do$;
