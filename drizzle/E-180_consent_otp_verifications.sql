------------------------------------------------------------------------------
-- E-180: OTP-based customer consent (replaces Digio Aadhaar e-sign delivery).
--
-- The three consent flows (web customer KYC, co-borrower, WhatsApp new-lead)
-- move from Digio Aadhaar e-sign to a 6-digit OTP: the customer receives an OTP
-- (SMS via MSG91 / WhatsApp via Meta) and consent is recorded once verified.
-- This table mirrors calc_otp_verifications (E-178) 1:1 so the OTP secret /
-- session mechanics stay OUT of the SELECT *-ed consent_records row.
--
-- Strictly additive + idempotent — re-running is a safe no-op. See CLAUDE.md
-- "Migrations". Gated at runtime behind CONSENT_OTP_ENABLED (default ON); the
-- legacy Digio consent columns (esign_*) remain for in-flight Digio consents.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS consent_otp_verifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  lead_id           VARCHAR(255) NOT NULL,
  consent_for       VARCHAR(20)  NOT NULL DEFAULT 'primary',  -- 'primary' | 'co_borrower'
  consent_record_id VARCHAR(255),          -- audit link -> consent_records.id
  requested_by      UUID,                  -- users.id (dealer/admin who sent)
  phone             TEXT NOT NULL,         -- normalized digits: 91XXXXXXXXXX
  delivery_channel  VARCHAR(20),           -- 'sms' | 'whatsapp'
  otp_hash          TEXT NOT NULL,         -- sha256 hex of the 6-digit OTP
  expires_at        TIMESTAMPTZ NOT NULL,
  send_count        INTEGER NOT NULL DEFAULT 1,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  verified_at       TIMESTAMPTZ,
  consumed_at       TIMESTAMPTZ,           -- set when superseded after cooldown
  delivery_status   TEXT                   -- 'sent' | 'dev_hardcoded' | 'failed'
);

CREATE INDEX IF NOT EXISTS consent_otp_verif_lookup_idx
  ON consent_otp_verifications (lead_id, consent_for, created_at DESC);

-- Audit pointers on the canonical consent row (thin — the OTP session lives above).
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS otp_verification_id UUID;
ALTER TABLE consent_records ADD COLUMN IF NOT EXISTS otp_verified_at     TIMESTAMPTZ;
