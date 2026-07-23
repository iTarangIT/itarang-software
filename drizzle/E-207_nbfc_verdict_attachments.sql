------------------------------------------------------------------------------
-- E-207: supporting-document attachments on an NBFC per-document verdict.
--
-- Change (NBFC KYC Action column): when the NBFC approves / rejects / requests a
-- correction on a customer or co-borrower document from the Acquire "KYC
-- verifications" table, it can attach supporting files (any type). They are
-- stored in the private nbfc-documents bucket; this column holds the list of
-- { url, name, type, size } and is surfaced to the admin in the KYC review's
-- "NBFC Actions" section.
--
-- Additive + idempotent.
------------------------------------------------------------------------------

ALTER TABLE nbfc_document_verifications
  ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT '[]'::jsonb;
