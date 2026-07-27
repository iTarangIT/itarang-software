# Google Drive → CEO Expenses (E-216)

Invoices and costing sheets dropped into a Google Drive folder are scanned,
read, validated and written into `expense_submissions` — the same table the CEO
dashboard's Expenses card, department/project breakdown, ledger and drill-down
already read. There is no approval step.

## The flow

```
Drive folders (shared with the service account)
        │  src/lib/google/drive.ts
        ▼
  src/lib/expenses/driveScan.ts
        │
        ├─ seen this exact file version before?  → skip (no download, no model call)
        ├─ download → store a copy → S3 / Supabase
        ├─ PDF or image      → extractInvoice()        (one GPT-4o vision call)
        │  xlsx / csv / gsheet → extractCostingSheet() (one call, then rows mapped in code)
        ├─ validateExpense()  → amount / date / vendor / department
        ├─ dedupe             → invoice number, or file+row for sheet lines
        └─ INSERT expense_submissions (source='ai', status='approved')
        │
        ├─ per-file outcome → drive_expense_files
        └─ per-run counters → drive_scan_runs
                    │
                    ▼
        CEO dashboard — no extra wiring, it already reads this table
```

## Sales vs Purchase — read this before adding a folder

The accounts folder is laid out like this:

```
<root>
├── 2025 / 2026
    └── March 2026, April 2026, …
        ├── Purchase          ← EXPENSES. This is what we want.
        │   ├── iTarang account  → Trontek, Ecostar, Others → *.pdf
        │   ├── Chirag's account
        │   └── Other expenses
        └── Sale              ← REVENUE. Must NOT be imported.
            ├── Delhi GST     → ITD*.pdf
            └── Haryana GST
```

The `Sale` side holds **customer** invoices. Those are revenue, and this CRM
already has them: the Zoho sync pulls the Delhi (ITD) and Haryana orgs into
`zoho_invoices`, which is what the CEO's Revenue card reads. Importing them as
expenses would inflate the expense total by the entire turnover *and*
double-count the revenue.

**Only purchase invoices are imported.** `drive_expense_folders.include_names`
is an allowlist defaulting to **`purchase`**: a file is imported only if it sits
at or below a folder whose name matches, and scope is inherited, so everything
under `Purchase Invoices / iTarang Account / Trontek` comes along.

It is an allowlist rather than a denylist because a denylist **fails open**. The
live folder alone names its sales side four ways across two yearly conventions —
`Sale`, `Sales`, `Sale Invoices`, `Sales Invoices` — and an exact-name denylist
let 19 customer invoices straight through. An allowlist **fails closed**: a
folder it does not recognise is skipped and logged, never imported.

`exclude_names` (default `sale`) still runs as a second guard, catching a sales
folder misfiled *inside* a purchase branch.

Matching is on a leading word, case-insensitive: `purchase` catches "Purchase",
"Purchases" and "Purchase Invoices" but not "Wholesale".

Point the scanner at the **root**. New month folders are then picked up
automatically; adding each `Purchase` folder by hand would mean a new config row
every month.

Verified against the live folder: 214 files in scope, all under a `Purchase*`
path; 9 sales folders excluded by name; 1 loose file at month level skipped as
out of scope.

Two things the filter cannot catch, so spot-check the first scan:
- Files misfiled on the wrong side — there is a `Sale_EW …pdf` sitting inside
  `Purchase Invoices / iTarang Account / Others` in the live folder. Folder
  filtering cannot see filenames.
- A purchase folder named something unrecognised. Those show up in the scan log
  as "outside the allowlist" with their path, so widen `include_names` if one
  appears.

## Setup

1. **Enable the Drive API** in the Google Cloud project that owns the service
   account (`GOOGLE_SERVICE_ACCOUNT_EMAIL`). Only the Sheets API was enabled
   before this module. Without this every call fails with `accessNotConfigured`.
2. **Share each folder** with the service-account email, as Viewer.
   A service account has no Drive of its own, so an unshared folder does not
   error — it lists as **empty**, which is indistinguishable from "no new
   invoices". This is the most common setup mistake.
3. In the CRM, go to **Admin → AI Expense Tracker** and paste the folder's URL
   into *Add a folder*. The folder is verified as reachable before it is saved,
   so a sharing mistake surfaces immediately rather than as silence later.

No new environment variables are required — Drive reuses
`GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`.

### Optional environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DRIVE_EXPENSE_SCAN_INTERVAL_MS` | `21600000` (6h) | Ticker interval |
| `DRIVE_EXPENSE_MAX_FILES_PER_RUN` | `25` | New files processed per scheduled run |
| `DRIVE_EXPENSE_SYSTEM_USER_ID` | — | `users.id` that owns ticker-imported rows |
| `ENABLE_DRIVE_EXPENSE_SCAN` | — | Set to `0` to disable the ticker |

> Production's `shared/.env` is rewritten from the `PROD_ENV_FILE_B64` GitHub
> secret on **every deploy**. A durable change needs the box edit *and* the
> secret. This is exactly why the folder list lives in the database instead.

