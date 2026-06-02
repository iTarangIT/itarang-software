-- E-154 — Persist the customer's passive Video KYC clip (Addendum V0.3.1
-- §11.3.4 "Session Video" / §11.6 data model).
--
-- The passive flow uploads the recorded selfie video to iTarang (we hold the
-- blob), so we store it in the nbfc-documents bucket and keep the
-- `/nbfc-uploads/<key>` URL here. The Acquire VKYC review screen plays it back.
-- Null for active/own modes where no local video exists (block hidden).
--
-- Strictly additive + idempotent: ADD COLUMN IF NOT EXISTS. Re-running is a
-- no-op. Apply against AWS Postgres (the same host the app's DATABASE_URL
-- points at).

ALTER TABLE video_kyc_verifications
    ADD COLUMN IF NOT EXISTS session_video_url text;

-- Verification:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'video_kyc_verifications'
--      AND column_name = 'session_video_url';
--   -- expect 1 row
