-- E-106: Backfill canonical `dealers` rows for previously approved
-- applications whose admin-approval flow never wrote to `dealers`.
--
-- Root cause: the admin approval route only updated
-- `dealer_onboarding_applications`, `accounts`, and `users` — it never
-- inserted into the canonical `dealers` table. The E-105 lead-creation
-- gate (src/app/api/leads/create/route.ts) queries `dealers` and falls
-- through to `currentStatus: 'not_onboarded'`, blocking lead creation
-- for every admin-approved dealer.
--
-- The forward fix lives in the approval route. This migration repairs
-- the in-flight state for already-approved dealers so they don't have
-- to be re-approved.
--
-- Idempotent: ON CONFLICT (dealer_id) DO NOTHING — re-running is safe.

DO $do$ BEGIN
  INSERT INTO dealers (
    dealer_id,
    company_name,
    company_type,
    gst_number,
    pan_number,
    registered_address,
    bank_name,
    bank_account_number,
    bank_ifsc,
    bank_beneficiary,
    owner_name,
    owner_phone,
    owner_email,
    finance_enabled,
    onboarding_status,
    application_id,
    activated_at
  )
  SELECT
    a.dealer_code,
    a.company_name,
    COALESCE(a.company_type, 'individual'),
    a.gst_number,
    a.pan_number,
    a.registered_address,
    a.bank_name,
    a.account_number,
    a.ifsc_code,
    a.beneficiary_name,
    a.owner_name,
    a.owner_phone,
    a.owner_email,
    COALESCE(a.finance_enabled, false),
    'active',
    a.id::text,
    COALESCE(a.approved_at, NOW())
  FROM dealer_onboarding_applications a
  WHERE a.onboarding_status = 'approved'
    AND a.dealer_code IS NOT NULL
  ON CONFLICT (dealer_id) DO NOTHING;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'dealers / dealer_onboarding_applications missing — skipping E-106 backfill';
END; $do$;
