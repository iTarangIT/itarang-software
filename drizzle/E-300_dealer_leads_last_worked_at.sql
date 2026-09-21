-- =============================================================================
-- E-300 — DEALER LEADS: last_worked_at, the "idle clock" (2026-09-21)
-- =============================================================================
-- WHY. Reporting Review v1.0 issue R-04 / metric M18, Requirement #6 point 7:
-- "Only a logged call, visit or status change counts as touched."
--
-- dealer_leads.last_touchpoint_at is bumped by writeTouchpoint on EVERY
-- touchpoint type — lead_assigned, lead_claimed, asm_transfer,
-- neodove_dial_request, escalation comments, WhatsApp, quote events. Every
-- stale / idle figure read it, so assigning, claiming or commenting on a lead
-- made it look freshly worked and hid neglect.
--
-- WHAT CHANGED (additive; nothing dropped, nothing narrowed):
--
--   dealer_leads
--     + last_worked_at timestamptz   NULL = never worked. Set by
--                                    writeTouchpoint ONLY when
--                                    isWorkedTouchpoint() is true
--                                    (src/lib/lifecycle/touchpointTypes.ts):
--                                    inside_sales_call (incl. NeoDove), visit,
--                                    or status_change_note CARRYING a real
--                                    status change. Claim / assign / ASM
--                                    transfer change status too and do NOT
--                                    count; nor do ai_call or plain notes.
--
-- last_touchpoint_at is untouched and keeps meaning "last activity of any kind".
--
-- BACKFILL. Latest per lead of:
--   * inside_sales_call / visit touchpoints, and
--   * status_change_note touchpoints that have a status-history row for the
--     same lead at the same instant — writeTouchpoint stamps both with one
--     performedAt, and there is no FK between them. A status_change_note with
--     no matching history row is a plain note (upload notes, reactivation,
--     NeoDove delete flags) and does not count.
-- Only ever moves the value FORWARD, so re-running is a no-op and it can never
-- overwrite a newer value written by live code.
--
-- ⚠ REQUIRED BEFORE THE CODE DEPLOYS. The column is mirrored in schema.ts
-- (B2 policy, E-299), so bare `db.select().from(dealerLeads)` names it and
-- writeTouchpoint sets it — on an unapplied host every lead touchpoint write
-- fails with `column "last_worked_at" does not exist`. Old code on a new DB
-- keeps working.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

ALTER TABLE dealer_leads
    ADD COLUMN IF NOT EXISTS last_worked_at timestamptz;

UPDATE dealer_leads dl
   SET last_worked_at = w.last_worked
  FROM (
        SELECT t.dealer_lead_id, MAX(t.performed_at) AS last_worked
          FROM lead_touchpoints t
         WHERE t.touchpoint_type IN ('inside_sales_call', 'visit')
            OR (t.touchpoint_type = 'status_change_note'
                AND EXISTS (SELECT 1
                              FROM dealer_lead_status_history h
                             WHERE h.dealer_lead_id = t.dealer_lead_id
                               AND h.changed_at = t.performed_at))
         GROUP BY t.dealer_lead_id
       ) w
 WHERE dl.id = w.dealer_lead_id
   AND (dl.last_worked_at IS NULL OR dl.last_worked_at < w.last_worked);
