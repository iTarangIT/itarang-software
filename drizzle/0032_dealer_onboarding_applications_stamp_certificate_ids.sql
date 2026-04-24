-- Add stamp_certificate_ids column to dealer_onboarding_applications so that
-- src/app/api/integrations/digio/create-agreement/route.ts can persist the
-- certificate numbers returned by DigiO's estamp_request (e.g. "IN-KA...").
-- Defaults to [] so existing rows are backfilled without breaking selects.

ALTER TABLE "dealer_onboarding_applications"
  ADD COLUMN IF NOT EXISTS "stamp_certificate_ids" JSONB DEFAULT '[]'::jsonb;
