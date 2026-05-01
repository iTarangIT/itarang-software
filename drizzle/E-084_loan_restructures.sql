-- E-084 — Loan Restructuring restructure-history table
-- Records every loan-restructuring event executed after the dual-approval
-- gate (E-082) approves. Links each row back to dual_approval_requests.id
-- via approval_request_id.

CREATE TABLE IF NOT EXISTS "nbfc_loan_restructures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "loan_application_id" varchar(255) NOT NULL,
  "approval_request_id" uuid NOT NULL,
  "prior_emi_amount" numeric(12, 2),
  "new_emi_amount" numeric(12, 2) NOT NULL,
  "prior_tenure_months" integer,
  "new_tenure_months" integer NOT NULL,
  "new_emi_due_dom" integer NOT NULL,
  "executed_at" timestamptz,
  CONSTRAINT "nbfc_loan_restructures_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "nbfc_tenants"("id")
);

CREATE INDEX IF NOT EXISTS "nbfc_loan_restructures_tenant_loan_idx"
  ON "nbfc_loan_restructures" ("tenant_id", "loan_application_id");
CREATE INDEX IF NOT EXISTS "nbfc_loan_restructures_approval_idx"
  ON "nbfc_loan_restructures" ("approval_request_id");
