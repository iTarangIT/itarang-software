-- E-030 — PCI nightly computation (BRD §6.1.5)
-- Adds nbfc_risk_alerts for the Risk Alerts surface (PCI<0.40 fires
-- type='pci_low' rows). emi_schedules is already created by a prior migration
-- in this codebase, so we use IF NOT EXISTS guards to keep the migration
-- idempotent.

CREATE TABLE IF NOT EXISTS "emi_schedules" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "loan_sanction_id" varchar(255) NOT NULL,
    "due_date" date NOT NULL,
    "paid_at" timestamp with time zone,
    "status" varchar(16) NOT NULL,
    "days_overdue" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "emi_schedules_loan_idx"
    ON "emi_schedules" ("loan_sanction_id");
CREATE INDEX IF NOT EXISTS "emi_schedules_loan_due_idx"
    ON "emi_schedules" ("loan_sanction_id", "due_date");

CREATE TABLE IF NOT EXISTS "nbfc_risk_alerts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "tenant_id" uuid NOT NULL,
    "borrower_id" uuid NOT NULL,
    "loan_sanction_id" uuid NOT NULL,
    "type" varchar(32) NOT NULL,
    "severity" varchar(16) NOT NULL,
    "payload" jsonb,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "resolved_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "nbfc_risk_alerts_tenant_idx"
    ON "nbfc_risk_alerts" ("tenant_id");
CREATE INDEX IF NOT EXISTS "nbfc_risk_alerts_borrower_idx"
    ON "nbfc_risk_alerts" ("borrower_id");
CREATE INDEX IF NOT EXISTS "nbfc_risk_alerts_loan_sanction_idx"
    ON "nbfc_risk_alerts" ("loan_sanction_id");
CREATE INDEX IF NOT EXISTS "nbfc_risk_alerts_type_idx"
    ON "nbfc_risk_alerts" ("type");
CREATE INDEX IF NOT EXISTS "nbfc_risk_alerts_created_at_idx"
    ON "nbfc_risk_alerts" ("created_at");