## When scans run

- **Automatically** — an in-process ticker in `src/instrumentation-node.ts`,
  every 6 hours, first run 90s after boot. Vercel crons do not fire on the
  Hostinger PM2 boxes (see `DEPLOY_RUNBOOK.md`), so this ticker is the real
  scheduler.
- **On demand** — the *Scan now* button, which processes up to 100 new files
  and shows the result.
- **From cron** — `GET /api/cron/drive-expenses` with
  `Authorization: Bearer $CRON_SECRET`, for the VPS root crontab.

All three call the same `runDriveScan`. A `status='running'` row in
`drive_scan_runs` is the lock, so two triggers landing together cannot
double-import. A run stuck 'running' for over 30 minutes is treated as dead
(pm2 restarted mid-scan) and stops blocking.

A scan does not have to finish a folder in one pass. "Already processed" is a
property of the file, not of the run, so each run resumes where the last
stopped. A first scan of a large backlog fills in over several runs — watch the
counters in `drive_scan_runs` rather than assuming one run did everything.

## Deduplication

Three layers, each catching what the one above cannot:

| Layer | Key | Catches |
|---|---|---|
| File version | `drive_expense_files (drive_file_id, md5_checksum)` | Re-scanning an unchanged file. No download, no model call — this is what makes routine scans free. |
| Invoice | `expense_submissions (lower(invoice_number)) WHERE source='ai'` (E-172) | The same invoice arriving as a different file — renamed, re-uploaded, copied to a second folder. |
| Sheet row | `expense_submissions (drive_file_id, drive_row_ref)` | Individual cost lines, which carry no invoice number of their own. |

Native Google Sheets have no `md5Checksum`; the code stores `modifiedTime`
instead, so editing a Sheet makes it eligible for re-processing.

## Foreign-currency invoices (E-217)

`expense_submissions.amount` is one numeric column that every dashboard SUMs
with no notion of currency. Before E-217 a $200 Anthropic bill was therefore
added to the rupee total as **₹200** — $1,123 of SaaS spend booked as ₹1,123,
understating expenses by roughly ₹95,000 and producing a total denominated in
nothing.

Now `amount` is **always INR**. What the document actually said is preserved
alongside it:

| Column | Meaning |
|---|---|
| `amount` | INR. The figure every report sums. |
| `original_amount` | Face value as printed. |
| `currency` | Code on the document; `INR` when none. |
| `fx_rate` | INR per 1 unit of `currency`, as applied. |
| `fx_rate_date` | Date whose rate was used. |
| `fx_source` | `none` \| `ecb` \| `fallback` \| `manual`. |

**Rates are keyed by the invoice's own date, not today's.** An expense belongs
to the month it was incurred, so converting a May bill at today's rate would
make last month's total drift every time it was recomputed. Rates come from the
ECB daily reference series via `frankfurter.app` (no API key) and are cached in
`fx_rates`, so an invoice always converts to the same rupee figure.

Weekends roll back to the preceding business day, and the returned date is what
gets stored — a 25 Jan invoice converts at the 23 Jan rate and says so.

**Mid-market, no forex markup.** The booked expense matches the vendor's
invoice, which is what an audit compares against. A card's ~3.5% forex markup is
a banking cost, not part of what was purchased — so the figure here will be
slightly below what the bank debited.

If the lookup fails, the row still imports using
`app_settings.fx_rates_fallback` (set it to e.g. `{"USD": 96.5}`) or a built-in
snapshot, and is flagged `needs_attention` with the rate used. Approximation
beats dropping the expense; silence would not.

Reconvert rows imported before E-217:

```bash
node --import tsx --env-file=.env.local scripts/_backfill-expense-currency.ts          # report
node --import tsx --env-file=.env.local scripts/_backfill-expense-currency.ts --apply  # write
```

## Needs attention

Nothing is held back for approval, so this queue is where doubt shows up. It
holds two different populations:

The split is by *whether an expense row exists*, not by whether it is perfect.
E-216 originally marked a file `needs_attention` whenever the imported row
carried any flag, so ten files that had imported fine were reported under
"could not be imported — this spend is not on the dashboard" when it was. Fixed
in E-217; the file status now answers one question only.

**Could not be imported** — no amount could be read, so there is no expense row
and this spend is *missing from the dashboard*. `expense_submissions.amount` is
`NOT NULL` and writing a zero would understate spend while looking like a
success, so these stop at a `drive_expense_files` row. Fix the source file in
Drive (a clearer scan, or the original PDF) and the next scan picks it up.

**Imported, but incomplete** — the amount was read, so the row *already counts*
on the CEO's card. Something else is missing. Reasons you will see:

| Reason | What it means |
|---|---|
| No vendor name was found. | Amount and date are fine; the supplier is blank. |
| No invoice date was found. / …is not a real calendar date. / …is in the future. | The row falls back to its import date for dashboard bucketing until fixed. |
| No invoice number was found | The row cannot be de-duplicated against a future import of the same bill. |
| Department "x" was a low-confidence guess (n%). | Below 50% confidence — check the department/project split. |
| Department could not be determined — filed under "ops". | The model returned nothing usable. |
| Converted USD … at an approximate rate | The live rate lookup failed and a fallback was used — check against the card statement. A *successful* conversion is not flagged. |

