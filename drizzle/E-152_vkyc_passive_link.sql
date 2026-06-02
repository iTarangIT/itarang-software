-- E-152 — Passive Video KYC link lifecycle (Addendum V0.3.1 §11).
--
-- The NBFC operator sends the customer a single-use link (over SMS / Email /
-- WhatsApp) to record a short LIVE selfie video; the recorded video is scored
-- by Decentro's PASSIVE liveness endpoint (/v2/kyc/forensics/video_liveness).
-- These columns track how/when the link was delivered and when it expires.
-- The existing video_kyc_verifications.vkyc_ref (unique) doubles as the link
-- token — a link is valid only while status='in_progress' and not expired.
--
-- Strictly additive + idempotent (re-running is a no-op).

ALTER TABLE video_kyc_verifications
  ADD COLUMN IF NOT EXISTS link_channel varchar(16);   -- 'sms' | 'email' | 'whatsapp'
ALTER TABLE video_kyc_verifications
  ADD COLUMN IF NOT EXISTS link_sent_at timestamptz;
ALTER TABLE video_kyc_verifications
  ADD COLUMN IF NOT EXISTS link_expires_at timestamptz;
