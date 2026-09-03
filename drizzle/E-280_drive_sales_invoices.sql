------------------------------------------------------------------------------
-- E-280: Google Drive → CEO Revenue (sales invoices).
--
-- The company has moved off Zoho Invoice onto Vyapar, which has no API. Sales
-- invoices are now filed as PDFs in the shared "Tax Invoices & Expenses" Drive
-- folder instead. `zoho_invoices` therefore stops growing, and every CEO
-- revenue figure — the Realization card, the revenue chart, Business Snapshot
-- "Sales to Dealer", the drill-downs and /ceo/invoices — silently flatlines.
--
-- This adds the state a Drive SALES scanner needs, mirroring what E-216 did
-- for the purchase side.
--
-- WHY FOUR NEW TABLES AND NOT COLUMNS ON THE E-216 ONES
--   The obvious shape is `kind` on drive_scan_runs / drive_expense_files and
--   `sales_enabled` on drive_expense_folders. That was rejected for the reason
--   E-267, E-250, E-242, E-236 and E-224 all record: Drizzle names EVERY column
--   of a mirrored table in its generated SQL, and driveScan.ts reads
--   drive_expense_folders with a bare `db.select()`. Mirroring three new columns
--   would make this migration REQUIRED — an unapplied E-280 would fail every
--   expense scan with `column "sales_enabled" does not exist`, taking down a
--   working money pipeline to add a feature beside it. With no auto-runner and
--   ticks known to drift both ways, that trade is not worth making.
--
--   Separate tables mean an unapplied E-280 costs exactly the feature that
--   needs it: the sales scan reports itself unconfigured, expenses are
--   untouched, and the CEO dashboard falls back to Zoho-only revenue via the
--   to_regclass probe in src/lib/dashboard/revenueSource.ts.
--
--   It also sidesteps drive_expense_folders.drive_folder_id being UNIQUE — the
--   same accounts root cannot be registered twice — and means driveScan.ts is
--   not edited at all by this change.
--
-- WHY A SEPARATE TABLE AND NOT ROWS IN zoho_invoices
--   The inverse of E-216's reasoning. There, Drive rows joined the existing
--   expense_submissions because four readers filtered on source='ai'. Here the
--   target table is named, shaped and owned by a vendor we no longer use:
--   zoho_invoice_id is NOT NULL + UNIQUE and the hourly sync upserts on it.
--   Filing Vyapar invoices there would need a synthetic Zoho id and would put
--   rows the sync does not know about inside the table it rewrites hourly.
--   The union happens in one query builder instead, so the rule lives in one
--   place and both sources keep their own shape.
--
-- WHY organization_id REUSES THE ZOHO IDS
--   E-171 recorded 60060919257 = Haryana (ITG) and 60064046518 = Delhi (ITD),
--   both trading as ITARANG TECHNOLOGIES LLP. Reusing those exact ids means a
--   future GROUP BY organization_id spans both sources instead of splitting the
--   same legal entity in two. Nothing groups by it today (every CEO figure is a
--   company-wide sum), which is why this is worth getting right now — it is
--   free before there is data and expensive after.
--
-- DEDUP — WHY invoice_number_key EXISTS
--   The Drive tree holds BOTH eras: Nov 2025 – Jul 2026 invoices that Zoho
--   generated (and which are therefore already rows in zoho_invoices) and Aug
--   2026+ invoices from Vyapar. A full backfill was chosen over a cutover date,
--   so the normalised invoice number is the ONLY thing standing between a
--   backfill and double-counted revenue.
--
--   The formats genuinely differ and cannot be compared raw:
--     zoho_invoices.invoice_number   'ITD/202627/013'
--     Drive filename                 'ITD_202627_013.pdf'
--     Drive filename, same series    'ITG_202627_36.pdf'  (no zero padding)
--     what the model reads back      'ITG/202627/041'     (padding re-added)
--   normalizeInvoiceNumber() folds separators and strips leading zeros from
--   numeric segments, so all of the above collapse to 'ITD|202627|13' /
--   'ITG|202627|36' / 'ITG|202627|41'. See its unit tests — 035 and 36 must
--   stay DISTINCT while 013 and 13 must match.
--
-- COLLECTED / OUTSTANDING ARE CRM-OWNED FROM HERE
--   A PDF carries no live payment status — only a "Balance Due" printed at
--   issue time, which is a snapshot and goes stale the moment anything is paid.
--   So amount_paid / payment_reference / last_payment_date are written by
--   finance in the CRM, not extracted. Rows land as status='sent'.
--
--   There is deliberately NO balance column: it is COALESCE(total,0) -
--   amount_paid, derived in revenueSource.ts. A stored copy is one more thing
--   that can disagree with its own inputs, and this table is small enough that
--   computing it costs nothing.
--
-- status USES THE ZOHO VOCABULARY ON PURPOSE
--   draft|sent|overdue|paid|partially_paid|void — the same six values
--   /ceo/invoices already renders as filter chips, and the same values the
--   not-void revenue rule and the outstanding rule are written against. A new
--   vocabulary would need every one of those rewritten to understand both.
--
-- Strictly additive: no DROP, no type narrowing, no backfill, no DML.
-- Re-running is a no-op.
------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The invoices themselves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "sales_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- 'drive' today. Present so a future source (a Vyapar export, a manual
  -- upload) is distinguishable without another table.
  "source" varchar(16) DEFAULT 'drive' NOT NULL,

  -- As printed on the document.
  "invoice_number" text,
  -- normalizeInvoiceNumber(invoice_number). The dedup key; see header.
  "invoice_number_key" text,
  "invoice_date" date,
  "due_date" date,

  "customer_name" text,
  "customer_gstin" varchar(20),
  "place_of_supply" text,

  -- Same ids as zoho_invoices.organization_id — see header.
  "organization_id" varchar(64),
  -- The SELLER's GSTIN as printed. 07… = Delhi, 06… = Haryana. This is the
  -- only org signal available for the Nov/Dec 2025 invoices, which sit in a
  -- flat "Sales Invoices" folder with no state sub-folder and free-form
  -- filenames ("P M MOTORS INVOICE.pdf").
  "seller_gstin" varchar(20),

  -- Money, INR. sub_total + tax_total should equal total; when it does not the
  -- row is imported and flagged rather than dropped.
  "sub_total" numeric(14, 2),
  "tax_total" numeric(14, 2),
  "total" numeric(14, 2),

  -- CRM-owned. See header.
  "amount_paid" numeric(14, 2) DEFAULT 0 NOT NULL,
  "status" varchar(32) DEFAULT 'sent' NOT NULL,
  "payment_reference" text,
  "last_payment_date" date,
  "payment_marked_by" uuid,

  -- Provenance. folder_path is carried because in an accounts folder the path
  -- IS the meaning — "2026 / August 2026 / Sale / Haryana" says which month and
  -- which entity — so "where did this figure come from?" has an answer that
  -- does not require opening Drive.
  "drive_file_id" varchar(128),
  "file_name" varchar(255),
  "folder_path" text,
  "document_url" text,
  "storage_key" text,
  "ai_raw" jsonb,

  -- Set by validateSalesInvoice: arithmetic mismatch, invoice month disagreeing
  -- with its folder, a missing GSTIN, or org signals that contradict each other.
  "needs_attention" boolean DEFAULT false NOT NULL,
  "attention_reason" text,

  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

