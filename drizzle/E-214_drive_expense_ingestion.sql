------------------------------------------------------------------------------
-- E-214: Google Drive → CEO Expenses ingestion.
--
-- Today expenses reach the CEO dashboard exactly one way: a human opens
-- /admin/expense-tracker and drags in up to 10 invoice files (E-172's bulk
-- route), each one goes through GPT-4o vision, and the result lands in
-- expense_submissions as source='ai', status='approved'. Meanwhile the
-- company's real invoices and costing sheets pile up in Google Drive folders
-- that nothing reads.
--
-- This migration adds the state a scheduled Drive scanner needs. It does NOT
-- add a second expenses table: Drive rows go into expense_submissions like
-- every other AI row, so the CEO Expenses card, the department/project
-- breakdown, the ledger panel and the drill-down all pick them up with no
-- query changes.
--
-- WHY DRIVE ROWS KEEP source='ai' RATHER THAN A NEW source='drive':
--   ExpenseLedgerPanel, ExpenseTrackerView, the CEO dashboard's ai_expenses
--   query and E-172's partial unique dedup index ALL filter on
--   source = 'ai'. A new source value would make every Drive row invisible in
--   four places at once and silently bypass the invoice-number dedup index —
--   the one thing standing between a re-scan and duplicated spend. Provenance
--   is carried by the new drive_file_id column instead, which adds a way to
--   tell the two apart without taking anything away.
--
-- THE THREE DEDUP LAYERS (each catches what the one above it cannot):
--   1. drive_expense_files UNIQUE (drive_file_id, md5_checksum) — an unchanged
--      file is never downloaded or sent to the model twice. This is what makes
--      re-scanning a folder free rather than expensive.
--   2. E-172's expense_submissions_ai_invoice_number_unique — the same invoice
--      arriving as a different file (renamed, re-uploaded, copied to a second
--      folder) still cannot be booked twice.
--   3. expense_submissions_drive_row_unique (below) — costing spreadsheets
--      produce one expense per data row and those rows carry no invoice
--      number, so they need their own identity: file + row.
--
-- NEEDS-ATTENTION, NOT AN APPROVAL QUEUE:
--   There is deliberately no approval step. A row whose amount was read but
--   whose vendor/date/invoice number is missing (or whose department
--   classification was low-confidence) still imports and still counts, but
--   carries needs_attention + a human-readable reason so it can be corrected.
--   A file with NO readable amount cannot become a row at all —
--   expense_submissions.amount is NOT NULL and inserting a zero would quietly
--   corrupt the dashboard — so it stops at a drive_expense_files row with
--   status='needs_attention' and stays visible there.
--
-- Additive, idempotent, and safe to re-run. Nothing existing is dropped,
-- narrowed, or backfilled. Apply via pgAdmin Query Tool (never db:push).
------------------------------------------------------------------------------

-- 1. Which Drive folders to scan ---------------------------------------------
--
-- This lives in the DB rather than an env var on purpose: production's
-- shared/.env is rewritten from the PROD_ENV_FILE_B64 GitHub secret on EVERY
-- deploy, so an env-configured folder list would silently disappear the next
-- time someone shipped. A table also lets an admin add a folder from the UI
-- without a deploy at all.

