------------------------------------------------------------------------------
-- E-205: per-NBFC DPDP consent template.
--
-- Change (NBFC-owned consent): the NBFC uploads ONE consent-template PDF in its
-- Settings, reused across all leads. The Acquire DPDP e-sign/OTP flow signs THIS
-- document instead of the per-lead iTarang-generated consent. Stored in the
-- private nbfc-documents bucket; the column holds the /nbfc-uploads/<key> proxy
-- path (same scheme as the LSP agreement_template_url precedent).
--
-- Additive + idempotent. Keyed per tenant on the existing nbfc_service_config
-- row (uuid tenant_id).
------------------------------------------------------------------------------

ALTER TABLE nbfc_service_config
  ADD COLUMN IF NOT EXISTS consent_template_url text;

ALTER TABLE nbfc_service_config
  ADD COLUMN IF NOT EXISTS consent_template_size integer;
