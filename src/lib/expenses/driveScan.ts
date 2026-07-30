/**
 * E-216 — the Google Drive expense scanner.
 *
 * Walks the configured Drive folders, and for each file it has not already
 * processed: downloads it, extracts the expense data, validates it, dedupes
 * it, and writes an `expense_submissions` row that the CEO dashboard reads
 * with no further wiring.
 *
 * Deliberately sequential. Every new file costs one GPT-4o call, so
 * parallelism buys little wall-clock against the model's own latency while
 * multiplying the chance of a 429 mid-run. Throughput comes from the md5
 * dedup below — a re-scan of a settled folder makes zero model calls — not
 * from concurrency.
 *
 * A single bad file must never kill a run. Each file is wrapped, records its
 * own outcome row, and the loop moves on; only an unrecoverable failure (Drive
 * unreachable, DB down) marks the run itself failed.
 */
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import * as XLSX from "xlsx";

import { db } from "@/lib/db";
import {
  driveExpenseFiles,
  driveExpenseFolders,
  driveScanRuns,
  expenseSubmissions,
  users,
} from "@/lib/db/schema";
import {
  DEFAULT_EXCLUDED_FOLDER_NAMES,
  DEFAULT_INCLUDED_FOLDER_NAMES,
  MAX_DRIVE_FILE_BYTES,
  describeDriveError,
  downloadFile,
  exportGoogleSheetAsCsv,
  isDriveConfigured,
  isGoogleNativeFile,
  isGoogleSheet,
  listFolderFiles,
  type DriveFile,
} from "@/lib/google/drive";
import { extractInvoice } from "@/lib/ai/invoices/extractInvoice";
import { extractCostingSheet } from "@/lib/ai/invoices/extractCostingSheet";
import {
  formatAttentionReason,
  validateExpense,
  type ExpenseCandidate,
} from "@/lib/expenses/validateExpense";
import { convertToInr } from "@/lib/expenses/fx";
import { resolveBucket } from "@/lib/expenses/resolveBucket";
import { filesProxyPath, isS3Backend, putObject } from "@/lib/storage/s3";
import { createAdminClient } from "@/lib/supabase/admin";

/** MIME types `extractInvoice` can read directly. */
const INVOICE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

/** MIME types handled by the spreadsheet path. */
const SHEET_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "text/plain", // Drive labels some uploaded .csv files this way
]);

/**
 * A run that has been 'running' longer than this is assumed dead (pm2 restart
 * mid-scan) and no longer blocks a new one.
 */
const STALE_RUN_MS = 30 * 60 * 1000;

const DEFAULT_MAX_FILES = 25;

/**
 * Stop cleanly after this long, whatever the file budget says.
 *
 * A file costs ~15s (download + one vision call), so a 100-file batch runs for
 * ~25 minutes — far past the 300s maxDuration on the "Scan now" route. Without
 * a deadline the handler is simply killed, the run row is stranded at
 * 'running', and it then blocks the next scan for 30 minutes. Finishing early
 * costs nothing: "already processed" is a property of the file's md5, so the
 * next run resumes exactly where this one stopped.
 */
const DEFAULT_TIME_BUDGET_MS = 4 * 60_000;

export interface DriveScanSummary {
  run_id: string | null;
  status: "success" | "failed" | "skipped";
  folders_scanned: number;
  files_seen: number;
  files_new: number;
  imported: number;
  skipped_duplicate: number;
  needs_attention: number;
  unsupported: number;
  failed: number;
  duration_ms: number;
  error?: string;
  /** Set when the run refused to start because another was in flight. */
  skipped_reason?: string;
}

interface FileOutcome {
  status: "imported" | "duplicate" | "needs_attention" | "unsupported" | "failed";
  reason: string | null;
  expenseIds: string[];
  storageKey: string | null;
}

