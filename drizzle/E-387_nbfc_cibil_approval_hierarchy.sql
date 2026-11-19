-- E-387 — NBFC parent / child CIBIL approval hierarchy (Battery Pool, 19 Nov 2026).
--
-- A child user (e.g. Abhishek) uploads the CIBIL report + a note on an Acquire
-- lead and sends it to his parent (e.g. Saleem, the NBFC admin). The parent
-- approves or rejects (reason mandatory). After approval the parent owns the
-- lead; the child may act only on the steps the NBFC admin delegated to him.
--
-- Strictly additive + idempotent.
--   nbfc_users.parent_user_id      — set ⇒ this login is a child of that user (same tenant)
--   nbfc_users.delegated_steps     — steps the admin let the child act on after approval
--   nbfc_tenants.cibil_review_enabled_at — set ⇒ "CIBIL approval required before any
--                                    other step" for leads assigned on/after this time
--   nbfc_cibil_reviews             — one row per CIBIL submission (pending/approved/rejected)

ALTER TABLE nbfc_users ADD COLUMN IF NOT EXISTS parent_user_id uuid;
ALTER TABLE nbfc_users ADD COLUMN IF NOT EXISTS delegated_steps jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE nbfc_tenants ADD COLUMN IF NOT EXISTS cibil_review_enabled_at timestamptz;

CREATE TABLE IF NOT EXISTS nbfc_cibil_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES nbfc_tenants(id),
  lead_id varchar(50) NOT NULL,
  assignment_id uuid NOT NULL,
  submitted_by uuid NOT NULL,
  approver_user_id uuid NOT NULL,
  report_url text NOT NULL,
  report_file_name text,
  cibil_score integer,
  note text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  decision_reason text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nbfc_cibil_reviews_status_chk CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS nbfc_cibil_reviews_lead_idx
  ON nbfc_cibil_reviews (tenant_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS nbfc_cibil_reviews_approver_idx
  ON nbfc_cibil_reviews (approver_user_id, status);
-- At most one open (pending) submission per lead per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS nbfc_cibil_reviews_one_pending_uniq
  ON nbfc_cibil_reviews (tenant_id, lead_id) WHERE status = 'pending';
