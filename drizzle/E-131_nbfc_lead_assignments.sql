-- E-131 — BRD Addendum V0.1 §6 (Competitive NBFC Routing). Phase A1 of the
-- Acquire workspace roadmap: routing & queue. One row per (lead × selected
-- NBFC) is created when the dealer submits Step 4 for a finance lead. Each
-- selected NBFC's Acquire queue reads its own rows tenant-scoped.
--
-- Strictly additive + idempotent. Status check uses the full A3+ enum so a
-- later phase can write 'in_progress' / 'offer_submitted' / 'selected' /
-- 'not_selected' / 'declined' / 'withdrawn' without re-touching DDL.
--
-- tenant_id is denormalised from nbfc.tenant_id so the tenant-scoped queue
-- query is a single index hit. If an nbfc row is ever repointed to a new
-- tenant (E-026B legal-name rebind has done this), assignments must be
-- backfilled with:
--   UPDATE nbfc_lead_assignments la
--   SET    tenant_id = n.tenant_id
--   FROM   nbfc n
--   WHERE  n.id = la.nbfc_id AND la.tenant_id IS DISTINCT FROM n.tenant_id;

CREATE TABLE IF NOT EXISTS "nbfc_lead_assignments" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id"         varchar(50) NOT NULL,
  "nbfc_id"         integer NOT NULL,
  "tenant_id"       uuid NOT NULL,
  "loan_product_id" integer,
  "status"          varchar(30) NOT NULL DEFAULT 'pending',
  "assigned_at"     timestamptz NOT NULL DEFAULT now(),
  "decided_at"      timestamptz,
  "decision_reason" text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

DO $do$ BEGIN
  ALTER TABLE "nbfc_lead_assignments"
    ADD CONSTRAINT "nbfc_lead_assignments_status_check"
    CHECK ("status" IN (
      'pending',
      'in_progress',
      'offer_submitted',
      'selected',
      'not_selected',
      'declined',
      'withdrawn'
    ));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'skip: nbfc_lead_assignments_status_check exists';
END; $do$;

CREATE INDEX IF NOT EXISTS "nbfc_lead_assignments_tenant_idx"
  ON "nbfc_lead_assignments" ("tenant_id", "status", "assigned_at" DESC);

CREATE INDEX IF NOT EXISTS "nbfc_lead_assignments_lead_idx"
  ON "nbfc_lead_assignments" ("lead_id");

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_lead_assignments_unique_lead_nbfc"
  ON "nbfc_lead_assignments" ("lead_id", "nbfc_id");

COMMENT ON TABLE "nbfc_lead_assignments" IS
  'Addendum V0.1 §6 — one row per (lead × selected NBFC) created at Step 4 submit. Drives the Acquire queue (/nbfc/acquire). tenant_id is denormalised from nbfc.tenant_id for queue-page index performance.';

COMMENT ON COLUMN "nbfc_lead_assignments"."nbfc_id" IS
  'nbfc.id (integer serial PK). selected_nbfcs on product_selections stores the same value as a stringified integer.';

COMMENT ON COLUMN "nbfc_lead_assignments"."tenant_id" IS
  'nbfc_tenants.id — denormalised from nbfc.tenant_id. Backfill if an nbfc row is repointed; see migration header.';

COMMENT ON COLUMN "nbfc_lead_assignments"."loan_product_id" IS
  'nbfc_loan_products.id — the product the customer indicated interest in at Section G. Nullable because Section G allows picking an NBFC without committing to a specific product.';

COMMENT ON COLUMN "nbfc_lead_assignments"."status" IS
  'Lifecycle: pending → in_progress → offer_submitted → selected | not_selected | declined | withdrawn. A1 only writes pending; later phases drive the rest.';
