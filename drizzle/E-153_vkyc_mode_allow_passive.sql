-- E-153 — allow 'passive' video-KYC mode (Addendum V0.3.1 §11).
--
-- The passive capture-link flow (E-152) writes mode='passive' on every
-- "Send VKYC link" initiate, but the original CHECK constraint only allowed
-- 'own' | 'itarang', so the INSERT … ON CONFLICT violated
-- video_kyc_verifications_mode_check and the whole send failed.
--
-- Widen the allowed set to include 'passive'. This is additive — the new
-- constraint accepts a superset of the prior values, so no existing row can
-- become invalid. Idempotent: drop-if-exists then add (re-running is a no-op).

DO $do$
BEGIN
  ALTER TABLE video_kyc_verifications
    DROP CONSTRAINT IF EXISTS video_kyc_verifications_mode_check;
  ALTER TABLE video_kyc_verifications
    ADD CONSTRAINT video_kyc_verifications_mode_check
    CHECK (mode IN ('own', 'itarang', 'passive'));
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'skip: video_kyc_verifications not present';
END;
$do$;
