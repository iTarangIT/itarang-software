-- E-112 — Per-signer Digio signing status on nbfc_lsp_agreement_signers
--
-- Adds the columns required to surface real-time signer status on the
-- admin/CEO Step 4 page once the CEO has fired the Digio sign request:
--   - digio_signer_identifier : the per-signer id Digio echoes back in
--                               webhook events (we match by email today,
--                               but Digio occasionally rewrites it).
--   - signing_status          : pending | sent | signed | failed | expired
--                               | declined (string ENUM kept loose for
--                               forward compat with new Digio states).
--   - signed_at               : per-signer e-sign completion timestamp.
--   - signing_url             : optional deep link Digio returns for
--                               re-sending the signing email.
--   - last_status_event_at    : when we last updated this row from a
--                               webhook (debug + dedupe).
--
-- Idempotent + strictly additive per CLAUDE.md migration conventions.

ALTER TABLE nbfc_lsp_agreement_signers
  ADD COLUMN IF NOT EXISTS digio_signer_identifier VARCHAR(200);

ALTER TABLE nbfc_lsp_agreement_signers
  ADD COLUMN IF NOT EXISTS signing_status VARCHAR(32) NOT NULL DEFAULT 'pending';

ALTER TABLE nbfc_lsp_agreement_signers
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

ALTER TABLE nbfc_lsp_agreement_signers
  ADD COLUMN IF NOT EXISTS signing_url TEXT;

ALTER TABLE nbfc_lsp_agreement_signers
  ADD COLUMN IF NOT EXISTS last_status_event_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_nbfc_lsp_signers_status
  ON nbfc_lsp_agreement_signers(nbfc_lsp_agreement_id, signing_status);
