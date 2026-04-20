-- Add agreement_language column to dealer_onboarding_applications so the admin
-- verifications PATCH endpoint (src/app/api/admin/dealer-verifications/[dealerId]/route.ts)
-- can persist the dealer's selected agreement language without an (row as any) cast.
-- NOT NULL with default 'english' so existing rows are backfilled.

ALTER TABLE "dealer_onboarding_applications"
  ADD COLUMN IF NOT EXISTS "agreement_language" VARCHAR(30) NOT NULL DEFAULT 'english';
