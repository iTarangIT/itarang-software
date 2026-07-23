------------------------------------------------------------------------------
-- E-204: allow 'co_borrower' as an nbfc_doc_requests.request_type.
--
-- Change (NBFC-initiated co-borrower): when the admin never requested a
-- co-borrower but the NBFC wants one, the NBFC raises a 'co_borrower' request.
-- It rides the existing E-200 loop (NBFC → Admin), and the admin actions it with
-- a one-click "Request co-borrower from dealer" that triggers the standard
-- dealer co-borrower KYC flow. This migration extends the E-202 CHECK backstop
-- to admit the new value.
--
-- Idempotent: drop-if-exists then re-add, so re-running is a no-op and it works
-- whether or not E-202/E-203 were applied on this DB. No-op with a NOTICE where
-- the E-200 table does not exist yet.
------------------------------------------------------------------------------

DO $do$ BEGIN
  ALTER TABLE nbfc_doc_requests
    DROP CONSTRAINT IF EXISTS nbfc_doc_requests_type_chk;
  ALTER TABLE nbfc_doc_requests
    ADD CONSTRAINT nbfc_doc_requests_type_chk CHECK (request_type IN (
      'correction','additional_docs','step4_extra_items','message','manual_consent','co_borrower'));
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
END; $do$;
