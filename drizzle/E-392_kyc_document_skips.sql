-- E-392 — Battery Pool diagram 1, part 3: customer KYC document skips (19 Nov 2026).
--
-- The iTarang sales head chooses which customer KYC documents are asked
-- (app_settings 'customer_kyc_documents'). Aadhaar front/back and PAN are
-- always mandatory; every other asked document may be skipped by the dealer /
-- salesperson / customer (WhatsApp Skip button, CRM Skip link) with a typed
-- reason. Each skip is one row here; it is cleared when the document is
-- uploaded later. Shown to the iTarang admin (KYC review) and the NBFC (Acquire).
--
-- Strictly additive + idempotent.

CREATE TABLE IF NOT EXISTS kyc_document_skips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id varchar(50) NOT NULL,
  doc_for varchar(20) NOT NULL DEFAULT 'customer',
  doc_type varchar(50) NOT NULL,
  reason text NOT NULL,
  skipped_by uuid,
  skipped_by_name text,
  channel varchar(12) NOT NULL DEFAULT 'web',
  skipped_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);

CREATE INDEX IF NOT EXISTS kyc_document_skips_lead_idx
  ON kyc_document_skips (lead_id);
-- One open skip per document per lead.
CREATE UNIQUE INDEX IF NOT EXISTS kyc_document_skips_open_uniq
  ON kyc_document_skips (lead_id, doc_for, doc_type) WHERE cleared_at IS NULL;
