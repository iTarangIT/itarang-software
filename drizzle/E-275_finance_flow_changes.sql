-- E-275 — Customer-onboarding finance flow changes (2026-08-29).
--
-- Five additive column groups backing ten product changes to the Step 4 →
-- NBFC → Step 5 leg. Nothing here is dropped, narrowed or backfilled; every
-- column is nullable so existing rows keep working unchanged.
--
--   1. leads.requested_loan_amount — "Up to how much loan do you want?" asked
--      after KYC / co-borrower and BEFORE the lender list. Loan products are
--      shown only when this amount ≤ the product's loan_amount_max.
--   2. leads.recalled_at / recalled_by / recall_note / resubmitted_at — the
--      admin "Recall" (file pulled back from the dealer + NBFC for edits) and
--      the matching "Resubmit". Manual only; no SLA.
--   3. nbfc_lead_assignments.rejection_* — an NBFC rejecting the file. The
--      assignment flips to the reserved-but-never-written status 'declined';
--      the rejection sits with the admin until a human forwards it or the
--      configured SLA (app_settings.nbfc_request_sla.rejectionSlaMinutes)
--      auto-pushes it to the dealer, who may then choose another NBFC.
--   4. loan_sanctions.external_lender / product_selections.external_lender —
--      the "Bajaj Finance" card shown when no on-platform partner serves the
--      customer's state/city or amount. The dealer proceeds straight to Step 5
--      with a sanction record naming the outside lender; no NBFC ever sees
--      the file.
--
-- REQUIRED before the code deploys: `leads`, `product_selections`,
-- `loan_sanctions` and `nbfc_lead_assignments` are all mirrored in schema.ts,
-- so every INSERT/SELECT on them names these columns.
-- Re-running this file is a no-op.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "requested_loan_amount" integer;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "recalled_at" timestamptz;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "recalled_by" uuid;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "recall_note" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "resubmitted_at" timestamptz;

COMMENT ON COLUMN "leads"."requested_loan_amount" IS
  'E-275: loan amount the dealer/customer asked for at Step 4; products with loan_amount_max below this are hidden.';
COMMENT ON COLUMN "leads"."recalled_at" IS
  'E-275: admin recalled the file from the dealer/NBFC for edits. Cleared semantically by resubmitted_at > recalled_at.';

DO $do$ BEGIN
  ALTER TABLE "nbfc_lead_assignments" ADD COLUMN IF NOT EXISTS "rejection_note" text;
  ALTER TABLE "nbfc_lead_assignments" ADD COLUMN IF NOT EXISTS "rejection_admin_due_at" timestamptz;
  ALTER TABLE "nbfc_lead_assignments" ADD COLUMN IF NOT EXISTS "rejection_forwarded_at" timestamptz;
  ALTER TABLE "nbfc_lead_assignments" ADD COLUMN IF NOT EXISTS "rejection_forward_source" varchar(16);
  CREATE INDEX IF NOT EXISTS "nbfc_lead_assignments_rejection_due_idx"
    ON "nbfc_lead_assignments" ("rejection_admin_due_at")
    WHERE "rejection_admin_due_at" IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-275: nbfc_lead_assignments missing (E-131 not applied) — skip';
END $do$;

ALTER TABLE "loan_sanctions" ADD COLUMN IF NOT EXISTS "external_lender" varchar(64);
ALTER TABLE "product_selections" ADD COLUMN IF NOT EXISTS "external_lender" varchar(64);

COMMENT ON COLUMN "loan_sanctions"."external_lender" IS
  'E-275: set (e.g. ''Bajaj Finance'') when the loan is written off-platform; nbfc_id is NULL and no NBFC assignment exists.';
