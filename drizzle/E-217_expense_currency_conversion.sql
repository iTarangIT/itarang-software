------------------------------------------------------------------------------
-- E-217: multi-currency expenses — convert foreign invoices to INR.
--
-- E-216 started importing invoices from Google Drive, and the accounts folder
-- turned out to contain foreign-currency SaaS bills (Anthropic, OpenAI, Canva,
-- Fireflies) alongside the rupee ones. `expense_submissions.amount` is a single
-- numeric column that every dashboard SUMs with no notion of currency, so a
-- $200 invoice was being added to the total as ₹200.
--
-- Real effect on the first scan: $1,123 of foreign spend booked as ₹1,123,
-- understating expenses by roughly ₹95,000 — and, worse, producing a number
-- that is not denominated in anything.
--
-- THE SHAPE:
--   `amount` KEEPS its meaning as "the figure every report sums", and is now
--   always INR. Nothing downstream changes: the CEO Expenses card, the
--   department/project breakdown, the ledger, the drill-down and the Net tile
--   all keep doing SUM(amount) and simply become correct.
--
--   What the invoice actually said moves into `original_amount` + `currency`,
--   and the arithmetic that connects them is recorded on the row (`fx_rate`,
--   `fx_rate_date`, `fx_source`) so any converted figure can be audited or
--   recomputed later without guessing which rate was used.
--
-- WHY A RATE PER INVOICE DATE, NOT ONE CURRENT RATE:
--   An expense belongs to the month it was incurred, and E-216 already made
--   the dashboard bucket by invoice date. Converting a May invoice at today's
--   rate would make last month's total drift every time it was recomputed.
--   Rates are therefore keyed by date and cached in `fx_rates`, so the same
--   invoice converts to the same rupee figure forever.
--
-- Additive, idempotent, safe to re-run. Apply via pgAdmin (never db:push).
------------------------------------------------------------------------------

-- 1. Cached exchange rates ---------------------------------------------------
--
-- One row per (base, quote, date). Populated on demand from the ECB daily
-- reference rates and never re-fetched for a date already stored, which is
-- what makes a re-scan produce identical rupee figures rather than drifting
-- with whatever the rate is today.

CREATE TABLE IF NOT EXISTS fx_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency  varchar(8) NOT NULL,
  quote_currency varchar(8) NOT NULL DEFAULT 'INR',
  -- The date the rate APPLIES to. Markets close at weekends, so this is the
  -- date the provider actually returned, which may be a day or two before the
  -- invoice date that was asked for.
  rate_date      date NOT NULL,
  rate           numeric(18,8) NOT NULL CHECK (rate > 0),
  -- 'ecb' (fetched) | 'fallback' (configured default) | 'manual' (typed in)
  source         varchar(16) NOT NULL DEFAULT 'ecb',
  fetched_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_pair_date_unique
  ON fx_rates (base_currency, quote_currency, rate_date);

COMMENT ON TABLE fx_rates IS
  'E-217: cached FX rates keyed by date so a given invoice always converts to the same rupee figure. Populated on demand; never re-fetched for a stored date.';
COMMENT ON COLUMN fx_rates.rate_date IS
  'The date the rate applies to — the date the provider returned, which for a weekend invoice is the preceding business day.';


-- 2. Currency on the expense rows --------------------------------------------

ALTER TABLE expense_submissions
  ADD COLUMN IF NOT EXISTS currency        varchar(8),
  ADD COLUMN IF NOT EXISTS original_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS fx_rate         numeric(18,8),
  ADD COLUMN IF NOT EXISTS fx_rate_date    date,
  ADD COLUMN IF NOT EXISTS fx_source       varchar(16);

COMMENT ON COLUMN expense_submissions.amount IS
  'E-217: ALWAYS INR. Every report SUMs this column, so a foreign invoice is stored here already converted. The figure printed on the document is original_amount + currency.';
COMMENT ON COLUMN expense_submissions.currency IS
  'E-217: the currency printed on the document. NULL or INR means no conversion happened and amount = original_amount.';
COMMENT ON COLUMN expense_submissions.original_amount IS
  'E-217: the face value as printed, before conversion. Equals amount for rupee invoices.';
COMMENT ON COLUMN expense_submissions.fx_rate IS
  'E-217: units of INR per 1 unit of `currency`, as applied. Recorded per row so a converted figure can be audited without guessing which rate was used.';
COMMENT ON COLUMN expense_submissions.fx_rate_date IS
  'E-217: the date whose rate was used — the invoice date, or the preceding business day.';
COMMENT ON COLUMN expense_submissions.fx_source IS
  'E-217: ecb | fallback | manual. `fallback` means the rate lookup failed and a configured default was used, so the row is approximate and flagged.';

-- Backfill: every existing row is a rupee row. Idempotent via the NULL guard.
UPDATE expense_submissions
   SET original_amount = amount,
       currency        = 'INR',
       fx_rate         = 1,
       fx_source       = 'none'
 WHERE original_amount IS NULL;

-- Finding the rows that still need a real rate, and the ledger's currency column.
CREATE INDEX IF NOT EXISTS expense_submissions_currency_idx
  ON expense_submissions (currency)
  WHERE currency IS NOT NULL AND currency <> 'INR';


-- 3. Correct E-216's file-status classification ------------------------------
--
-- E-216's scanner marked a Drive file `needs_attention` whenever the imported
-- row carried ANY flag — a missing invoice number, a low-confidence
-- department, a foreign currency. But the admin panel reads that status as
-- "this file produced no expense row", and shows those files under
-- "Could not be imported — this spend is not on the dashboard".
--
-- So ten files that had imported perfectly well were reported as missing
-- spend. The file status answers one question only — did this file become an
-- expense row? — and anything imperfect about the row belongs on the row's own
-- needs_attention flag, where the UI already renders it.
--
-- `expense_ids <> '[]'` is exactly "a row was created", so this is a safe,
-- re-runnable reclassification. The reason text is deliberately kept: it is
-- still the most useful thing on the row.

DO $do$ BEGIN
  UPDATE drive_expense_files
     SET status = 'imported', updated_at = now()
   WHERE status = 'needs_attention'
     AND expense_ids IS NOT NULL
     AND jsonb_array_length(expense_ids) > 0;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'drive_expense_files does not exist here yet (E-216 not applied) — skipping E-217 part 3';
END; $do$;


-- 4. Release scans killed by the request timeout -----------------------------
--
-- E-216's "Scan now" route caps at 100 files with maxDuration = 300s, but a
-- file takes ~15s (download + one vision call), so a full batch cannot finish
-- inside the timeout. The handler is killed mid-run and its drive_scan_runs row
-- stays 'running' forever, which then blocks the next scan for 30 minutes.
--
-- The scanner is now time-boxed rather than only file-boxed. This releases any
-- run already stranded by the old behaviour.

DO $do$ BEGIN
  UPDATE drive_scan_runs
     SET status        = 'failed',
         completed_at  = now(),
         error_message = COALESCE(error_message,
           'Abandoned: the request timed out before the scan finished. Released by E-217.')
   WHERE status = 'running'
     AND started_at < now() - interval '30 minutes';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'drive_scan_runs does not exist here yet (E-216 not applied) — skipping E-217 part 4';
END; $do$;
