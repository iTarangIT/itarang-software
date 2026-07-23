------------------------------------------------------------------------------
-- E-209: forward an NBFC per-document verdict to the dealer.
--
-- The admin "NBFC Actions" card (Change 6) lists every per-document verdict the
-- NBFC recorded (nbfc_document_verifications, E-201). Until now those verdicts
-- were read-only. This adds a "Forward to dealer" action: the admin turns a
-- 'queried' (correction requested) or 'rejected' verdict into a real dealer
-- re-upload request — a correction wrapper (nbfc_doc_requests, E-200) whose
-- otherDocumentRequests child lands on:
--   • the dealer's Step 2 (customer KYC)      when doc_for = 'primary'
--   • the dealer's Step 3 (co-borrower docs)  when doc_for = 'co_borrower'
--
-- These columns stamp which verdict has already been forwarded (so the button
-- flips to a "Forwarded" badge and a second click can't create a duplicate
-- request) and link back to the wrapper it spawned.
--
-- Additive + idempotent. No backfill (existing verdicts were never forwarded).
------------------------------------------------------------------------------

ALTER TABLE nbfc_document_verifications
  ADD COLUMN IF NOT EXISTS forwarded_at         timestamptz,
  ADD COLUMN IF NOT EXISTS forwarded_request_id varchar(255),   -- nbfc_doc_requests.id
  ADD COLUMN IF NOT EXISTS forwarded_by         uuid;           -- admin actor (users.id)

COMMENT ON COLUMN nbfc_document_verifications.forwarded_at IS
  'E-209 — when the admin forwarded this queried/rejected verdict to the dealer as a re-upload request (NULL = not yet forwarded).';
COMMENT ON COLUMN nbfc_document_verifications.forwarded_request_id IS
  'E-209 — the nbfc_doc_requests wrapper (correction) this verdict spawned.';
