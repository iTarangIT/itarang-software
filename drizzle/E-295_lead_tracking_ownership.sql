-- =============================================================================
-- E-295 — LEAD TRACKING: record the RECIPIENT of every ownership change
--         (2026-09-10)
-- =============================================================================
-- WHY. Every ownership-changing write on a dealer lead (claim, reassign,
-- transfer to ASM, escalation reassign, reactivation, NeoDove push) records
-- WHO DID IT (lead_touchpoints.performed_by) but never WHO RECEIVED IT.
-- assignOwner.ts overwrites dealer_leads.current_owner_id and the previous
-- owner is gone. So "where has this lead travelled and how long did each
-- person hold it" — the Lead Tracking panel and CSV — cannot be reconstructed
-- for anything but the CURRENT hold (dealer_leads.assigned_at).
--
-- WHAT CHANGED (additive; nothing dropped, nothing narrowed):
--
--   lead_touchpoints
--     + from_owner_id   previous current_owner_id on an ownership-changing
--                       touchpoint. NULL = the lead was unassigned.
--     + to_owner_id     new current_owner_id. NULL = released to the pool.
--                       Both NULL = not an ownership change (or pre-E-295).
--     + partial index over the ownership rows.
--
-- The two columns are DELIBERATELY NOT mirrored in src/lib/db/schema.ts:
-- lead_touchpoints is written through the Drizzle object (touchpoints/write.ts
-- names every column in its INSERT), so listing them there would break every
-- touchpoint write on a host that has not run this file. They are written by a
-- raw UPDATE inside the same transaction and read via `to_jsonb(t) ->> '…'`.
-- Same treatment, same reason, as E-226 / E-236.
--
-- The names match the stashed E-294 reporting work on purpose so a later
-- unstash lands on `ADD COLUMN IF NOT EXISTS` no-ops instead of a conflict.
--
-- BACKFILL (self-limiting — touches only rows where BOTH columns are NULL, so
-- a re-run matches nothing):
--   1. lead_claimed rows: the claimer IS the recipient → to_owner_id = performed_by.
--   2. The LATEST assignment-type touchpoint per lead: the recipient is provably
--      the lead's current owner only when no later ownership change exists →
--      to_owner_id = dealer_leads.current_owner_id.
--   Earlier hops keep NULL and the tracking view says "recipient not recorded"
--   rather than guessing.
--
-- REQUIRED BEFORE THE CODE DEPLOYS: writeTouchpoint runs the raw UPDATE inside
-- the touchpoint transaction on every ownership write, and reactivation /
-- onboarding-dropout name the columns in their INSERTs. Old code on a new DB
-- keeps working (additive), which is the safe order.
-- =============================================================================

DO $do$
BEGIN
  ALTER TABLE lead_touchpoints
    ADD COLUMN IF NOT EXISTS from_owner_id text,
    ADD COLUMN IF NOT EXISTS to_owner_id   text;

  COMMENT ON COLUMN lead_touchpoints.from_owner_id IS
    'E-295: previous dealer_leads.current_owner_id on an ownership-changing touchpoint. NULL = was unassigned. Both from/to NULL = not an ownership change (or pre-E-295). Read via to_jsonb(t)->>''from_owner_id''; not in schema.ts.';
  COMMENT ON COLUMN lead_touchpoints.to_owner_id IS
    'E-295: new dealer_leads.current_owner_id on an ownership-changing touchpoint. NULL = released to the pool. Feeds the Lead Tracking journey (src/lib/leads/tracking.ts).';

  CREATE INDEX IF NOT EXISTS lead_touchpoints_ownership_idx
    ON lead_touchpoints (dealer_lead_id, performed_at)
    WHERE from_owner_id IS NOT NULL OR to_owner_id IS NOT NULL;

  -- 1. A claim is a self-assignment: the performer is the recipient.
  UPDATE lead_touchpoints
     SET to_owner_id = performed_by
   WHERE touchpoint_type = 'lead_claimed'
     AND performed_by IS NOT NULL
     AND from_owner_id IS NULL
     AND to_owner_id IS NULL;

  -- 2. The most recent assignment-type touchpoint per lead handed the lead to
  --    whoever owns it now — provable because nothing changed hands after it.
  WITH latest AS (
    SELECT DISTINCT ON (t.dealer_lead_id)
           t.touchpoint_id, dl.current_owner_id
      FROM lead_touchpoints t
      JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
     WHERE t.touchpoint_type IN (
             'lead_assigned', 'lead_claimed', 'ownership_transfer', 'asm_transfer',
             'escalation_resolved_reassign', 'reactivated_via_admin',
             'reactivated_via_upload', 'reactivated_via_ai_dialer',
             'onboarding_dropout_action')
       AND dl.current_owner_id IS NOT NULL
     ORDER BY t.dealer_lead_id, t.performed_at DESC, t.created_at DESC
  )
  UPDATE lead_touchpoints t
     SET to_owner_id = l.current_owner_id
    FROM latest l
   WHERE l.touchpoint_id = t.touchpoint_id
     AND t.from_owner_id IS NULL
     AND t.to_owner_id IS NULL;

  RAISE NOTICE 'E-295: % touchpoint row(s) now carry a recipient (to_owner_id)',
    (SELECT count(*) FROM lead_touchpoints WHERE to_owner_id IS NOT NULL);
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-295: lead_touchpoints / dealer_leads does not exist here — skip';
END;
$do$;
