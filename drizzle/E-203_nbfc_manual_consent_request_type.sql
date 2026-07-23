------------------------------------------------------------------------------
-- E-203: allow 'manual_consent' as an nbfc_doc_requests.request_type.
--
-- Change (manual DPDP consent): the NBFC can upload a consent PDF for wet/manual
-- signing. It rides the existing E-200 request loop (NBFC → Admin → Dealer →
-- Admin → NBFC) as a wrapper of a new type 'manual_consent'. This migration
-- extends the E-202 CHECK backstop to admit the new value.
--
-- Idempotent: drop-if-exists then re-add, so re-running is a no-op and it works
-- whether or not E-202 was applied on this DB. No-op with a NOTICE where the
-- E-200 table does not exist yet.
------------------------------------------------------------------------------

DO $do$ BEGIN
  ALTER TABLE nbfc_doc_requests
    DROP CONSTRAINT IF EXISTS nbfc_doc_requests_type_chk;
  ALTER TABLE nbfc_doc_requests
    ADD CONSTRAINT nbfc_doc_requests_type_chk CHECK (request_type IN (
      'correction','additional_docs','step4_extra_items','message','manual_consent'));
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
END; $do$;