export async function runDriveScan(opts: {
  folderId?: string;
  triggeredBy?: string | null;
  maxFiles?: number;
  /** Stop cleanly after this long. See DEFAULT_TIME_BUDGET_MS. */
  timeBudgetMs?: number;
} = {}): Promise<DriveScanSummary> {
  const startedAt = Date.now();
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const deadline = startedAt + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const outOfTime = () => Date.now() >= deadline;

  const empty = (
    status: DriveScanSummary["status"],
    extra: Partial<DriveScanSummary> = {},
  ): DriveScanSummary => ({
    run_id: null,
    status,
    folders_scanned: 0,
    files_seen: 0,
    files_new: 0,
    imported: 0,
    skipped_duplicate: 0,
    needs_attention: 0,
    unsupported: 0,
    failed: 0,
    duration_ms: Date.now() - startedAt,
    ...extra,
  });

  if (!isDriveConfigured()) {
    return empty("skipped", {
      skipped_reason:
        "Google Drive is not configured — GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY are unset.",
    });
  }

  // Concurrency guard. In the DB rather than an in-memory flag so it holds
  // across the manual button, the ticker and the cron route — three entry
  // points in the same process — and survives a restart mid-run.
  const [inFlight] = await db
    .select({ id: driveScanRuns.id, started_at: driveScanRuns.started_at })
    .from(driveScanRuns)
    .where(
      and(
        eq(driveScanRuns.status, "running"),
        gt(driveScanRuns.started_at, new Date(Date.now() - STALE_RUN_MS)),
      ),
    )
    .limit(1);
  if (inFlight) {
    return empty("skipped", { skipped_reason: "A Drive scan is already running." });
  }

  const folders = await loadFolders(opts.folderId);
  if (folders.length === 0) {
    return empty("skipped", {
      skipped_reason: opts.folderId
        ? "That folder is not configured or is inactive."
        : "No active Drive folders are configured.",
    });
  }

  const [run] = await db
    .insert(driveScanRuns)
    .values({
      folder_id: opts.folderId ? folders[0].id : null,
      triggered_by: opts.triggeredBy ?? null,
      status: "running",
    })
    .returning({ id: driveScanRuns.id });

  const counters = {
    files_seen: 0,
    files_new: 0,
    imported: 0,
    skipped_duplicate: 0,
    needs_attention: 0,
    unsupported: 0,
    failed: 0,
  };

  try {
    // Loaded once per run, not per file: the model reuses these tags so the
    // project-level breakdown does not fragment into near-duplicates.
    const existingTags = await loadExistingProjectTags();
    let budget = maxFiles;

    for (const folder of folders) {
      if (budget <= 0 || outOfTime()) break;

      let files: DriveFile[];
      try {
        const listed = await listFolderFiles(folder.drive_folder_id, {
          recursive: folder.recursive,
          includeNames: parseNameList(folder.include_names, DEFAULT_INCLUDED_FOLDER_NAMES),
          excludeNames: parseNameList(folder.exclude_names, DEFAULT_EXCLUDED_FOLDER_NAMES),
        });
        files = listed.files;

        if (listed.skippedOutOfScope.length > 0) {
          const uniq = [...new Set(listed.skippedOutOfScope)];
          console.log(
            `[driveScan] ${listed.skippedOutOfScope.length} file(s) outside the ` +
              `allowlist in ${uniq.length} folder(s): ${uniq.slice(0, 10).join(" | ")}` +
              (uniq.length > 10 ? ` … +${uniq.length - 10} more` : ""),
          );
        }

        // Neither of these is an error, and both change what the numbers mean,
        // so they go in the log rather than staying invisible.
        if (listed.skippedFolders.length > 0) {
          console.log(
            `[driveScan] skipped ${listed.skippedFolders.length} excluded folder(s) under ` +
              `${folder.label ?? folder.drive_folder_id}: ${[...new Set(listed.skippedFolders)].join(", ")}`,
          );
        }
        if (listed.truncatedAtDepth) {
          console.warn(
            `[driveScan] folder ${folder.label ?? folder.drive_folder_id} is nested deeper than ` +
              `the walk limit — some files were NOT seen.`,
          );
        }
      } catch (err) {
        // One unreachable folder should not abandon the others.
        counters.failed += 1;
        await recordFile(run.id, folder.id, folderPlaceholder(folder), {
          status: "failed",
          reason: describeDriveError(err),
          expenseIds: [],
          storageKey: null,
        });
        continue;
      }

      counters.files_seen += files.length;

      const submitter = await resolveSubmitter(folder.created_by, opts.triggeredBy);
      if (!submitter) {
        counters.failed += 1;
        await recordFile(run.id, folder.id, folderPlaceholder(folder), {
          status: "failed",
          reason:
            "No user could be resolved to own the imported expenses. Set DRIVE_EXPENSE_SYSTEM_USER_ID, or make sure the folder's creator still exists.",
          expenseIds: [],
          storageKey: null,
        });
        continue;
      }

      // Version key: Google's md5 where it exists, modifiedTime for native
      // Google files which have none. Never null, so the unique index bites.
      const withVersion = files.map((f) => ({
        file: f,
        version: f.md5Checksum ?? f.modifiedTime ?? "unknown",
      }));

      const seen = await loadSeenVersions(withVersion.map((w) => w.file.id));

      for (const { file, version } of withVersion) {
        if (budget <= 0 || outOfTime()) break;
        if (seen.has(`${file.id}::${version}`)) continue; // already processed, no download

        budget -= 1;
        counters.files_new += 1;

        let outcome: FileOutcome;
        try {
          outcome = await processFile(file, {
            existingTags,
            submitterId: submitter,
            driveFolderRowId: folder.id,
          });
        } catch (err) {
          outcome = {
            status: "failed",
            reason: errText(err),
            expenseIds: [],
            storageKey: null,
          };
        }

        switch (outcome.status) {
          case "imported":
            counters.imported += 1;
            break;
          case "duplicate":
            counters.skipped_duplicate += 1;
            break;
          case "needs_attention":
            counters.needs_attention += 1;
            break;
          case "unsupported":
            counters.unsupported += 1;
            break;
          case "failed":
            counters.failed += 1;
            break;
        }

        await recordFile(run.id, folder.id, file, outcome, version);
      }

      await db
        .update(driveExpenseFolders)
        .set({ last_scanned_at: new Date(), updated_at: new Date() })
        .where(eq(driveExpenseFolders.id, folder.id));
    }

    const durationMs = Date.now() - startedAt;
    await db
      .update(driveScanRuns)
      .set({
        status: "success",
        completed_at: new Date(),
        duration_ms: durationMs,
        ...counters,
      })
      .where(eq(driveScanRuns.id, run.id));

    return {
      run_id: run.id,
      status: "success",
      folders_scanned: folders.length,
      duration_ms: durationMs,
      ...counters,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = errText(err);
    await db
      .update(driveScanRuns)
      .set({
        status: "failed",
        completed_at: new Date(),
        duration_ms: durationMs,
        error_message: message,
        ...counters,
      })
      .where(eq(driveScanRuns.id, run.id));

    return {
      run_id: run.id,
      status: "failed",
      folders_scanned: folders.length,
      duration_ms: durationMs,
      error: message,
      ...counters,
    };
  }
}

// ---------------------------------------------------------------------------
// Per-file pipeline
// ---------------------------------------------------------------------------

async function processFile(
  file: DriveFile,
  ctx: { existingTags: string[]; submitterId: string; driveFolderRowId: string },
): Promise<FileOutcome> {
  const isInvoice = INVOICE_MIME_TYPES.has(file.mimeType);
  const isSheet = SHEET_MIME_TYPES.has(file.mimeType) || isGoogleSheet(file.mimeType);

  if (!isInvoice && !isSheet) {
    return {
      status: "unsupported",
      reason: isGoogleNativeFile(file.mimeType)
        ? `Google-native file (${file.mimeType}) — only Sheets can be read; export Docs to PDF first.`
        : `Unsupported file type: ${file.mimeType}`,
      expenseIds: [],
      storageKey: null,
    };
  }

  if (file.size != null && file.size > MAX_DRIVE_FILE_BYTES) {
    return {
      status: "unsupported",
      reason: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${
        MAX_DRIVE_FILE_BYTES / 1024 / 1024
      } MB limit.`,
      expenseIds: [],
      storageKey: null,
    };
  }

  // --- fetch bytes ---------------------------------------------------------
  const buffer = isGoogleSheet(file.mimeType)
    ? await exportGoogleSheetAsCsv(file.id)
    : await downloadFile(file.id);
  const effectiveMime = isGoogleSheet(file.mimeType) ? "text/csv" : file.mimeType;

  // --- store the original --------------------------------------------------
  // Keyed by Drive file id so re-processing the same file overwrites rather
  // than accumulating copies.
  const storageKey = `expenses/drive/${file.id}/${safeFileName(file.name)}`;
  const billUrl = await storeOriginal(storageKey, buffer, effectiveMime);

  // --- extract -------------------------------------------------------------
  if (isSheet) {
    return importSheet(file, buffer, effectiveMime, storageKey, billUrl, ctx);
  }
  return importInvoice(file, buffer, effectiveMime, storageKey, billUrl, ctx);
}

async function importInvoice(
  file: DriveFile,
  buffer: Buffer,
  mimeType: string,
  storageKey: string,
  billUrl: string | null,
  ctx: { existingTags: string[]; submitterId: string },
): Promise<FileOutcome> {
  const extracted = await extractInvoice(buffer, mimeType, file.name, {
    existingTags: ctx.existingTags,
  });

  const result = validateExpense(extracted as ExpenseCandidate);
  if (!result.ok) {
    // No usable amount. Cannot become a row — expense_submissions.amount is
    // NOT NULL and a zero would silently understate spend.
    return { status: "needs_attention", reason: result.reason, expenseIds: [], storageKey };
  }

  const { value, attention } = result;

  // Dedup layer 2: the same invoice arriving as a different file.
  if (value.invoice_number) {
    const [dup] = await db
      .select({ id: expenseSubmissions.id })
      .from(expenseSubmissions)
      .where(
        and(
          eq(expenseSubmissions.source, "ai"),
          sql`lower(${expenseSubmissions.invoice_number}) = lower(${value.invoice_number})`,
        ),
      )
      .limit(1);
    if (dup) {
      return {
        status: "duplicate",
        reason: `Invoice ${value.invoice_number} is already recorded.`,
        expenseIds: [],
        storageKey,
      };
    }
  }

  const inserted = await insertExpense({
    submitterId: ctx.submitterId,
    value,
    attention,
    billUrl,
    storageKey,
    driveFileId: file.id,
    driveRowRef: null,
    fileName: file.name,
    aiRaw: extracted,
    aiBucket: extracted.bucket,
    aiBucketConfidence: extracted.bucket_confidence,
  });

  if (inserted === "duplicate") {
    return {
      status: "duplicate",
      reason: "Already imported (caught by the unique index).",
      expenseIds: [],
      storageKey,
    };
  }

  // 'imported' even when flagged. The file-level status answers exactly one
  // question — did this file become an expense row? — because that is what
  // the UI's "could not be imported / this spend is not on the dashboard"
  // section means. Anything imperfect ABOUT the row travels on the row's own
  // needs_attention flag. Conflating the two told an admin that a USD invoice
  // sitting in the dashboard total was missing from it.
  return {
    status: "imported",
    reason: formatAttentionReason(attention),
    expenseIds: [inserted],
    storageKey,
  };
}

async function importSheet(
  file: DriveFile,
  buffer: Buffer,
  mimeType: string,
  storageKey: string,
  billUrl: string | null,
  ctx: { existingTags: string[]; submitterId: string },
): Promise<FileOutcome> {
  // XLSX.read handles .xlsx, .xls and .csv from the same call.
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      status: "needs_attention",
      reason: "The spreadsheet has no sheets.",
      expenseIds: [],
      storageKey,
    };
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    defval: null,
  });

  const extracted = await extractCostingSheet(rows as never, sheetName, {
    existingTags: ctx.existingTags,
  });

  if (extracted.rows.length === 0) {
    return {
      status: "needs_attention",
      reason: "No cost lines with a readable amount were found in this spreadsheet.",
      expenseIds: [],
      storageKey,
    };
  }

  const expenseIds: string[] = [];
  const problems: string[] = [];
  let attentionCount = 0;

  for (const row of extracted.rows) {
    // Spreadsheet rows legitimately have no invoice number of their own —
    // flagging every one would bury the genuinely broken rows.
    const result = validateExpense(row, { requireInvoiceNumber: false });
    if (!result.ok) {
      problems.push(`${row.row_ref}: ${result.reason}`);
      continue;
    }

    const inserted = await insertExpense({
      submitterId: ctx.submitterId,
      value: result.value,
      attention: result.attention,
      billUrl,
      storageKey,
      driveFileId: file.id,
      driveRowRef: row.row_ref,
      fileName: file.name,
      aiRaw: row,
      // Read once for the whole sheet — every line inherits it unless a
      // per-row vendor rule says otherwise.
      aiBucket: row.bucket,
    });

    if (inserted === "duplicate") continue; // dedup layer 3: file + row
    expenseIds.push(inserted);
    if (result.attention.length > 0) attentionCount += 1;
  }

  if (expenseIds.length === 0) {
    return {
      status: "duplicate",
      reason: "Every row in this spreadsheet was already imported.",
      expenseIds: [],
      storageKey,
    };
  }

  // Report what was dropped rather than letting a silent cap read as success.
  const notes = [
    `Imported ${expenseIds.length} cost line${expenseIds.length === 1 ? "" : "s"} from "${sheetName}".`,
    extracted.truncatedNote,
    extracted.unparsedRows > 0
      ? `${extracted.unparsedRows} row(s) had no readable amount and were skipped.`
      : null,
    attentionCount > 0 ? `${attentionCount} row(s) need attention.` : null,
    ...problems.slice(0, 5),
  ].filter(Boolean) as string[];

  // Rows that made it in are imported (see the note in importInvoice). Only a
  // row the validator REJECTED produced no expense at all, and those are what
  // `problems` holds — so the file only reads as needs_attention when some of
  // its lines are genuinely absent from the dashboard.
  return {
    status: problems.length > 0 ? "needs_attention" : "imported",
    reason: notes.join(" "),
    expenseIds,
    storageKey,
  };
}

/**
 * Insert one expense row. Returns the new id, or the string "duplicate" when a
 * unique index rejected it.
 *
 * `status: "approved"` with `approved_by` set matches what the existing manual
 * AI import does — there is no approval step in this pipeline, and the CEO
 * card only counts approved rows.
 */
async function insertExpense(args: {
  submitterId: string;
  value: {
    vendor: string | null;
    amount: number;
    currency: string | null;
    expense_date: string | null;
    description: string | null;
    department: string;
    project_tag: string | null;
    invoice_number: string | null;
  };
  attention: string[];
  billUrl: string | null;
  storageKey: string;
  driveFileId: string;
  driveRowRef: string | null;
  fileName: string;
  aiRaw: unknown;
  /** E-218 — what the extractor suggested; rules can still override it. */
  aiBucket?: string | null;
  aiBucketConfidence?: number | null;
}): Promise<string | "duplicate"> {
  const now = new Date();

  // E-218 — bucket the spend. Deterministic vendor/keyword rules win over the
  // model so a known supplier cannot drift between buckets from one scan to
  // the next, which would make the month-on-month comparison lie.
  const bucket = resolveBucket({
    vendor: args.value.vendor,
    description: args.value.description,
    project_tag: args.value.project_tag,
    aiBucket: args.aiBucket,
    aiConfidence: args.aiBucketConfidence,
  });

  // E-217 — `amount` is the column every report SUMs, so it must always be
  // INR. What the document said is preserved separately, along with the rate
  // that connects them.
  const fx = await convertToInr(
    args.value.amount,
    args.value.currency,
    args.value.expense_date,
  );
  const attention = fx.warning ? [...args.attention, fx.warning] : args.attention;

  try {
    const [row] = await db
      .insert(expenseSubmissions)
      .values({
        submitted_by: args.submitterId,
        category: "Invoice",
        amount: fx.amountInr.toFixed(2),
        currency: args.value.currency ?? "INR",
        original_amount: args.value.amount.toFixed(2),
        fx_rate: String(fx.rate),
        fx_rate_date: fx.rateDate,
        fx_source: fx.source,
        description: args.value.description,
        bill_url: args.billUrl,
        bill_storage_path: args.storageKey,
        status: "approved",
        approved_by: args.submitterId,
        approved_at: now,
        department: args.value.department,
        project_tag: args.value.project_tag,
        bucket: bucket.bucket,
        bucket_source: bucket.source,
        vendor: args.value.vendor,
        expense_date: args.value.expense_date,
        source: "ai",
        ai_raw: args.aiRaw as never,
        invoice_number: args.value.invoice_number,
        file_name: args.fileName.slice(0, 255),
        drive_file_id: args.driveFileId,
        drive_row_ref: args.driveRowRef,
        needs_attention: attention.length > 0,
        attention_reason: formatAttentionReason(attention),
      })
      .returning({ id: expenseSubmissions.id });
    return row.id;
  } catch (e: unknown) {
    // Race backstop for both partial unique indexes (E-172 invoice number,
    // E-216 drive file+row).
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
      return "duplicate";
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadFolders(folderRowId?: string) {
  const conds = [eq(driveExpenseFolders.is_active, true)];
  if (folderRowId) conds.push(eq(driveExpenseFolders.id, folderRowId));
  return db
    .select()
    .from(driveExpenseFolders)
    .where(and(...conds))
    .orderBy(driveExpenseFolders.created_at);
}

async function loadExistingProjectTags(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tag: expenseSubmissions.project_tag })
    .from(expenseSubmissions)
    .where(isNotNull(expenseSubmissions.project_tag))
    .orderBy(expenseSubmissions.project_tag)
    .limit(100);
  return rows.map((r) => r.tag).filter(Boolean) as string[];
}

/** `${fileId}::${version}` for every file version already processed. */
async function loadSeenVersions(fileIds: string[]): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  const seen = new Set<string>();
  // Chunked: a folder can hold more ids than one IN list should carry.
  for (let i = 0; i < fileIds.length; i += 500) {
    const chunk = fileIds.slice(i, i + 500);
    const rows = await db
      .select({
        drive_file_id: driveExpenseFiles.drive_file_id,
        md5_checksum: driveExpenseFiles.md5_checksum,
      })
      .from(driveExpenseFiles)
      .where(inArray(driveExpenseFiles.drive_file_id, chunk));
    for (const r of rows) seen.add(`${r.drive_file_id}::${r.md5_checksum ?? "unknown"}`);
  }
  return seen;
}

async function recordFile(
  runId: string,
  folderRowId: string,
  file: DriveFile,
  outcome: FileOutcome,
  version?: string,
): Promise<void> {
  try {
    await db.insert(driveExpenseFiles).values({
      run_id: runId,
      folder_id: folderRowId,
      drive_file_id: file.id,
      drive_file_name: file.name.slice(0, 512),
      folder_path: file.folderPath || null,
      mime_type: file.mimeType.slice(0, 160),
      md5_checksum: (version ?? file.md5Checksum ?? file.modifiedTime ?? "unknown").slice(0, 128),
      drive_modified_time: file.modifiedTime ? new Date(file.modifiedTime) : null,
      status: outcome.status,
      reason: outcome.reason,
      expense_ids: outcome.expenseIds as never,
      storage_key: outcome.storageKey,
    });
  } catch (e: unknown) {
    // The (file_id, version) unique index firing here means a concurrent run
    // already logged this file. Nothing to do — the counters are approximate
    // by design and the expense rows are guarded by their own indexes.
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") return;
    throw e;
  }
}

/**
 * Who owns the imported rows. `submitted_by` / `approved_by` are NOT NULL, and
 * a ticker run has no human actor.
 *
 * Order: whoever triggered the scan → the configured system user → the admin
 * who added the folder. Each candidate is checked against `users` so a stale
 * env var or a deleted account fails here with a clear message rather than as
 * a foreign-key error on every insert.
 */
async function resolveSubmitter(
  folderCreatedBy: string | null,
  triggeredBy?: string | null,
): Promise<string | null> {
  const candidates = [
    triggeredBy,
    process.env.DRIVE_EXPENSE_SYSTEM_USER_ID,
    folderCreatedBy,
  ].filter((v): v is string => Boolean(v && v.trim()));

  for (const id of candidates) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (row) return row.id;
  }
  return null;
}

/** Persist the original document so the bill is viewable from the dashboard. */
async function storeOriginal(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string | null> {
  try {
    if (isS3Backend) {
      await putObject("documents", key, buffer, contentType);
      return filesProxyPath("documents", key);
    }
    const supabase = createAdminClient();
    const { error } = await supabase.storage
      .from("documents")
      .upload(key, buffer, { contentType, upsert: true });
    if (error) throw new Error(error.message);
    const { data } = supabase.storage.from("documents").getPublicUrl(key);
    return data.publicUrl;
  } catch (err) {
    // Losing the bill copy is not a reason to lose the expense — the numbers
    // matter more than the attachment, and the Drive original still exists.
    console.error("[driveScan] failed to store original:", errText(err));
    return null;
  }
}

/**
 * Comma-separated folder names → array.
 *
 * A blank string means "no filter" and is honoured as such — an admin who
 * deliberately cleared the field must get what they asked for. Only a NULL
 * column (row predates the feature) falls back to the default.
 */
function parseNameList(raw: string | null, fallback: string[]): string[] {
  if (raw == null) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A stand-in DriveFile for a failure that belongs to the FOLDER, not to any
 * one file — an unreachable folder, or no resolvable owner for its imports.
 * Without a row, those failures would leave the run counters saying "0 files"
 * with nothing explaining why.
 */
function folderPlaceholder(folder: {
  drive_folder_id: string;
  label: string | null;
}): DriveFile {
  return {
    id: `folder:${folder.drive_folder_id}`,
    name: folder.label ?? folder.drive_folder_id,
    mimeType: "application/vnd.google-apps.folder",
    md5Checksum: null,
    modifiedTime: null,
    size: null,
    parentFolderId: folder.drive_folder_id,
    folderPath: "",
  };
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 180) || "file";
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return describeDriveError(err);
}

/** Most recent runs, for the admin panel. */
export async function listRecentRuns(limit = 20) {
  return db
    .select()
    .from(driveScanRuns)
    .orderBy(desc(driveScanRuns.started_at))
    .limit(limit);
}

/** Files belonging to one run, for the run-detail drawer. */
export async function listRunFiles(runId: string) {
  return db
    .select()
    .from(driveExpenseFiles)
    .where(eq(driveExpenseFiles.run_id, runId))
    .orderBy(desc(driveExpenseFiles.created_at));
}

/** Files still needing a human, across all runs. */
export async function listAttentionFiles(limit = 100) {
  return db
    .select()
    .from(driveExpenseFiles)
    .where(inArray(driveExpenseFiles.status, ["needs_attention", "failed"]))
    .orderBy(desc(driveExpenseFiles.created_at))
    .limit(limit);
}
