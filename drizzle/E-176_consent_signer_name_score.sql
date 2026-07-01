-- E-176 — Consent signer name-match score
--
-- Aadhaar e-sign integrity: Digio's signed payload exposes, alongside the
-- signer's masked Aadhaar (aadhaar_suffix), a name_validation_score (0-100)
-- comparing the real Aadhaar-holder name to the name we registered. We persist
-- it on consent_records as a SECONDARY signal surfaced to admins in KYC review.
-- The PRIMARY block remains the last-4 Aadhaar-suffix match (signer_aadhaar_masked,
-- already present). Additive + idempotent; safe to re-run.

ALTER TABLE consent_records
  ADD COLUMN IF NOT EXISTS signer_name_match_score integer;
