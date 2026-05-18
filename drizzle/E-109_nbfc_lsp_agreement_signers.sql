-- E-109 — N-signer child table for nbfc_lsp_agreements
--
-- The Step 3 "Agreement" page now supports a dynamic number of signers per
-- party (NBFC and iTarang), each with name + email + designation + a mandatory
-- identity document URL (PAN / Aadhaar / Passport scan, ≤ 5 MB, PDF/JPG/PNG).
-- The legacy 3 hardcoded signer columns on nbfc_lsp_agreements
-- (nbfc_signatory_*, itarang_signatory_1_*, itarang_signatory_2_*) stay
-- nullable for backward compat; new initiations write only to this child
-- table going forward.
--
-- Idempotent + strictly additive per CLAUDE.md migration conventions.

CREATE TABLE IF NOT EXISTS nbfc_lsp_agreement_signers (
  id                       SERIAL PRIMARY KEY,
  nbfc_lsp_agreement_id    INTEGER NOT NULL REFERENCES nbfc_lsp_agreements(id),
  signer_order             INTEGER NOT NULL,
  party                    VARCHAR(20) NOT NULL,
  full_name                VARCHAR(200) NOT NULL,
  email                    VARCHAR(200) NOT NULL,
  designation              VARCHAR(120) NOT NULL,
  identity_document_url    TEXT NOT NULL,
  identity_document_size   INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nbfc_lsp_agreement_signers_agreement
  ON nbfc_lsp_agreement_signers(nbfc_lsp_agreement_id, signer_order);
