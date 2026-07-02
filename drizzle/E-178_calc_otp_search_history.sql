------------------------------------------------------------------------------
-- E-178: OTP verification gate for the dealer loan calculator + WhatsApp
--        results delivery stamps on calc_leads (admin Search History).
--
-- The dealer must send a WhatsApp OTP to the customer's phone and verify it
-- before /api/dealer/calculator/calculate will run. Each verified calculation
-- is stamped onto calc_leads and the scheme summary is sent to the customer
-- on WhatsApp. Idempotent + strictly additive.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS calc_otp_verifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- users.id of the dealer user who requested the OTP. This is the matching
  -- key between send/verify/calculate (users.dealer_id can be NULL).
  created_by     UUID NOT NULL,
  dealer_id      VARCHAR(255),          -- dealer code, reporting only
  phone          TEXT NOT NULL,         -- normalized digits: 91XXXXXXXXXX
  customer_name  TEXT,
  otp_hash       TEXT NOT NULL,         -- sha256 hex of the 6-digit OTP
  expires_at     TIMESTAMPTZ NOT NULL,
  send_count     INTEGER NOT NULL DEFAULT 1,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  verified_at    TIMESTAMPTZ,
  consumed_at    TIMESTAMPTZ,           -- set when superseded after cooldown
  wa_status      TEXT                   -- 'sent' | 'dev_hardcoded' | 'failed'
);
CREATE INDEX IF NOT EXISTS calc_otp_verif_lookup_idx
  ON calc_otp_verifications (created_by, phone, created_at DESC);

ALTER TABLE calc_leads ADD COLUMN IF NOT EXISTS otp_verification_id UUID REFERENCES calc_otp_verifications (id);
ALTER TABLE calc_leads ADD COLUMN IF NOT EXISTS otp_verified_at     TIMESTAMPTZ;
ALTER TABLE calc_leads ADD COLUMN IF NOT EXISTS wa_results_status   TEXT;        -- 'sent' | 'failed' | 'skipped'
ALTER TABLE calc_leads ADD COLUMN IF NOT EXISTS wa_results_sent_at  TIMESTAMPTZ;
