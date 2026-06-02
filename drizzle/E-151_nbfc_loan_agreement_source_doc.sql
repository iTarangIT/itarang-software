-- E-151 — Addendum V0.3.1 §17. iTarang eSign mechanism for the borrower loan
-- agreement: the NBFC uploads the UNSIGNED agreement PDF, then the customer (+
-- the NBFC signatory) sign it via Digio uploadpdf. Track the uploaded source
-- PDF so /api/nbfc/agreement/[leadId]/initiate can hand it to Digio.
--
-- Strictly additive + idempotent.

ALTER TABLE "nbfc_loan_agreements"
  ADD COLUMN IF NOT EXISTS "source_document_url" text;
