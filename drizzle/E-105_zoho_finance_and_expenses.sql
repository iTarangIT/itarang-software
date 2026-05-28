-- E-105 — Zoho Invoice mirror + universal expense submissions + sync cursor.
--
-- Adds three additive tables:
--   * zoho_invoices         — local snapshot of Zoho Invoice customer invoices
--                              kept fresh by the hourly /api/cron/zoho-sync job.
--                              MTD revenue on the CEO dashboard reads from here.
--   * expense_submissions   — any iTarang user can submit a business expense
--                              (category + amount + bill upload). CEO approves
--                              before the amount counts toward the CEO panel.
--   * zoho_sync_state       — singleton row tracking the cursor + last-run
--                              status of the hourly invoice pull.
--
-- All statements idempotent (additive only; safe to re-run).

CREATE TABLE IF NOT EXISTS "zoho_invoices" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "zoho_invoice_id" varchar(64) NOT NULL,
    "invoice_number" varchar(64),
    "customer_id" varchar(64),
    "customer_name" text,
    "invoice_date" date,
    "due_date" date,
    "currency_code" varchar(8),
    "total" numeric(14, 2),
    "balance" numeric(14, 2),
    "status" varchar(32),
    "raw_json" jsonb,
    "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "zoho_invoices_zoho_id_unique"
    ON "zoho_invoices" ("zoho_invoice_id");
CREATE INDEX IF NOT EXISTS "zoho_invoices_invoice_date_idx"
    ON "zoho_invoices" ("invoice_date");
CREATE INDEX IF NOT EXISTS "zoho_invoices_status_idx"
    ON "zoho_invoices" ("status");

CREATE TABLE IF NOT EXISTS "expense_submissions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "submitted_by" uuid NOT NULL,
    "category" varchar(64) NOT NULL,
    "amount" numeric(14, 2) NOT NULL,
    "description" text,
    "bill_url" text,
    "bill_storage_path" text,
    "status" varchar(16) DEFAULT 'pending' NOT NULL,
    "approved_by" uuid,
    "approved_at" timestamp with time zone,
    "rejection_reason" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "expense_submissions_status_idx"
    ON "expense_submissions" ("status");
CREATE INDEX IF NOT EXISTS "expense_submissions_submitted_by_idx"
    ON "expense_submissions" ("submitted_by");
CREATE INDEX IF NOT EXISTS "expense_submissions_approved_at_idx"
    ON "expense_submissions" ("approved_at");

CREATE TABLE IF NOT EXISTS "zoho_sync_state" (
    "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
    "last_invoice_modified_at" timestamp with time zone,
    "last_run_at" timestamp with time zone,
    "last_status" varchar(16),
    "last_error" text,
    CONSTRAINT "zoho_sync_state_singleton" CHECK ("id" = 1)
);

-- Seed the singleton row if absent.
INSERT INTO "zoho_sync_state" ("id")
VALUES (1)
ON CONFLICT ("id") DO NOTHING;