-- Dedup layer 2 (layer 1 is sales_scan_files' file+checksum index below).
-- PARTIAL because an invoice whose number could not be read is still worth
-- keeping as a needs_attention row, and several such rows must be able to
-- coexist. This index is the backstop for the re-scan race; the scanner also
-- checks explicitly so it can report *which* invoice collided.
CREATE UNIQUE INDEX IF NOT EXISTS "sales_invoices_number_key_unique"
  ON "sales_invoices" ("invoice_number_key")
  WHERE "invoice_number_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "sales_invoices_invoice_date_idx"
  ON "sales_invoices" ("invoice_date");
CREATE INDEX IF NOT EXISTS "sales_invoices_status_idx"
  ON "sales_invoices" ("status");
CREATE INDEX IF NOT EXISTS "sales_invoices_organization_id_idx"
  ON "sales_invoices" ("organization_id");
-- Drives the Needs Attention panel; partial so it stays tiny.
CREATE INDEX IF NOT EXISTS "sales_invoices_attention_idx"
  ON "sales_invoices" ("created_at")
  WHERE "needs_attention" = true;

-- ---------------------------------------------------------------------------
-- Which Drive folders to walk for sales.
--
-- Separate from drive_expense_folders rather than a flag on it: that table's
-- drive_folder_id is UNIQUE, so the same accounts root cannot be registered
-- for both sides, and adding columns there would make this migration REQUIRED
-- (see header).
--
-- The allowlist/denylist are INVERTED relative to E-216. That module books
-- expenses and allows only 'purchase'; this one books revenue and allows only
-- 'sale'. Matched as a leading word by folderMatchesToken(), which is what makes
-- one token cover the four spellings the live folder actually uses: "Sale",
-- "Sales", "Sale Invoices" and "Sales Invoices".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "sales_invoice_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "drive_folder_id" varchar(128) NOT NULL,
  "label" varchar(160),
  "is_active" boolean DEFAULT true NOT NULL,
  "recursive" boolean DEFAULT true NOT NULL,
  "include_names" text DEFAULT 'sale' NOT NULL,
  "exclude_names" text DEFAULT 'purchase' NOT NULL,
  "last_scanned_at" timestamptz,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "sales_invoice_folders_folder_id_unique"
  ON "sales_invoice_folders" ("drive_folder_id");
CREATE INDEX IF NOT EXISTS "sales_invoice_folders_active_idx"
  ON "sales_invoice_folders" ("is_active")
  WHERE "is_active" = true;

-- ---------------------------------------------------------------------------
-- Run log.
--
-- status is text + CHECK rather than a pgEnum, matching drive_scan_runs: adding
-- a value to a pgEnum is a migration, and these are operational states.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "sales_scan_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- NULL = scanned every active folder.
  "folder_id" uuid,
  -- NULL = the in-process ticker rather than a person.
  "triggered_by" uuid,
  "status" text DEFAULT 'running' NOT NULL,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  "duration_ms" integer,
  "files_seen" integer DEFAULT 0 NOT NULL,
  "files_new" integer DEFAULT 0 NOT NULL,
  "imported" integer DEFAULT 0 NOT NULL,
  "skipped_duplicate" integer DEFAULT 0 NOT NULL,
  "needs_attention" integer DEFAULT 0 NOT NULL,
  "unsupported" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "sales_scan_runs_status_check"
    CHECK ("status" IN ('running', 'success', 'failed'))
);