CREATE TABLE IF NOT EXISTS drive_expense_folders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Google Drive folder id (the trailing path segment of a folder URL).
  drive_folder_id varchar(128) NOT NULL,
  -- Human label for the admin UI. Defaults to the folder name we read back.
  label           varchar(160),
  is_active       boolean NOT NULL DEFAULT true,
  -- Walk sub-folders too. Depth is capped in code, not here.
  recursive       boolean NOT NULL DEFAULT true,
  -- ALLOWLIST. Only files at or below a folder whose name matches one of these
  -- are imported; scope is inherited by everything beneath.
  --
  -- This is the scanner's main safety property. A real accounts folder nests
  -- root / <year> / <month> / {Purchase, Sale} / <account> / <vendor>, and only
  -- the purchase side is an expense — the Sale side holds CUSTOMER invoices,
  -- i.e. revenue, which this CRM already syncs from Zoho into zoho_invoices.
  -- Importing those would add the whole turnover to the expense total AND
  -- double-count it against Zoho.
  --
  -- An allowlist rather than a denylist because a denylist has to anticipate
  -- every name the sales side might carry and fails OPEN when it misses one.
  -- The live folder alone uses "Sale", "Sales", "Sale Invoices" and
  -- "Sales Invoices" across two yearly conventions; an exact-name denylist let
  -- 19 customer invoices straight through. An allowlist fails CLOSED: an
  -- unrecognised folder is skipped and logged, never imported.
  --
  -- Empty string disables the allowlist (every folder in scope).
  include_names   text NOT NULL DEFAULT 'purchase',
  -- Denylist, applied as a secondary guard even inside an allowlisted branch —
  -- catches a sales folder misfiled under Purchase, which the allowlist would
  -- otherwise have already admitted.
  exclude_names   text NOT NULL DEFAULT 'sale',
  last_scanned_at timestamptz,
  -- users.id of whoever added it. Doubles as the fallback "who submitted this
  -- expense" for ticker-triggered runs, which have no human actor.
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS drive_expense_folders_folder_id_unique
  ON drive_expense_folders (drive_folder_id);

CREATE INDEX IF NOT EXISTS drive_expense_folders_active_idx
  ON drive_expense_folders (is_active) WHERE is_active;

COMMENT ON TABLE drive_expense_folders IS
  'E-214: Google Drive folders the expense scanner reads. In the DB rather than env because prod shared/.env is rewritten from a GitHub secret on every deploy.';
COMMENT ON COLUMN drive_expense_folders.created_by IS
  'users.id of the admin who added the folder. Also the fallback submitted_by/approved_by for ticker runs, which have no human actor.';
COMMENT ON COLUMN drive_expense_folders.include_names IS
  'E-214: ALLOWLIST — only files at or below a folder matching one of these (comma-separated, leading-word match, scope inherited by descendants) are imported. Defaults to ''purchase''. An allowlist because a denylist fails open: the live folder names its sales side four different ways across two yearly conventions.';
COMMENT ON COLUMN drive_expense_folders.exclude_names IS
  'E-214: denylist applied even inside an allowlisted branch — catches a sales folder misfiled under Purchase. Defaults to ''sale''.';


-- 2. One row per scan run ----------------------------------------------------
--
-- Modelled on scraper_runs: a status lifecycle, start/complete timestamps and
-- per-outcome counters. Without this a scan is invisible — you cannot tell
-- "the folder is empty" from "the ticker has not run since the last deploy",
-- which is exactly the failure mode the NBFC nightly jobs hit for five days
-- before anyone noticed (see docs/DEPLOY_RUNBOOK.md).
--
-- The 'running' row is also the concurrency lock: a second scan refuses to
-- start while one is in flight. That check is in the DB rather than an
-- in-memory flag so it survives a pm2 restart mid-run, and so the manual
-- "Scan now" button and the 6-hourly ticker cannot collide.

CREATE TABLE IF NOT EXISTS drive_scan_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = scanned every active folder.
  folder_id         uuid REFERENCES drive_expense_folders(id) ON DELETE SET NULL,
  -- NULL = triggered by the in-process ticker rather than a person.
  triggered_by      uuid,
  status            text NOT NULL DEFAULT 'running',
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  duration_ms       integer,
  -- Counters. files_seen counts everything listed; files_new counts what got
  -- past the md5 check and actually cost a download + a model call.
  files_seen        integer NOT NULL DEFAULT 0,
  files_new         integer NOT NULL DEFAULT 0,
  imported          integer NOT NULL DEFAULT 0,
  skipped_duplicate integer NOT NULL DEFAULT 0,
  needs_attention   integer NOT NULL DEFAULT 0,
  unsupported       integer NOT NULL DEFAULT 0,
  failed            integer NOT NULL DEFAULT 0,
  -- Only set when the RUN itself died. A single file failing increments
  -- `failed` and the run still completes — one bad scan of a bad PDF must not
  -- stop the other 40 files from importing.
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- TEXT + CHECK rather than a pgEnum: ALTER TYPE on a shared, drifting DB is
-- precisely what these conventions exist to avoid, and the status set may grow.
-- Enforced again by zod at the API boundary.
DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drive_scan_runs_status_chk'
  ) THEN
    ALTER TABLE drive_scan_runs
      ADD CONSTRAINT drive_scan_runs_status_chk
      CHECK (status IN ('running', 'success', 'failed'));
  END IF;
