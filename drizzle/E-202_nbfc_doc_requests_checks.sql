------------------------------------------------------------------------------
-- E-202: CHECK backstops for nbfc_doc_requests (E-200).
--
-- App-level validation is the primary gate; these constraints are the DB-side
-- backstop so a bad write fails loudly rather than corrupting the thread state.
--   * item_count <= 10 — the Step-4 extra-items cap (Change 4). 10 is also a
--     sane ceiling for every other request type, so the constraint is global.
--   * status / request_type / verdict restricted to the known enum values.
--
-- Idempotent: each ADD CONSTRAINT is guarded so re-running is a no-op. No-ops
-- with a NOTICE where the E-200/E-201 tables do not exist yet.
------------------------------------------------------------------------------

DO $do$ BEGIN
  ALTER TABLE nbfc_doc_requests
    ADD CONSTRAINT nbfc_doc_requests_item_count_max CHECK (item_count <= 10);
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'nbfc_doc_requests_item_count_max exists — skip';
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE nbfc_doc_requests
    ADD CONSTRAINT nbfc_doc_requests_status_chk CHECK (status IN (
      'nbfc_raised','admin_review','forwarded_to_dealer','with_customer',
      'dealer_review','admin_review_upload','pushed_to_nbfc','closed','rejected'));
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'nbfc_doc_requests_status_chk exists — skip';
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE nbfc_doc_requests
    ADD CONSTRAINT nbfc_doc_requests_type_chk CHECK (request_type IN (
      'correction','additional_docs','step4_extra_items','message'));
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'nbfc_doc_requests_type_chk exists — skip';
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_doc_requests missing (E-200 not applied) — skip';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE nbfc_document_verifications
    ADD CONSTRAINT nbfc_document_verifications_verdict_chk CHECK (verdict IN (
      'pending','verified','queried','rejected'));
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'nbfc_document_verifications_verdict_chk exists — skip';
  WHEN undefined_table THEN RAISE NOTICE 'nbfc_document_verifications missing (E-201 not applied) — skip';
END; $do$;
