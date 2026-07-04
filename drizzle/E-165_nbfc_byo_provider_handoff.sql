-- E-165 — NBFC bring-your-own-provider handoff (Video KYC "own", e-Sign "own").
--
-- Additive + idempotent. Lets an NBFC run Video KYC and loan-agreement e-signing
-- on their OWN third-party provider (handoff / B2-B model): iTarang TRIGGERS the
-- step and RECORDS the canonical outcome only; the NBFC executes it on their own
-- vendor with their OWN credentials, which NEVER reach iTarang. iTarang stores
-- only the NBFC's endpoint URL + an iTarang-minted HMAC secret per rail (used to
-- sign outbound handoffs and verify inbound result callbacks).
--
-- This mirrors the existing E-NACH redirect/webhook handoff (E-134/E-145) and
-- the VKYC own-mode flag (E-135). iTarang's OWN Decentro/Digio/Razorpay
-- integrations are unaffected — they remain the 'itarang' / 'digio' options.

-- 1. Endpoint URLs the NBFC's own provider is reached at when a rail is in
--    "own" mode (analogous to the existing enach_endpoint_url).
ALTER TABLE "nbfc_service_config"
  ADD COLUMN IF NOT EXISTS "vkyc_endpoint_url"  text,
  ADD COLUMN IF NOT EXISTS "esign_endpoint_url" text;

-- 2. Per-rail HMAC signing secrets. iTarang-minted; shown read-only to the NBFC
--    so they can verify the authenticity of handoffs iTarang sends them, and so
--    iTarang can verify the result callbacks the NBFC posts back. Nullable —
--    when absent the rail stays match-by-ref (the existing E-NACH behaviour).
ALTER TABLE "nbfc_service_config"
  ADD COLUMN IF NOT EXISTS "vkyc_webhook_secret"  text,
  ADD COLUMN IF NOT EXISTS "enach_webhook_secret" text,
  ADD COLUMN IF NOT EXISTS "esign_webhook_secret" text;

-- 3. Allow the new 'own_esign' agreement method on BOTH the service config and
--    the agreement row. DROP + re-ADD so the extended allow-list is idempotent
--    (existing rows hold only the legacy subset, so re-validation passes).
ALTER TABLE "nbfc_service_config"
  DROP CONSTRAINT IF EXISTS "nbfc_service_config_agreement_method_check";
DO $do$ BEGIN
  ALTER TABLE "nbfc_service_config"
    ADD CONSTRAINT "nbfc_service_config_agreement_method_check"
    CHECK ("doc_agreement_method" IS NULL OR "doc_agreement_method" IN ('upload', 'digio', 'api_autofetch', 'own_esign'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: agreement_method check exists';
END; $do$;

ALTER TABLE "nbfc_loan_agreements"
  DROP CONSTRAINT IF EXISTS "nbfc_loan_agreements_method_check";
DO $do$ BEGIN
  ALTER TABLE "nbfc_loan_agreements"
    ADD CONSTRAINT "nbfc_loan_agreements_method_check"
    CHECK ("method" IS NULL OR "method" IN ('upload', 'digio', 'api_autofetch', 'own_esign'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: method check exists';
END; $do$;

COMMENT ON COLUMN "nbfc_service_config"."vkyc_endpoint_url" IS
  'E-165 — NBFC own-provider Video KYC handoff URL (used when vkyc_mode=own).';
COMMENT ON COLUMN "nbfc_service_config"."esign_endpoint_url" IS
  'E-165 — NBFC own-provider e-Sign handoff URL (used when doc_agreement_method=own_esign).';