END; $do$;

-- "Is a scan already running?" — the start-of-run concurrency guard.
CREATE INDEX IF NOT EXISTS drive_scan_runs_running_idx
  ON drive_scan_runs (started_at DESC) WHERE status = 'running';

-- The admin panel's run history.
CREATE INDEX IF NOT EXISTS drive_scan_runs_started_idx
  ON drive_scan_runs (started_at DESC);

COMMENT ON TABLE drive_scan_runs IS
  'E-214: one row per Drive expense scan. Also the concurrency lock — a status=running row blocks a second scan. In the DB, not memory, so it survives a pm2 restart mid-run.';
COMMENT ON COLUMN drive_scan_runs.files_new IS
  'Files that got past the (drive_file_id, md5_checksum) check and actually cost a download plus a model call. files_seen minus files_new is what the dedup saved.';
COMMENT ON COLUMN drive_scan_runs.error_message IS
  'Set only when the run itself died. A single failing file increments `failed` and the run still completes.';


-- 3. One row per file, per outcome -------------------------------------------
--
-- This is both the audit trail ("where did this ₹1.2L come from?") and the
-- de-facto work queue for the needs-attention panel. Every file the scanner
-- touches gets a row whatever happens to it, including the ones that were
-- skipped or unreadable — a file that vanishes silently is indistinguishable
-- from a file that was never there.

CREATE TABLE IF NOT EXISTS drive_expense_files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid REFERENCES drive_scan_runs(id) ON DELETE SET NULL,
  folder_id           uuid REFERENCES drive_expense_folders(id) ON DELETE SET NULL,
  drive_file_id       varchar(128) NOT NULL,
  drive_file_name     varchar(512),
  -- Human-readable path from the scan root, e.g.
  -- "2026 / March 2026 / Purchase / iTarang account / Trontek". In an accounts
  -- folder the path IS the meaning — month, entity, and purchase-vs-sale — so
  -- "where did this ₹1.2L come from?" is answerable without opening Drive.
  folder_path         text,
  mime_type           varchar(160),
  -- Google's own content hash. Native Google Sheets/Docs have none, so the
  -- code falls back to the RFC3339 modifiedTime string in this column — either
  -- way it is "the version of this file we already processed".
  md5_checksum        varchar(128),
  drive_modified_time timestamptz,
  status              text NOT NULL,
  -- Human-readable. Shown verbatim in the needs-attention panel, so write it
  -- for the person who has to fix it, not for a log grep.
  reason              text,
  -- Array: one invoice yields one expense id, a costing sheet yields many.
  expense_ids         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the original bytes were stored, for re-processing without a
  -- second Drive round-trip.
  storage_key         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drive_expense_files_status_chk'
  ) THEN
    ALTER TABLE drive_expense_files
      ADD CONSTRAINT drive_expense_files_status_chk
      CHECK (status IN ('imported', 'duplicate', 'needs_attention', 'unsupported', 'failed'));
  END IF;
END; $do$;

-- Dedup layer 1. The whole point: a file whose content has not changed is
-- never downloaded or sent to the model again. COALESCE in the code keeps
-- md5_checksum non-null (it falls back to modifiedTime), so this unique index
-- bites rather than letting NULLs slip past it.
CREATE UNIQUE INDEX IF NOT EXISTS drive_expense_files_file_version_unique
  ON drive_expense_files (drive_file_id, md5_checksum);

-- "Has this file been seen at all?" and the per-file history in the UI.
CREATE INDEX IF NOT EXISTS drive_expense_files_file_idx
  ON drive_expense_files (drive_file_id);

-- The run-detail drawer.
CREATE INDEX IF NOT EXISTS drive_expense_files_run_idx
  ON drive_expense_files (run_id, created_at DESC);

-- The needs-attention panel's own query.
CREATE INDEX IF NOT EXISTS drive_expense_files_attention_idx
  ON drive_expense_files (created_at DESC)
  WHERE status IN ('needs_attention', 'failed');

