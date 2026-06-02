-- E-140 — Addendum V0.2 §6.1 (Competitive NBFC Routing, Stage 1). The firm
-- financing conditions an NBFC submits for a routed lead in its Acquire
-- workspace. The customer (dealer-mediated) compares offers across the picked
-- NBFCs and selects the winner; selecting a winner flips
-- nbfc_lead_assignments.status to 'selected' (loser → 'not_selected'), which is
-- exactly what enach.getWinningAssignment() reads to gate winner-only E-NACH.
--
-- One operative offer row per assignment (unique on assignment_id); resubmission
-- updates the same row. Strictly additive + idempotent — re-running is a no-op.

CREATE TABLE IF NOT EXISTS "nbfc_financing_offers" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assignment_id"   uuid NOT NULL,
  "lead_id"         varchar(50) NOT NULL,
  "nbfc_id"         integer NOT NULL,
  "tenant_id"       uuid NOT NULL,
  "roi_pct"         numeric(5,2),
  "emi_amount"      numeric(14,2),
  "tenure_months"   integer,
  "loan_amount"     numeric(14,2),
  "down_payment"    numeric(14,2),
  "processing_fee"  numeric(14,2),
  "conditions"      text,
  "valid_until"     date,
  "status"          varchar(16) NOT NULL DEFAULT 'active',
  "submitted_by"    uuid,
  "submitted_at"    timestamptz NOT NULL DEFAULT now(),
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

DO $do$ BEGIN
  ALTER TABLE "nbfc_financing_offers"
    ADD CONSTRAINT "nbfc_financing_offers_status_check"
    CHECK ("status" IN ('active', 'withdrawn'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'skip: nbfc_financing_offers_status_check exists';
END; $do$;

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_financing_offers_assignment_unique"
  ON "nbfc_financing_offers" ("assignment_id");

CREATE INDEX IF NOT EXISTS "nbfc_financing_offers_lead_idx"
  ON "nbfc_financing_offers" ("lead_id");

CREATE INDEX IF NOT EXISTS "nbfc_financing_offers_tenant_idx"
  ON "nbfc_financing_offers" ("tenant_id");

COMMENT ON TABLE "nbfc_financing_offers" IS
  'Addendum V0.2 §6.1 — firm financing conditions an NBFC submits for a routed lead. One operative row per nbfc_lead_assignments (resubmission updates). The dealer compares offers and picks the winner (sets assignment status selected/not_selected).';
