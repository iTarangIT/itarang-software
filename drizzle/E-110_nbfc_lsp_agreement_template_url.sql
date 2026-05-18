-- E-110 — add agreement_template_url to nbfc_lsp_agreements
--
-- Step 3 ("Agreement") now requires the admin to upload the blank /
-- empty-fields template PDF (the document Digio will eventually paint and
-- send to signers). The URL of this uploaded template is held on the
-- parent agreement row. Digio is no longer called at Step 3 — that moves
-- to the CEO approval gate, which reads this URL.
--
-- Idempotent + strictly additive per CLAUDE.md.

ALTER TABLE nbfc_lsp_agreements
  ADD COLUMN IF NOT EXISTS agreement_template_url TEXT,
  ADD COLUMN IF NOT EXISTS agreement_template_size INTEGER;