COMMENT ON TABLE drive_expense_files IS
  'E-214: one row per Drive file per scan outcome. Audit trail for where an expense came from, and the work queue behind the needs-attention panel. Every touched file gets a row, including skipped and unreadable ones.';
COMMENT ON COLUMN drive_expense_files.md5_checksum IS
  'Google''s content hash. Native Google Sheets/Docs have none — the code stores the RFC3339 modifiedTime instead. Either way: the version of this file already processed.';
COMMENT ON COLUMN drive_expense_files.expense_ids IS
  'Array because a costing spreadsheet produces one expense per data row, while an invoice produces one.';
COMMENT ON COLUMN drive_expense_files.reason IS
  'Human-readable and shown verbatim in the needs-attention panel. Write it for the person who has to fix the row.';


-- 4. Provenance + attention flags on the expense rows themselves -------------

ALTER TABLE expense_submissions
  ADD COLUMN IF NOT EXISTS drive_file_id    varchar(128),
  ADD COLUMN IF NOT EXISTS drive_row_ref    varchar(64),
  ADD COLUMN IF NOT EXISTS needs_attention  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attention_reason text;

COMMENT ON COLUMN expense_submissions.drive_file_id IS
  'E-214: the Google Drive file this row was extracted from. NULL for manually uploaded rows — this is how Drive rows are told apart from hand-uploaded ones without changing `source`, which stays ''ai'' so all four existing consumers keep working.';
COMMENT ON COLUMN expense_submissions.drive_row_ref IS
  'E-214: identity of a single row inside a costing spreadsheet (sheet:<name>:row:<n>). NULL for invoices, which are identified by invoice_number instead.';
COMMENT ON COLUMN expense_submissions.needs_attention IS
  'E-214: imported but not fully trusted — missing vendor/date/invoice number, low-confidence department, or a non-INR currency. The row DOES count towards dashboard totals; the flag routes it to a human, it does not withhold it.';
COMMENT ON COLUMN expense_submissions.attention_reason IS
  'E-214: why needs_attention is set, in plain English, shown verbatim to the admin who fixes it.';

-- Dedup layer 3 — spreadsheet rows carry no invoice number, so file + row is
-- their only stable identity. Safe to add as UNIQUE: both columns are brand
-- new, so every existing row has drive_file_id IS NULL and is excluded by the
-- partial predicate. Invoices land here too (drive_row_ref NULL), which makes
-- this a second guard on re-importing the same file.
CREATE UNIQUE INDEX IF NOT EXISTS expense_submissions_drive_row_unique
  ON expense_submissions (drive_file_id, drive_row_ref)
  WHERE drive_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS expense_submissions_needs_attention_idx
  ON expense_submissions (created_at DESC)
  WHERE needs_attention;

-- The CEO Expenses card, its drill-down and the Net tile now window on the
-- invoice's OWN date rather than approved_at (= import time), so that a bill
-- dated March counts in March no matter when it was scanned.
--
-- NOT an index on COALESCE(expense_date, approved_at::date), which is what
-- this originally tried. `timestamptz::date` is STABLE, not IMMUTABLE — the
-- result depends on the session TimeZone GUC — so Postgres rejects it with
-- "functions in index expression must be marked IMMUTABLE" (42P17).
--
-- Pinning the zone (`approved_at AT TIME ZONE 'UTC'`) would make it indexable,
-- but it would also silently re-bucket rows: an expense approved at 01:00 IST
-- on the 1st is still the previous month in UTC. Not worth changing what a
-- month means to save an index.
--
-- So the readers split the COALESCE into an OR instead (see
-- approvedExpenseInWindow in src/lib/dashboard/salesWindow.ts):
--     (expense_date IS NOT NULL AND expense_date  >= s AND expense_date  < e)
--  OR (expense_date IS NULL     AND approved_at   >= s AND approved_at   < e)
-- Both branches compare a plain column against a constant, so each is served
-- by an ordinary b-tree with no volatility question at all.
--
-- The second branch already has an index: expense_submissions_approved_at_idx
-- from E-105. This adds the first.
CREATE INDEX IF NOT EXISTS expense_submissions_approved_expense_date_idx
  ON expense_submissions (expense_date)
  WHERE status = 'approved';
