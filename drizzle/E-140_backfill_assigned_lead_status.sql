-- E-140_backfill_assigned_lead_status.sql
--
-- Bugfix backfill. Admin "Reassign owner" (/admin/leads-info → POST
-- /api/admin/leads/bulk) could set dealer_leads.current_owner_id on a lead that
-- was still NULL-status. Manual-upload / scraped leads start life with
-- lead_status = NULL on purpose (so the AI dialer can cold-dial them — see
-- src/lib/ai-dialer/exclusionFilter.ts). The reassign handler only lifted a
-- lead into the BRD pipeline when it already had a recognised status, so a
-- NULL-status lead got an owner but kept lead_status = NULL. Every Inside Sales
-- / ASM workspace tab filters by lead_status, so the lead matched no queue and
-- was invisible to its new owner.
--
-- The code fix (src/app/api/admin/leads/bulk/route.ts) now lifts such leads into
-- the pipeline on assignment. This migration repairs leads already mis-assigned
-- before the fix shipped:
--   inside_sales_rep owner -> Assigned_Not_Contacted (sets originator_id)
--   asm owner              -> Transferred_to_ASM     (sets asm_id)
--
-- Data-only, strictly additive, idempotent: the predicate only matches owned
-- NULL-status leads, so once repaired they no longer match. Re-running is a
-- no-op. Apply via pgAdmin Query Tool against AWS Postgres — NOT db:push.

BEGIN;

-- 1. Audit rows first, while the predicate still matches (run before the
--    UPDATEs below). One dealer_lead_status_history row per repaired lead,
--    mirroring the touchpoint writer's from->to record. from_status = NULL
--    (the lead had no prior lifecycle status); changed_by = 'system'.
INSERT INTO dealer_lead_status_history
    (dealer_lead_id, from_status, to_status, changed_by, changed_at, reason_notes)
SELECT
    dl.id,
    NULL,
    CASE LOWER(u.role)
        WHEN 'asm' THEN 'Transferred_to_ASM'
        ELSE 'Assigned_Not_Contacted'
    END,
    'system',
    NOW(),
    'E-140 backfill: admin-assigned lead had NULL lead_status (pre-fix)'
FROM dealer_leads dl
JOIN users u ON u.id::text = dl.current_owner_id
WHERE dl.lead_status IS NULL
  AND dl.current_owner_id IS NOT NULL
  AND dl.is_active IS NOT FALSE
  AND LOWER(u.role) IN ('inside_sales_rep', 'asm');

-- 2a. Inside Sales Rep owners -> Assigned_Not_Contacted.
UPDATE dealer_leads dl
SET lead_status   = 'Assigned_Not_Contacted',
    originator_id = COALESCE(dl.originator_id, dl.current_owner_id),
    assigned_at   = COALESCE(dl.assigned_at, NOW()),
    updated_at    = NOW()
FROM users u
WHERE u.id::text = dl.current_owner_id
  AND dl.lead_status IS NULL
  AND dl.current_owner_id IS NOT NULL
  AND dl.is_active IS NOT FALSE
  AND LOWER(u.role) = 'inside_sales_rep';

-- 2b. ASM owners -> Transferred_to_ASM (ensure asm_id is populated too).
UPDATE dealer_leads dl
SET lead_status = 'Transferred_to_ASM',
    asm_id      = COALESCE(dl.asm_id, dl.current_owner_id),
    assigned_at = COALESCE(dl.assigned_at, NOW()),
    updated_at  = NOW()
FROM users u
WHERE u.id::text = dl.current_owner_id
  AND dl.lead_status IS NULL
  AND dl.current_owner_id IS NOT NULL
  AND dl.is_active IS NOT FALSE
  AND LOWER(u.role) = 'asm';

COMMIT;

-- Verification (expect 0 rows after running):
--   SELECT dl.id, dl.current_owner_id, dl.lead_status, u.role
--     FROM dealer_leads dl
--     JOIN users u ON u.id::text = dl.current_owner_id
--    WHERE dl.lead_status IS NULL AND dl.is_active IS NOT FALSE
--      AND LOWER(u.role) IN ('inside_sales_rep', 'asm');
