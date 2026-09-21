-- =============================================================================
-- E-301 — DEALER LEADS: interest_changed_at, the interest-age clock (2026-09-21)
-- =============================================================================
-- WHY. Reporting Review v1.0 issue R-05 / metric M12. The Sales dashboard and
-- the daily sales email bucket Hot / Warm / Cold leads by age (0–7 / 8–14 /
-- 15–30 / 30+ days), but measured it from dealer_leads.updated_at — which moves
-- on ANY edit or touchpoint. A lead rated Hot a month ago and never re-rated
-- showed as 0–7 days the moment anyone touched it.
--
-- WHAT CHANGED (additive; nothing dropped, nothing narrowed):
--
--   dealer_leads
--     + interest_changed_at timestamptz   when interest_level last took its
--                                         CURRENT value. NULL = no rating.
--     + trigger dealer_leads_interest_changed_at (BEFORE INSERT OR UPDATE OF
--       interest_level) — stamps now() when the rating is set or changes,
--       compared case-insensitively so 'Hot' → 'hot' is not a change.
--       A trigger rather than app code because ~10 paths write interest_level
--       (call form, override route, NeoDove, AI dialer, WhatsApp, drafts,
--       bulk upload, KYC review…); any one forgetting would silently freeze
--       its leads' age.
--
-- BACKFILL (rows with a rating and no stamp yet — re-running is a no-op).
-- History is thin, so this is best evidence, not truth:
--   1. Evidence events = manual overrides (interest_level_overrides.to_value /
--      changed_at, E-123) + per-call ratings (lead_touchpoints.disposition_bucket
--      Hot/Warm/Cold / performed_at, E-236).
--   2. The stamp is the START of the latest unbroken run of the current rating:
--      the earliest event matching it after the last event that did not.
--   3. Evidence of a different rating but none of the current one → the time
--      of that last different event (the change happened after it).
--   4. No evidence at all → created_at. Most leads get their rating at
--      creation / upload, and the later rating paths leave evidence. This errs
--      toward showing a lead as OLDER — the failure R-05 exists to surface —
--      rather than younger.
-- Measured on database-2 2026-09-21: 193 open rated leads; 6 have an override,
-- 49 have per-call ratings.
--
-- ⚠ REQUIRED BEFORE THE CODE DEPLOYS. The column is mirrored in schema.ts
-- (B2 policy, E-299) and the Sales dashboard reads it — on an unapplied host
-- bare `db.select().from(dealerLeads)` and the dashboard fail with
-- `column "interest_changed_at" does not exist`. Old code on a new DB keeps
-- working (the trigger only writes the new column).
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

ALTER TABLE dealer_leads
    ADD COLUMN IF NOT EXISTS interest_changed_at timestamptz;

-- ── Backfill ────────────────────────────────────────────────────────────────
WITH ev AS (
        SELECT o.dealer_lead_id, lower(o.to_value) AS v, o.changed_at AS at
          FROM interest_level_overrides o
        UNION ALL
        SELECT t.dealer_lead_id, lower(t.disposition_bucket) AS v, t.performed_at AS at
          FROM lead_touchpoints t
         WHERE lower(t.disposition_bucket) IN ('hot', 'warm', 'cold')
     ),
     per_lead AS (
        SELECT dl.id,
               MAX(ev.at) FILTER (WHERE ev.v <> lower(dl.interest_level)) AS last_other
          FROM dealer_leads dl
          JOIN ev ON ev.dealer_lead_id = dl.id
         WHERE dl.interest_level IS NOT NULL
           AND dl.interest_changed_at IS NULL
         GROUP BY dl.id
     ),
     run AS (
        SELECT p.id,
               p.last_other,
               MIN(ev.at) FILTER (
                   WHERE ev.v = lower(dl.interest_level)
                     AND ev.at > COALESCE(p.last_other, '-infinity'::timestamptz)
               ) AS run_start
          FROM per_lead p
          JOIN dealer_leads dl ON dl.id = p.id
          JOIN ev ON ev.dealer_lead_id = p.id
         GROUP BY p.id, p.last_other
     )
UPDATE dealer_leads dl
   SET interest_changed_at = COALESCE(run.run_start, run.last_other, dl.created_at)
  FROM run
 WHERE dl.id = run.id
   AND dl.interest_changed_at IS NULL;

-- No evidence at all → created_at.
UPDATE dealer_leads
   SET interest_changed_at = created_at
 WHERE interest_level IS NOT NULL
   AND interest_changed_at IS NULL;

-- ── Trigger ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION dealer_leads_interest_changed_at_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.interest_level IS NOT NULL AND NEW.interest_changed_at IS NULL THEN
            NEW.interest_changed_at := now();
        END IF;
    ELSIF lower(NEW.interest_level) IS DISTINCT FROM lower(OLD.interest_level) THEN
        NEW.interest_changed_at := CASE WHEN NEW.interest_level IS NULL THEN NULL ELSE now() END;
    END IF;
    RETURN NEW;
END;
$fn$;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'dealer_leads_interest_changed_at'
           AND tgrelid = 'dealer_leads'::regclass
    ) THEN
        CREATE TRIGGER dealer_leads_interest_changed_at
            BEFORE INSERT OR UPDATE OF interest_level ON dealer_leads
            FOR EACH ROW EXECUTE FUNCTION dealer_leads_interest_changed_at_fn();
    END IF;
END;
$do$;
