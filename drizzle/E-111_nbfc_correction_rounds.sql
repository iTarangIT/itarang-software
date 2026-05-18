-- E-111 — CEO per-item correction request rounds for NBFC onboarding
--
-- The CEO review page now lets the CEO flag specific master-detail fields,
-- compliance documents, LSP agreement signers (name/email/designation),
-- signer identity documents, and the agreement template — each with its own
-- remark — and send the bundle back to the Admin as one "correction round".
-- Admin sees the flagged items on the Step 4 approval page, fixes them via
-- the existing edit pages, and resubmits. The transition handler then
-- auto-resolves every open item by snapshotting the new value/file URL.
--
-- One submission = one round (auto-numbered per NBFC). Each flag is keyed by
-- a stable string `target_key` (not a row id) so a doc re-upload, which
-- creates a fresh `nbfc_compliance_documents.id`, still resolves the same
-- item. See `src/lib/nbfc/admin/correction-catalog.ts` for the key catalog.
--
-- Idempotent + strictly additive per CLAUDE.md migration conventions.

CREATE TABLE IF NOT EXISTS nbfc_correction_rounds (
  id              SERIAL PRIMARY KEY,
  nbfc_id         INTEGER NOT NULL REFERENCES nbfc(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'open', -- open | resolved | superseded
  requested_by    UUID NOT NULL,
  summary_remarks TEXT,
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nbfc_correction_rounds_unique UNIQUE (nbfc_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_nbfc_correction_rounds_nbfc_status
  ON nbfc_correction_rounds(nbfc_id, status);

CREATE TABLE IF NOT EXISTS nbfc_correction_items (
  id                 SERIAL PRIMARY KEY,
  round_id           INTEGER NOT NULL REFERENCES nbfc_correction_rounds(id) ON DELETE CASCADE,
  kind               VARCHAR(24) NOT NULL, -- master_field | compliance_doc | signer_field | signer_identity_doc | agreement_template
  target_key         VARCHAR(120) NOT NULL,
  target_ref_id      INTEGER,
  previous_value     TEXT,
  previous_file_url  TEXT,
  remark             TEXT,
  resolution_status  VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | resolved | dismissed
  new_value          TEXT,
  new_file_url       TEXT,
  resolved_at        TIMESTAMPTZ,
  resolved_by        UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT nbfc_correction_items_unique UNIQUE (round_id, kind, target_key)
);

CREATE INDEX IF NOT EXISTS idx_nbfc_correction_items_round_status
  ON nbfc_correction_items(round_id, resolution_status);
