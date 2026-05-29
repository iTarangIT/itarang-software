-- E-113 — NBFC loan-product scheme highlights, active cities, eligibility docs
-- Captures the data from the "Key Scheme Highlights" sheet that ops publish to
-- dealers: per-city scheme availability, owned vs rented house fee/insurance
-- split, disbursement TAT, minimum credit score, and a free-form eligibility
-- & documents checklist. Idempotent + additive — safe to re-run.

ALTER TABLE "nbfc_loan_products"
  ADD COLUMN IF NOT EXISTS "active_cities" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "processing_fee_owned_rupees" integer,
  ADD COLUMN IF NOT EXISTS "processing_fee_rented_rupees" integer,
  ADD COLUMN IF NOT EXISTS "health_life_insurance_owned_rupees" integer,
  ADD COLUMN IF NOT EXISTS "health_life_insurance_rented_rupees" integer,
  ADD COLUMN IF NOT EXISTS "disbursement_tat_hours" integer,
  ADD COLUMN IF NOT EXISTS "min_credit_score" integer,
  ADD COLUMN IF NOT EXISTS "eligibility_documents" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- GIN index on active_cities so the dealer sanction dropdown can filter products
-- by the dealer's city using @> / ?| operators (separate ticket wires the filter).
CREATE INDEX IF NOT EXISTS "nbfc_loan_products_active_cities_gin"
  ON "nbfc_loan_products" USING GIN ("active_cities");
