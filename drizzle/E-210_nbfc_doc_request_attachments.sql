------------------------------------------------------------------------------
-- E-210: admin-uploaded documents on an NBFC request/message.
--
-- Until now the admin could only answer an NBFC per-document verdict
-- (nbfc_document_verifications, E-201/E-209) by forwarding it to the dealer and
-- waiting for the customer to re-upload. When the admin already HAS the correct
-- customer document, that round-trip is pure delay. This adds an admin-side
-- uploader: the admin attaches the document(s) + a message and sends them
-- straight to the NBFC as a `message` wrapper (nbfc_doc_requests, E-200) that is
-- born 'pushed_to_nbfc'.
--
--   * attachments — the uploaded files as [{url,name,type,size}] (private
--     nbfc-documents bucket, same shape/route as the E-207 verdict attachments).
--   * verdict_id  — the NBFC verdict this reply answers (NULL for a free-standing
--     admin→NBFC message), so the admin card can group the reply under the
--     verdict it belongs to.
--
-- Additive + idempotent. No backfill (existing wrappers carry no attachments).
------------------------------------------------------------------------------

DO $do$ BEGIN
  ALTER TABLE nbfc_doc_requests
    ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS verdict_id  integer;   -- nbfc_document_verifications.id
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
END; $do$;

DO $do$ BEGIN
  CREATE INDEX IF NOT EXISTS nbfc_doc_requests_verdict_idx
    ON nbfc_doc_requests (verdict_id);
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
END; $do$;

DO $do$ BEGIN
  COMMENT ON COLUMN nbfc_doc_requests.attachments IS
    'E-210 — files the admin uploaded with this request/message ([{url,name,type,size}], private nbfc-documents bucket).';
  COMMENT ON COLUMN nbfc_doc_requests.verdict_id IS
    'E-210 — the nbfc_document_verifications row this admin reply answers (NULL = free-standing admin→NBFC message).';
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
  WHEN undefined_column THEN RAISE NOTICE 'nbfc_doc_requests columns missing — skip';
END; $do$;
