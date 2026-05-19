-- E-115 — NBFC loan-product CIBIL/CRIF applicability flag + max credit score
-- Extends the Scheme Highlights model so a scheme can explicitly opt out of
-- bureau-score enforcement (cibil_required = false) and so the score window is
-- expressed as a closed [min, max] range instead of a single floor. Mirrors the
-- redesigned admin form (NbfcLoanProductForm.tsx). Idempotent + additive.

ALTER TABLE "nbfc_loan_products"
  ADD COLUMN IF NOT EXISTS "cibil_required" boolean,
  ADD COLUMN IF NOT EXISTS "max_credit_score" integer;

-- Range guard: 300-900 inclusive, matching min_credit_score's documented range.
DO $do$ BEGIN
  ALTER TABLE "nbfc_loan_products"
    ADD CONSTRAINT "nbfc_loan_products_max_credit_score_range"
    CHECK ("max_credit_score" IS NULL OR ("max_credit_score" BETWEEN 300 AND 900));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: max_credit_score range check exists';
END; $do$;
