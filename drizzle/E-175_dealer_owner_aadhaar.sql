-- E-175 — owner Aadhaar on dealer onboarding (for dealer-agreement signer verification).
--
-- The dealer's owner signs the onboarding agreement via Digio Aadhaar eSign, but
-- onboarding previously captured only business documents (GST / PAN / Udyam /
-- bank), so there was no owner Aadhaar to verify the SIGNING Aadhaar against — a
-- different person's Aadhaar could complete the signature. We now capture the
-- owner's Aadhaar number during onboarding and match it (last 4 digits) against
-- the masked Aadhaar Digio reports at signing. Mirrors the customer-consent gate
-- (consent_records.signer_aadhaar_masked vs personal_details.aadhaar_no).
--
-- Additive + idempotent.

ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS owner_aadhaar_no varchar(12);

ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS owner_aadhaar_verified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN dealer_onboarding_applications.owner_aadhaar_no IS
  'E-175 — owner Aadhaar number extracted from the onboarding Aadhaar upload; matched against the Digio signer Aadhaar at dealer-agreement signing.';
