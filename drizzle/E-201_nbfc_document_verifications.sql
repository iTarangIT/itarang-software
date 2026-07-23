------------------------------------------------------------------------------
-- E-201: nbfc_document_verifications — the NBFC's OWN per-document KYC verdict.
--
-- Change 1 of the Acquire change request: the NBFC partner must be able to
-- verify each customer / co-borrower document inside its own dashboard, exactly
-- like the admin KYC cards — but recorded PER NBFC and kept SEPARATE from the
-- admin's own verification (which lives in kyc_verification_metadata / the admin
-- KYC cards). Two NBFCs on the same lead each keep their own verdict.
--
-- One verdict per (assignment, doc_for, doc_key) — upsert. verdict='queried' is
-- the soft state that typically triggers a request_type='correction' wrapper
-- (E-200) but is recorded independently so the NBFC can flag a doc without
-- forcing a full round.
--
-- Feeds the admin "NBFC KYC Verification" card (Change 6): the admin CaseReview
-- reads these rows + the open nbfc_doc_requests, grouped by nbfc_id.
--
-- Additive + idempotent. No backfill (no NBFC verdicts exist yet).
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS nbfc_document_verifications (
  id             serial PRIMARY KEY,
  lead_id        varchar(255) NOT NULL,
  assignment_id  uuid NOT NULL,                            -- nbfc_lead_assignments.id
  nbfc_id        integer NOT NULL,                         -- nbfc.id (serial int)
  tenant_id      uuid NOT NULL,                            -- nbfc_tenants.id (session scope)
  doc_for        varchar(20) NOT NULL DEFAULT 'primary',   -- 'primary'|'co_borrower'
  doc_key        varchar(120) NOT NULL,                    -- 'aadhaar'|'pan'|'bank'|'cibil'|'rc'|<doc_key>
  verdict        varchar(16) NOT NULL DEFAULT 'pending',   -- 'pending'|'verified'|'queried'|'rejected'
  notes          text,
  verified_by    uuid NOT NULL,                            -- NBFC actor (resolveActor.user_id)
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One verdict per NBFC per document — the upsert conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS nbfc_document_verifications_unique
  ON nbfc_document_verifications (assignment_id, doc_for, doc_key);
CREATE INDEX IF NOT EXISTS nbfc_document_verifications_lead_idx
  ON nbfc_document_verifications (lead_id);
CREATE INDEX IF NOT EXISTS nbfc_document_verifications_nbfc_idx
  ON nbfc_document_verifications (nbfc_id);

COMMENT ON TABLE nbfc_document_verifications IS
  'E-201 — per-NBFC KYC verdict on each customer/co-borrower document, separate from the admin verification. One row per (assignment_id, doc_for, doc_key); upsert. verdict: pending|verified|queried|rejected. Feeds the admin NBFC-KYC-Verification card.';
