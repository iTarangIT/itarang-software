-- migration-gate: held
-- =============================================================================
-- E-384 — ONE LEAD PER NUMBER: UNIQUE ON THE LAST 10 DIGITS OF dealer_leads.phone
--          (ID 248, written 14 Nov 2026 — HELD, NOT APPLIED)
-- =============================================================================
-- WHY.
--   dealer_leads_phone_key is unique on the raw text, so "8471083050" and
--   "+918471083050" are two keys and both got in (AI-dialer list upload, 24 Sep;
--   compare fixed 1 Oct). Field visits were repeated without the history and
--   visits could count twice. Every create path now matches on the last 10
--   digits (lib/leads/dedupe.ts loadExistingByPhone); this index makes the
--   database refuse a second copy whatever writes it.
--
-- WHEN.
--   HELD (header line 1) until: the duplicate pairs are merged
--   (scripts/dup-leads-last10.ts — dry run, Kartik's go-ahead, then --merge) and
--   Kartik approves the unique rule. Then remove the "migration-gate: held" line
--   in the same commit that records it as applied.
--
-- SAFE TO RUN EARLY: if any two ACTIVE leads still share the last 10 digits it
-- does nothing and says how many numbers are shared. A lead closed as a
-- duplicate (lead_status 'Lost', lost_reason 'duplicate_lead') and an inactive
-- lead (soft-deleted, or closed as a test lead, ID 233) are left out of the
-- rule, so neither blocks it.
--
-- Additive, idempotent. Index only: nothing for schema.ts to mirror.
-- =============================================================================

DO $do$
DECLARE
    shared integer;
BEGIN
    IF to_regclass('public.dealer_leads') IS NULL THEN
        RAISE NOTICE 'E-384: dealer_leads absent, skipping';
        RETURN;
    END IF;
    IF to_regclass('public.dealer_leads_phone_last10_uniq') IS NOT NULL THEN
        RAISE NOTICE 'E-384: already applied, skipping';
        RETURN;
    END IF;

    SELECT count(*) INTO shared FROM (
        SELECT right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)
          FROM dealer_leads
         WHERE length(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) >= 10
           AND is_active IS NOT FALSE
           AND NOT (lead_status = 'Lost' AND lost_reason = 'duplicate_lead')
         GROUP BY 1 HAVING count(*) > 1
    ) d;
    IF shared > 0 THEN
        RAISE NOTICE 'E-384: % numbers are still on more than one lead; merge them first (scripts/dup-leads-last10.ts). Nothing created.', shared;
        RETURN;
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS dealer_leads_phone_last10_uniq
        ON dealer_leads ((right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)))
     WHERE length(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) >= 10
       AND is_active IS NOT FALSE
       AND NOT (lead_status = 'Lost' AND lost_reason = 'duplicate_lead');
END
$do$;