Correcting any field in the panel clears the flag. The tick button clears it
without editing, for cases where the extraction was right and the flag was
merely cautious (a genuine cash receipt with no invoice number).

## Which date an expense counts under

**E-216 changed this.** Every CEO expense figure used to window on
`approved_at` — for an AI row, the moment somebody imported it. That was fine
while invoices were dragged in one at a time. It breaks the instant a folder of
historic invoices is scanned: a year of spend would land in whichever month the
scan happened to run.

Expenses now window on `COALESCE(expense_date, approved_at::date)` — the date
on the bill, falling back to the import date for older rows that never captured
one. Shared as `approvedExpenseInWindow()` in `src/lib/dashboard/salesWindow.ts`
and used by the Expenses card, the CEO dashboard payload, the drill-down and
the snapshot `net` tile, so the four cannot drift.

> **One-time effect:** existing manually-uploaded rows are re-bucketed to their
> real invoice dates when this ships, so historical monthly totals shift once.
> That is the correction, not a regression — but it is visible, so tell the CEO
> before deploying.

Backed by `expense_submissions_effective_date_idx`, a partial expression index
`WHERE status = 'approved'`. Callers must keep the `status = 'approved'`
predicate or the index will not apply.

## Costing spreadsheets

Sheets produce **one expense per data row**, not one per file.

One model call reads the sheet's *layout* — which column holds the amount, the
vendor, the date; which row the data starts on — and every row is then mapped
in plain TypeScript. Sending each row to the model would cost a hundred calls
and give a hundred chances to read the same column differently.

Rows matching `total` / `grand total` / `subtotal` are dropped. Importing a
grand-total row alongside its line items double-counts the whole sheet, so the
check to run after any spreadsheet import is that the imported rows sum to the
sheet's own total.

Capped at 500 data rows per sheet; the cap is reported in the file's `reason`
rather than silently truncating.

## Supported file types

| Type | Handling |
|---|---|
| PDF | Passed to GPT-4o as a file input (all pages). |
| PNG / JPEG / WebP / GIF | Vision input at high detail. Photographed bills extract noticeably worse than native PDFs. |
| XLSX / XLS / CSV | Layout call + deterministic row mapping. |
| Google Sheets | Exported to CSV, then as above. |
| Google Docs / Slides | **Not supported** — logged as `unsupported`. Export to PDF into the folder instead. |
| Anything over 10 MB | Logged as `unsupported`. |

The live folder is 100% native PDFs, 60 KB–570 KB — the highest-accuracy path,
and nothing near the size cap.

## Checking access before you scan

```bash
node --import tsx --env-file=.env.local scripts/_check-drive-access.ts <folderId>
```

Prints the folder name, the files found, which folders were excluded, whether
the depth cap bit, and how many model calls a first scan would cost. Run it
after enabling the Drive API and sharing the folder — it distinguishes
"API not enabled" from "not shared" from "genuinely empty", which the scanner
itself cannot do once it is running.

## Where things live

| | |
|---|---|
| Drive client | `src/lib/google/drive.ts` |
| Orchestrator | `src/lib/expenses/driveScan.ts` |
| Validation | `src/lib/expenses/validateExpense.ts` |
| Invoice extraction | `src/lib/ai/invoices/extractInvoice.ts` (pre-existing, unchanged) |
| Sheet extraction | `src/lib/ai/invoices/extractCostingSheet.ts` |
| API | `src/app/api/admin/ai-expenses/drive/{folders,scan,runs}` |
| Cron | `src/app/api/cron/drive-expenses` |
| Ticker | `startDriveExpenseTicker` in `src/instrumentation-node.ts` |
| UI | `src/app/(dashboard)/admin/expense-tracker/_components/{DriveFoldersPanel,NeedsAttentionPanel}.tsx` |
| Migration | `drizzle/E-216_drive_expense_ingestion.sql` |

## Troubleshooting

**Scan reports 0 files seen.** The folder is almost certainly not shared with
the service account. Re-share it as Viewer; Drive reports an unshared folder as
empty, not as an error.

**`accessNotConfigured`.** The Drive API is not enabled in the service
account's Google Cloud project.

**Files import but the CEO card does not move.** Check `status` is `approved`
and the invoice date falls in the window being viewed — a bill dated three
months ago now correctly counts in *that* month, not this one.

**Everything is a duplicate after a re-scan.** Working as intended: layer 1
skipped the unchanged files, layer 2 caught the invoice numbers.

**Rows imported with `source='ai'` but no `drive_file_id`.** Those came from
the manual uploader, not from Drive. Drive rows deliberately share `source='ai'`
so the ledger, tracker, dashboard query and E-172 dedup index all keep working;
`drive_file_id IS NOT NULL` is what separates them.
