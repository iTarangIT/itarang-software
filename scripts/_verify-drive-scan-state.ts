/**
 * Read-only census of the Google Drive → expenses / revenue scan state.
 *
 *   node --import tsx --env-file=.env.local      scripts/_verify-drive-scan-state.ts   # db-1 sandbox
 *   node --import tsx --env-file=.env.production scripts/_verify-drive-scan-state.ts   # db-2 prod
 *
 * WHY THIS EXISTS
 *   "Scanned 333 files across 1 folder — 0 new (333 unchanged, not re-read)"
 *   with every counter at zero is indistinguishable, from the UI, between
 *   "everything is already imported" and "every file is stuck on a recorded
 *   failure that will never be retried". drive_expense_files.status is the only
 *   place that difference is written down, and nothing renders the lifetime
 *   split — the panel only ever shows the LAST run's counters.
 *
 *   loadSeenVersions() in src/lib/expenses/driveScan.ts matches on
 *   (drive_file_id, md5_checksum) with NO status filter, so a row saying
 *   'failed' suppresses that file forever: a PDF's md5 never changes. This
 *   script measures how much that has actually swallowed, and what the recorded
 *   reasons were, before anything is changed.
 *
 * Strictly SELECT-only. Safe against production.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { driveExpenseFiles } from "@/lib/db/schema";
import { isSettledFileVersion } from "@/lib/expenses/retryPolicy";

/** Print a result set as a table, or say plainly that it was empty. */
async function show(label: string, query: SQL): Promise<void> {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    const res = (await db.execute(query)) as unknown;
    const list = Array.isArray(res)
      ? (res as Record<string, unknown>[])
      : (((res as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<
          string,
          unknown
        >[]);
    if (!list.length) {
      console.log("(no rows)");
      return;
    }
    console.table(list);
  } catch (e: unknown) {
    // A missing table is a finding, not a crash: it says the migration is
    // unapplied on this database, which is part of what we are here to learn.
    // drizzle hides the real pg error on .cause — errorMessage() alone would
    // report a useless wrapper.
    const err = e as { message?: string; cause?: { message?: string } };
    console.log(`ERROR: ${err.cause?.message ?? err.message ?? String(e)}`);
  }
}

async function main() {
  // Which database am I actually looking at? Several wrong conclusions in this
  // repo's history started with not knowing.
  const url = process.env.DATABASE_URL ?? "";
  const host = url.replace(/^[^@]*@/, "").split("/")[0] || "(unknown)";
  console.log(`DATABASE host: ${host}`);

  // ---------------------------------------------------------------- purchases
  await show(
    "drive_expense_folders — what is configured",
    sql`SELECT drive_folder_id, label, is_active, recursive,
               include_names, exclude_names, last_scanned_at
          FROM drive_expense_folders
         ORDER BY created_at`,
  );

  await show(
    "drive_expense_files — lifetime status split  <-- THE ANSWER",
    sql`SELECT status,
               count(*)              AS files,
               min(created_at)::date AS first_seen,
               max(created_at)::date AS last_seen
          FROM drive_expense_files
         GROUP BY status
         ORDER BY files DESC`,
  );

  await show(
    "drive_expense_files — rows vs distinct files",
    sql`SELECT count(*)                                     AS n_rows,
               count(DISTINCT drive_file_id)                AS distinct_files,
               count(*) FILTER (WHERE md5_checksum IS NULL) AS null_checksums
          FROM drive_expense_files`,
  );

  // The reasons are what confirm (or refute) "the OpenAI account ran dry and
  // every file the scan touched was poisoned with an identical error".
  await show(
    "drive_expense_files — why the stuck ones are stuck",
    sql`SELECT status,
               left(coalesce(reason, '(none)'), 110) AS reason,
               count(*)                              AS files
          FROM drive_expense_files
         WHERE status <> 'imported'
         GROUP BY status, left(coalesce(reason, '(none)'), 110)
         ORDER BY files DESC
         LIMIT 25`,
  );

  await show(
    "drive_scan_runs — last 15",
    sql`SELECT started_at, status, files_seen, files_new, imported,
               skipped_duplicate, needs_attention, unsupported, failed,
               duration_ms,
               left(coalesce(error_message, ''), 70) AS error
          FROM drive_scan_runs
         ORDER BY started_at DESC
         LIMIT 15`,
  );

  await show(
    "drive_scan_runs — stranded at 'running'",
    sql`SELECT id, started_at, folder_id, triggered_by
          FROM drive_scan_runs
         WHERE status = 'running'
         ORDER BY started_at DESC`,
  );

  await show(
    "expense_submissions — what actually landed from Drive, by month",
    sql`SELECT to_char(coalesce(expense_date, approved_at::date), 'YYYY-MM') AS month,
               count(*)                                AS n_rows,
               sum(amount)                             AS total_inr,
               count(*) FILTER (WHERE needs_attention) AS flagged
          FROM expense_submissions
         WHERE source = 'ai' AND drive_file_id IS NOT NULL
         GROUP BY 1
         ORDER BY 1 DESC
         LIMIT 24`,
  );

  // The hazard behind "re-read everything": for invoices drive_row_ref is NULL,
  // and a Postgres UNIQUE index treats NULLs as distinct, so the E-216 index
  // does NOT stop the same file importing twice. Anything listed here is
  // already a double-count.
  await show(
    "expense_submissions — SAME drive file imported more than once (should be empty)",
    sql`SELECT drive_file_id, count(*) AS n_rows, sum(amount) AS total_inr
          FROM expense_submissions
         WHERE source = 'ai'
           AND drive_file_id IS NOT NULL
           AND drive_row_ref IS NULL
         GROUP BY drive_file_id
        HAVING count(*) > 1
         ORDER BY n_rows DESC
         LIMIT 20`,
  );

  await show(
    "expense_submissions — Drive rows with no invoice number (unguarded on re-read)",
    sql`SELECT count(*) AS n_rows
          FROM expense_submissions
         WHERE source = 'ai'
           AND drive_file_id IS NOT NULL
           AND (invoice_number IS NULL OR invoice_number = '')`,
  );

  // ------------------------------------------------- what the next scan will do
  //
  // The pre-flight. Uses the REAL predicate the scanner uses — restating the
  // rule here would let this script certify a bug rather than catch one.
  const recorded = await db
    .select({
      drive_file_id: driveExpenseFiles.drive_file_id,
      drive_file_name: driveExpenseFiles.drive_file_name,
      status: driveExpenseFiles.status,
      expense_ids: driveExpenseFiles.expense_ids,
      updated_at: driveExpenseFiles.updated_at,
      reason: driveExpenseFiles.reason,
    })
    .from(driveExpenseFiles);

  const decide = (ignoreCooldown: boolean) =>
    recorded.filter(
      (r) =>
        !r.drive_file_id.startsWith("folder:") &&
        !isSettledFileVersion(
          {
            status: r.status,
            expenseIdCount: Array.isArray(r.expense_ids) ? r.expense_ids.length : 0,
            lastAttemptedAt: r.updated_at ?? null,
          },
          { ignoreCooldown },
        ),
    );

  const onNextScan = decide(false);
  const onRetryPress = decide(true);

  process.stdout.write(
    `\n=== what the NEXT scan would re-read ===\n` +
      `automatic (cooldown applies): ${onNextScan.length} file(s)\n` +
      `"Retry these" button:         ${onRetryPress.length} file(s)\n`,
  );
  if (onRetryPress.length) {
    console.table(
      onRetryPress.slice(0, 40).map((r) => ({
        file: (r.drive_file_name ?? "").slice(0, 46),
        status: r.status,
        rows: Array.isArray(r.expense_ids) ? r.expense_ids.length : 0,
        last_attempt: r.updated_at?.toISOString().slice(0, 16) ?? null,
        reason: (r.reason ?? "").slice(0, 46),
      })),
    );
  }

  // -------------------------------------------------------------------- sales
  await show(
    "E-280 tables present on this database?",
    sql`SELECT to_regclass('sales_invoices')::text        AS sales_invoices,
               to_regclass('sales_invoice_folders')::text AS folders,
               to_regclass('sales_scan_runs')::text       AS runs,
               to_regclass('sales_scan_files')::text      AS files`,
  );

  await show(
    "sales_invoice_folders — what is configured",
    sql`SELECT drive_folder_id, label, is_active,
               include_names, exclude_names, last_scanned_at
          FROM sales_invoice_folders
         ORDER BY created_at`,
  );

  await show(
    "sales_scan_files — lifetime status split",
    sql`SELECT status, count(*) AS files,
               min(created_at)::date AS first_seen,
               max(created_at)::date AS last_seen
          FROM sales_scan_files
         GROUP BY status
         ORDER BY files DESC`,
  );

  await show(
    "sales_scan_files — why the stuck ones are stuck",
    sql`SELECT status,
               left(coalesce(reason, '(none)'), 110) AS reason,
               count(*)                              AS files
          FROM sales_scan_files
         WHERE status <> 'imported'
         GROUP BY status, left(coalesce(reason, '(none)'), 110)
         ORDER BY files DESC
         LIMIT 20`,
  );

  await show(
    "sales_scan_runs — last 10",
    sql`SELECT started_at, status, files_seen, files_new, imported,
               skipped_duplicate, needs_attention, unsupported, failed,
               left(coalesce(error_message, ''), 70) AS error
          FROM sales_scan_runs
         ORDER BY started_at DESC
         LIMIT 10`,
  );

  await show(
    "sales_invoices — revenue actually read out of Drive",
    sql`SELECT count(*)          AS n_rows,
               min(invoice_date) AS earliest,
               max(invoice_date) AS latest,
               sum(total)        AS total_inr,
               count(*) FILTER (WHERE needs_attention) AS flagged
          FROM sales_invoices`,
  );

  await show(
    "zoho_invoices — the frozen half of revenue, for comparison",
    sql`SELECT count(*)          AS n_rows,
               min(invoice_date) AS earliest,
               max(invoice_date) AS latest
          FROM zoho_invoices`,
  );

  process.stdout.write("\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
