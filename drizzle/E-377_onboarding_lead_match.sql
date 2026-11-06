-- =============================================================================
-- E-377 — EVERY ONBOARDING ON EXACTLY ONE LEAD (tracker ID 214, decided 2 Nov)
-- =============================================================================
-- WHY.
--   An onboarding linked to a lead only when a phone matched; otherwise it
--   stayed unlinked ("direct"), so it counted for nobody and the lead never
--   moved. Now, on submit, the CRM finds the lead (GSTIN > any form phone >
--   owner email > similar name in the same city / pincode, Admin chooses) or
--   creates one ('Direct onboarding'), moves it to Won and records who gets
--   the credit. Admin confirms or changes all of it at Dealer Validation
--   before approval.
--
-- WHAT. dealer_onboarding_applications gets:
--   lead_match_method        how the lead was found: gstin | phone | email |
--                            name_place | created | admin   (NULL = not yet)
--   lead_match_candidates    jsonb: leads with a similar name in the same
--                            city / pincode, for Admin to choose from
--   lead_match_at            when the match was made
--   lead_match_confirmed_at  Admin's Confirm at Dealer Validation (approval
--   lead_match_confirmed_by  waits for it)
--   lead_credit_user_id      who gets the conversion credit (NULL = nobody,
--                            e.g. a self-onboarded dealer)
--
-- NOT mirrored in schema.ts — read and written with raw SQL behind a column
-- probe (src/lib/onboarding/leadMatch.ts hasLeadMatchColumns). Without this
-- file onboarding works exactly as before (phone link only, no panel, no
-- approval gate). Additive and idempotent.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE dealer_onboarding_applications ADD COLUMN IF NOT EXISTS lead_match_method varchar(20);
    ALTER TABLE dealer_onboarding_applications ADD COLUMN IF NOT EXISTS lead_match_candidates jsonb;
    ALTER TABLE dealer_onboarding_applications ADD COLUMN IF NOT EXISTS lead_match_at timestamptz;
    ALTER TABLE dealer_onboarding_applications ADD COLUMN IF NOT EXISTS lead_match_confirmed_at timestamptz;
    ALTER TABLE dealer_onboarding_applications ADD COLUMN IF NOT EXISTS lead_match_confirmed_by text;
    ALTER TABLE dealer_onboarding_applications ADD COLUMN IF NOT EXISTS lead_credit_user_id text;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: dealer_onboarding_applications does not exist';
END;
$do$;
