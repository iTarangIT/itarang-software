-- E-172 — Expense/Invoice Tracker: capture invoice number + original file name,
-- and enforce dedup on AI-recorded invoices by invoice number.
--
-- Additive + idempotent. Apply via pgAdmin Query Tool (never db:push).
-- Re-running this file is a no-op.

ALTER TABLE "expense_submissions"
  ADD COLUMN IF NOT EXISTS "invoice_number" varchar(120),
  ADD COLUMN IF NOT EXISTS "file_name" varchar(255);

-- Case-insensitive lookup index for dedup pre-checks.
CREATE INDEX IF NOT EXISTS "expense_submissions_invoice_number_idx"
  ON "expense_submissions" (lower("invoice_number"));

-- Dedup backstop: a partial, functional, case-insensitive unique index that
-- only applies to AI-recorded rows with a non-blank invoice number. Safe to add
-- because `invoice_number` is brand-new (no existing data can collide); NULL/
-- blank numbers and non-AI (manual/legacy) rows are excluded, so existing rows
-- are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "expense_submissions_ai_invoice_number_unique"
  ON "expense_submissions" (lower("invoice_number"))
  WHERE "source" = 'ai'
    AND "invoice_number" IS NOT NULL
    AND "invoice_number" <> '';
