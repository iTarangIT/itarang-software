-- E-026 — Apply the loan_sanctions NBFC lifecycle columns that schema.ts
-- already declares (see schema.ts comment "E-026 prereq (G-03)").
-- These columns power the NBFC Portfolio Overview page (/nbfc/portfolio):
--   nbfc_id           — UUID of the owning portal tenant (nbfc_tenants.id)
--   disbursed_at      — funds-disbursed timestamp (drives "Disbursement This Month")
--   closed_at         — loan-closed timestamp (active book = closed_at IS NULL)
--   recovery_flagged_at + recovery_reason — E-035 recovery markers
--
-- Strictly additive. Idempotent: safe to re-run on any sandbox whether or not
-- a previous `db:push` already added these columns.

DO $do$
BEGIN
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "nbfc_id" uuid;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "disbursed_at" timestamp with time zone;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "recovery_flagged_at" timestamp with time zone;
  ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "recovery_reason" text;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping loan_sanctions: table does not exist on this DB';
END;
$do$;

CREATE INDEX IF NOT EXISTS "loan_sanctions_nbfc_status_idx"
  ON "loan_sanctions" ("nbfc_id", "status") WHERE "nbfc_id" IS NOT NULL;
