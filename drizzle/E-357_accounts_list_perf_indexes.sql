-- =============================================================================
-- E-357 — INDEXES FOR THE ACCOUNTS SCREEN (/admin/accounts)
-- =============================================================================
-- WHY. The Accounts screen was slow to load. Its queries look accounts up by
--   dealer_onboarding_applications.dealer_code (dealerAccountSql, the list's
--   source_application_id, suggestedOwners) and leads by
--   dealer_leads.dealer_onboarding_application_id, and the suggested-owner
--   hint "Closed a lead with the same GSTIN or phone" (rank 7) joins
--   dealer_leads on a normalised GSTIN and on the last ten digits of the
--   phone. None of these had an index.
--
-- WHAT. Four plain indexes. The two expression indexes match, character for
--   character, the expressions suggestedOwners() writes
--   (src/lib/accounts/ownership.ts): GSTIN_KEY(sl.gstin) from
--   src/lib/leads/gstinMatch.ts and last10(sl.phone). Change one, change the
--   other, or the planner stops using the index. Both are built only from
--   IMMUTABLE functions (COALESCE, regexp_replace, upper, NULLIF, right).
--
-- No schema.ts change (indexes only). Strictly additive, idempotent: re-running
-- is a no-op. Each block is guarded, so a database missing a table skips it.
-- =============================================================================

DO $do$
BEGIN
    CREATE INDEX IF NOT EXISTS dealer_onboarding_applications_dealer_code_idx
        ON dealer_onboarding_applications (dealer_code);
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-357: dealer_onboarding_applications.dealer_code missing — skipping';
END;
$do$;

DO $do$
BEGIN
    CREATE INDEX IF NOT EXISTS dealer_leads_onboarding_application_idx
        ON dealer_leads (dealer_onboarding_application_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-357: dealer_leads.dealer_onboarding_application_id missing — skipping';
END;
$do$;

DO $do$
BEGIN
    CREATE INDEX IF NOT EXISTS dealer_leads_gstin_key_idx
        ON dealer_leads ((NULLIF(upper(regexp_replace(COALESCE(gstin, ''), '\s', '', 'g')), '')));
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-357: dealer_leads.gstin missing — skipping';
END;
$do$;

DO $do$
BEGIN
    CREATE INDEX IF NOT EXISTS dealer_leads_phone_last10_idx
        ON dealer_leads ((right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10)));
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-357: dealer_leads.phone missing — skipping';
END;
$do$;