-- The concurrency guard. PARTIAL so it stays a handful of rows however long the
-- run history grows — three entry points (the admin button, the ticker, the
-- cron route) share one process and this is what stops them overlapping.
CREATE INDEX IF NOT EXISTS "sales_scan_runs_running_idx"
  ON "sales_scan_runs" ("started_at")
  WHERE "status" = 'running';
CREATE INDEX IF NOT EXISTS "sales_scan_runs_started_at_idx"
  ON "sales_scan_runs" ("started_at");

-- ---------------------------------------------------------------------------
-- Per-file outcome.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "sales_scan_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid,
  "folder_id" uuid,
  "drive_file_id" varchar(128) NOT NULL,
  "drive_file_name" varchar(512),
  "folder_path" text,
  "mime_type" varchar(160),
  -- Google's md5 where it exists, modifiedTime where it does not. NEVER null,
  -- or the unique index below stops biting and every re-scan re-downloads and
  -- re-bills the whole folder.
  "md5_checksum" varchar(128),
  "drive_modified_time" timestamptz,
  "status" text NOT NULL,
  "reason" text,
  -- ids of the sales_invoices rows this file produced.
  "invoice_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "storage_key" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "sales_scan_files_status_check"
    CHECK ("status" IN ('imported', 'duplicate', 'needs_attention', 'unsupported', 'failed'))
);

-- Dedup layer 1, and the reason a re-scan of a settled folder is free: an
-- unchanged file is never downloaded and never sent to the model.
CREATE UNIQUE INDEX IF NOT EXISTS "sales_scan_files_file_version_unique"
  ON "sales_scan_files" ("drive_file_id", "md5_checksum");
CREATE INDEX IF NOT EXISTS "sales_scan_files_run_id_idx"
  ON "sales_scan_files" ("run_id");
CREATE INDEX IF NOT EXISTS "sales_scan_files_status_idx"
  ON "sales_scan_files" ("status");

COMMENT ON TABLE "sales_invoices" IS
  'E-280 — sales invoices read out of Google Drive after the move off Zoho to Vyapar. Unioned with zoho_invoices by src/lib/dashboard/revenueSource.ts to produce every CEO revenue figure.';
COMMENT ON COLUMN "sales_invoices"."invoice_number_key" IS
  'E-280 — normalizeInvoiceNumber(invoice_number). Separators folded and leading zeros stripped from numeric segments so ITD/202627/013 and ITD_202627_13 collide but ITG_202627_035 and ITG_202627_36 do not. The only guard against double-counting an invoice that exists in both zoho_invoices and Drive.';
