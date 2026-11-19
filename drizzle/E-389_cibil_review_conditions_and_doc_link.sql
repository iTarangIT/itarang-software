-- migration-gate: held
-- E-389 — CIBIL review: "Approve with conditions" + "Request additional documents"
-- (Battery Pool workflow diagrams 1 + 3, 19 Nov 2026; follows E-387 / E-388).
--
-- The parent (e.g. Saleem) can now, on a pending CIBIL report:
--   * approve with conditions — the review is 'approved' as before and the
--     conditions text is kept and shown on the lead (nothing is blocked);
--   * request additional documents — an ordinary NBFC document request
--     ('additional_docs', routed through the iTarang admin) linked back to the
--     review, which stays 'pending' until the documents return.
--
--   nbfc_cibil_reviews.conditions      text  NULL ⇒ plain approve / not decided.
--   nbfc_doc_requests.cibil_review_id  uuid  NULL ⇒ not raised from a CIBIL review.
--
-- Strictly additive + idempotent. No status / request_type values change.

ALTER TABLE nbfc_cibil_reviews ADD COLUMN IF NOT EXISTS conditions text;

ALTER TABLE nbfc_doc_requests ADD COLUMN IF NOT EXISTS cibil_review_id uuid;

CREATE INDEX IF NOT EXISTS nbfc_doc_requests_cibil_review_idx
  ON nbfc_doc_requests (cibil_review_id)
  WHERE cibil_review_id IS NOT NULL;
