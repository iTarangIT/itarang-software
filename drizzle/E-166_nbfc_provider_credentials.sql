-- E-166 — NBFC provider credential vault (Model B: native multi-provider e-sign).
--
-- Additive + idempotent. Lets an NBFC use their OWN e-sign provider (Leegality,
-- their own Digio account, or any future provider) by storing that provider's
-- API keys ENCRYPTED at rest (AES-256-GCM, app-held key — see
-- src/lib/nbfc/esign/crypto.ts). iTarang then calls the provider on the NBFC's
-- behalf. iTarang's shared/global Digio account remains the fallback when an
-- NBFC has configured nothing (esign_provider NULL + no vault row), so existing
-- behaviour is unchanged until an NBFC opts in.
--
-- provider_type / esign_provider are intentionally NOT CHECK-constrained — the
-- set of providers is code-owned (src/lib/nbfc/esign/registry.ts) so a new
-- provider never needs a migration.

CREATE TABLE IF NOT EXISTS nbfc_provider_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES nbfc_tenants(id),
  provider_type  varchar(24) NOT NULL,          -- 'digio' | 'leegality' | …
  environment    varchar(12) NOT NULL DEFAULT 'sandbox', -- 'sandbox' | 'production'
  -- AES-256-GCM blob of the provider's secret JSON (never stored in plaintext)
  ciphertext     text NOT NULL,
  iv             text NOT NULL,                 -- base64, 12 bytes
  auth_tag       text NOT NULL,                 -- base64, 16 bytes
  key_version    integer NOT NULL DEFAULT 1,    -- for master-key rotation
  label          text,                          -- non-secret hint (e.g. masked id)
  last_tested_at timestamptz,
  last_test_ok   boolean,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS nbfc_provider_credentials_tenant_provider_unique
  ON nbfc_provider_credentials (tenant_id, provider_type);

-- Which e-sign provider the NBFC's loan agreements use. NULL ⇒ 'digio'
-- (iTarang's global account) — i.e. today's behaviour. Only meaningful when
-- doc_agreement_method = 'digio'.
ALTER TABLE nbfc_service_config
  ADD COLUMN IF NOT EXISTS esign_provider varchar(24);

-- Records which provider owns each agreement attempt (NULL ⇒ legacy 'digio'),
-- so the webhook + signed-PDF fetch resolve the right adapter + credentials.
ALTER TABLE nbfc_loan_agreements
  ADD COLUMN IF NOT EXISTS provider_type varchar(24);

COMMENT ON TABLE nbfc_provider_credentials IS
  'E-166 — per-tenant encrypted e-sign provider credentials (Model B). Secrets are AES-256-GCM encrypted; iTarang''s global Digio account is the fallback.';
