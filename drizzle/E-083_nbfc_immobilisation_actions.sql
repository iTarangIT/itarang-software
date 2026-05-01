-- E-083 — Battery Immobilisation Action (gated by E-082 dual approval)
-- One row per executed immobilisation. Inserted ONLY after the corresponding
-- dual_approval_requests row transitions to 'approved' (Approver 2 = nbfc_risk_head).

CREATE TABLE IF NOT EXISTS "nbfc_immobilisation_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "loan_application_id" varchar(255) NOT NULL,
  "imei" varchar(64) NOT NULL,
  "approval_request_id" uuid NOT NULL,
  "iot_command_id" varchar(128),
  "executed_at" timestamptz,
  "borrower_notified_at" timestamptz,
  CONSTRAINT "nbfc_immobilisation_actions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "nbfc_tenants"("id")
);

CREATE INDEX IF NOT EXISTS "nbfc_immobilisation_actions_approval_request_idx"
  ON "nbfc_immobilisation_actions" ("approval_request_id");
CREATE INDEX IF NOT EXISTS "nbfc_immobilisation_actions_tenant_loan_idx"
  ON "nbfc_immobilisation_actions" ("tenant_id", "loan_application_id");
