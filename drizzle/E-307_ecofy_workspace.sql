-- =============================================================================
-- E-307 — ECOFY WORKSPACE: CRM-side owner + reminders on Ecofy leads (2026-09-24)
-- =============================================================================
-- WHY. The Sales Head assigns Ecofy leads to an ASM or ISR inside the CRM, and
-- those users then work the lead (calls, meetings, assessment, offer…) through
-- the signed Ecofy API. Ecofy can only assign to its own users, so the owner
-- lives here; Ecofy is told via the §4 `lead.assigned` event.
--
-- WHAT CHANGED (additive only):
--
--   ecofy_leads + CRM-owned columns. The inbound upsert (src/lib/ecofy/inbound.ts)
--   names its SET columns explicitly and does NOT list these, so an Ecofy push
--   never clears an assignment or a reminder.
--     assigned_to_user_id   users.id of the ASM / ISR working the lead
--     assigned_role         'asm' | 'inside_sales_rep' at assignment time
--     assigned_by / assigned_at
--     next_follow_up_at     set when a CRM user logs a follow-up
--     next_appointment_at   earliest SCHEDULED appointment booked from the CRM
--     follow_up_reminded_at / appointment_reminded_at   reminder fired once
--
--   ecofy_lead_assignments — one row per assign / reassign (history tab).
--
-- No backfill: every existing lead starts unassigned (they sit in the Pickup
-- queue). Required before the Ecofy workspace code deploys.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE ecofy_leads
        ADD COLUMN IF NOT EXISTS assigned_to_user_id     uuid,
        ADD COLUMN IF NOT EXISTS assigned_role           varchar(30),
        ADD COLUMN IF NOT EXISTS assigned_by             text,
        ADD COLUMN IF NOT EXISTS assigned_at             timestamptz,
        ADD COLUMN IF NOT EXISTS next_follow_up_at       timestamptz,
        ADD COLUMN IF NOT EXISTS next_appointment_at     timestamptz,
        ADD COLUMN IF NOT EXISTS follow_up_reminded_at   timestamptz,
        ADD COLUMN IF NOT EXISTS appointment_reminded_at timestamptz;

    CREATE INDEX IF NOT EXISTS ecofy_leads_assignee_idx
        ON ecofy_leads (assigned_to_user_id, stage);
    CREATE INDEX IF NOT EXISTS ecofy_leads_follow_up_due_idx
        ON ecofy_leads (next_follow_up_at)
        WHERE next_follow_up_at IS NOT NULL AND follow_up_reminded_at IS NULL;
    CREATE INDEX IF NOT EXISTS ecofy_leads_appointment_due_idx
        ON ecofy_leads (next_appointment_at)
        WHERE next_appointment_at IS NOT NULL AND appointment_reminded_at IS NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: ecofy_leads missing — apply E-305 first';
END;
$do$;

CREATE TABLE IF NOT EXISTS ecofy_lead_assignments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ecofy_lead_id   uuid        NOT NULL,
    from_user_id    uuid,
    to_user_id      uuid        NOT NULL,
    to_role         varchar(30),
    reason          text,
    assigned_by     text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ecofy_lead_assignments_lead_idx
    ON ecofy_lead_assignments (ecofy_lead_id, created_at);
