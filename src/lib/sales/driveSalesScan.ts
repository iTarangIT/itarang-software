/**
 * E-280 — the Google Drive SALES scanner.
 *
 * Walks the configured Drive folders' SALE side and, for each file it has not
 * already processed: downloads it, extracts the invoice, resolves which iTarang
 * entity issued it, validates it, dedupes it against both `sales_invoices` and
 * the historical `zoho_invoices`, and writes a row the CEO dashboard reads
 * through src/lib/dashboard/revenueSource.ts.
 *
 * The purchase-side counterpart is src/lib/expenses/driveScan.ts. This module
 * deliberately does not share code with it beyond the Drive reader: the two
 * differ in extraction, validation, entity resolution, dedup and target table,
 * and the ~120 lines of run machinery they have in common are not worth
 * refactoring a working money pipeline to unify. If a third kind of scan ever
 * appears, extract the runner then.
 *
 * Deliberately sequential, for the same reason as the expense scanner: every
 * new file costs one vision call, so parallelism buys little against the
 * model's own latency while multiplying the chance of a 429 mid-run. Throughput
 * comes from the version dedup below — a re-scan of a settled folder makes zero
 * model calls — not from concurrency.
 *
 * A single bad file must never kill a run. Each file is wrapped, records its
 * own outcome row, and the loop moves on; only an unrecoverable failure (Drive
 * unreachable, DB down) marks the run itself failed.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  salesInvoiceFolders,
  salesInvoices,
  salesScanFiles,
  salesScanRuns,
  zohoInvoices,
} from "@/lib/db/schema";
import {
  MAX_DRIVE_FILE_BYTES,
  describeDriveError,
  downloadFile,
  isDriveConfigured,
  isGoogleNativeFile,
  listFolderFiles,
  type DriveFile,
} from "@/lib/google/drive";
import { extractSalesInvoice } from "@/lib/ai/invoices/extractSalesInvoice";
import { customerKey } from "@/lib/sales/customerKey";
import { isTerminalModelFailure } from "@/lib/sales/terminalModelFailure";
import { normalizeInvoiceNumber } from "@/lib/sales/normalizeInvoiceNumber";
import { resolveSalesOrg } from "@/lib/sales/resolveSalesOrg";
import {
  formatSalesAttention,
  validateSalesInvoice,
} from "@/lib/sales/validateSalesInvoice";
import { filesProxyPath, isS3Backend, putObject } from "@/lib/storage/s3";
import { createAdminClient } from "@/lib/supabase/admin";

/** MIME types `extractSalesInvoice` can read. Sales invoices are documents, not sheets. */
const INVOICE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

/**
 * A run 'running' for longer than this is assumed dead (a pm2 restart mid-scan)
 * and no longer blocks a new one.
 */
const STALE_RUN_MS = 30 * 60 * 1000;

const DEFAULT_MAX_FILES = 25;

/**
 * Stop cleanly after this long, whatever the file budget says.
 *
 * A file costs ~5s (download + one vision call). Without a deadline a large
 * batch outlives the 300s maxDuration on the "Scan now" route, the handler is
 * killed, the run row is stranded at 'running', and it then blocks the next
 * scan for 30 minutes. Finishing early costs nothing: "already processed" is a
 * property of the file's checksum, so the next run resumes where this stopped.
 */
const DEFAULT_TIME_BUDGET_MS = 4 * 60_000;

export interface SalesScanSummary {
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
  invoiceIds: string[];
  storageKey: string | null;
}

/** What a file WOULD become. Surfaced so a dry run can be read line by line. */
export interface SalesProposal {
  invoice_number: string | null;
  invoice_number_key: string | null;
  invoice_date: string | null;
  customer_name: string | null;
  total: number;
  sub_total: number | null;
  tax_total: number | null;
  organization_id: string | null;
  org_label: string | null;
  attention: string[];
}

export async function runSalesScan(
  opts: {
    folderId?: string;
    triggeredBy?: string | null;
    maxFiles?: number;
    timeBudgetMs?: number;
    /**
     * Read, extract and decide, but write nothing — no invoice rows, no run
     * row, no file log, no folder timestamp.
     *
     * This is how a backfill is inspected before it is trusted. The Drive tree
     * holds the Zoho era as well as the Vyapar one, so the number that matters
     * before committing is how many files come back `duplicate`: a Zoho-era
     * month that reports anything else means the invoice-number dedup is not
     * matching and revenue is about to be counted twice.
     *
     * Note this still costs a download and a vision call per file — it is a
     * rehearsal, not a cheap preview.
     */
    dryRun?: boolean;
    /** Called for every file processed, for a dry run's report. */
    onFile?: (info: {
      file: DriveFile;
      outcome: FileOutcome;
      proposal: SalesProposal | null;
    }) => void;
  } = {},
): Promise<SalesScanSummary> {
  const startedAt = Date.now();
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const deadline = startedAt + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const outOfTime = () => Date.now() >= deadline;

  const empty = (
    status: SalesScanSummary["status"],
    extra: Partial<SalesScanSummary> = {},
  ): SalesScanSummary => ({
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
    .select({ id: salesScanRuns.id })
    .from(salesScanRuns)
    .where(
      and(
        eq(salesScanRuns.status, "running"),
        gt(salesScanRuns.started_at, new Date(Date.now() - STALE_RUN_MS)),
      ),
    )
    .limit(1);
  if (inFlight) {
    return empty("skipped", { skipped_reason: "A sales scan is already running." });
  }

  const folders = await loadFolders(opts.folderId);
  if (folders.length === 0) {
    return empty("skipped", {
      skipped_reason: opts.folderId
        ? "That folder is not configured or is inactive."
        : "No active sales Drive folders are configured.",
    });
  }

  // A dry run takes no run row: it is not a scan anybody should see in the
  // history, and it must not hold the concurrency guard against a real one.
  let runId: string | null = null;
  if (!opts.dryRun) {
    const [run] = await db
      .insert(salesScanRuns)
      .values({
        folder_id: opts.folderId ? folders[0].id : null,
        triggered_by: opts.triggeredBy ?? null,
        status: "running",
      })
      .returning({ id: salesScanRuns.id });
    runId = run.id;
  }

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
    // Loaded ONCE per run, not per file. The Drive tree holds the Zoho era as
    // well as the Vyapar one, so most of a backfill's files are invoices we
    // already have; this is what recognises them without a query each.
    const zohoKeys = await loadZohoNumberKeys();

    let budget = maxFiles;

    for (const folder of folders) {
      if (budget <= 0 || outOfTime()) break;

      let files: DriveFile[];
      try {
        const listed = await listFolderFiles(folder.drive_folder_id, {
          recursive: folder.recursive,
          includeNames: parseNameList(folder.include_names, ["sale"]),
          excludeNames: parseNameList(folder.exclude_names, ["purchase"]),
        });
        files = listed.files;

        // None of these is an error, and all three change what the numbers
        // mean, so they go in the log rather than staying invisible.
        if (listed.skippedOutOfScope.length > 0) {
          const uniq = [...new Set(listed.skippedOutOfScope)];
          console.log(
            `[salesScan] ${listed.skippedOutOfScope.length} file(s) outside the ` +
              `allowlist in ${uniq.length} folder(s): ${uniq.slice(0, 10).join(" | ")}` +
              (uniq.length > 10 ? ` … +${uniq.length - 10} more` : ""),
          );
        }
        if (listed.skippedFolders.length > 0) {
          console.log(
            `[salesScan] skipped ${listed.skippedFolders.length} excluded folder(s) under ` +
              `${folder.label ?? folder.drive_folder_id}: ${[...new Set(listed.skippedFolders)].join(", ")}`,
          );
        }
        if (listed.truncatedAtDepth) {
          console.warn(
            `[salesScan] folder ${folder.label ?? folder.drive_folder_id} is nested deeper ` +
              `than the walk limit — some files were NOT seen.`,
          );
        }
      } catch (err) {
        // One unreachable folder should not abandon the others.
        counters.failed += 1;
        if (runId) {
          await recordFile(runId, folder.id, folderPlaceholder(folder), {
            status: "failed",
            reason: describeDriveError(err),
            invoiceIds: [],
            storageKey: null,
          });
        }
        continue;
      }

      counters.files_seen += files.length;

      // Version key: Google's md5 where it exists, modifiedTime where it does
      // not. Never null, so the unique index bites.
      const withVersion = files.map((f) => ({
        file: f,
        version: f.md5Checksum ?? f.modifiedTime ?? "unknown",
      }));

      const seen = await loadSeenVersions(withVersion.map((w) => w.file.id));

      for (const { file, version } of withVersion) {
        if (budget <= 0 || outOfTime()) break;
        if (seen.has(`${file.id}::${version}`)) continue; // processed; no download

        budget -= 1;
        counters.files_new += 1;

        let outcome: FileOutcome;
        let proposal: SalesProposal | null = null;
        try {
          const res = await processFile(file, {
            zohoKeys,
            dryRun: Boolean(opts.dryRun),
          });
          outcome = res.outcome;
          proposal = res.proposal;
        } catch (err) {
          outcome = {
            status: "failed",
            reason: errText(err),
            invoiceIds: [],
            storageKey: null,
          };
        }
        opts.onFile?.({ file, outcome, proposal });

        // Stop the whole run rather than repeating one unfixable error per file.
        if (outcome.status === "failed" && isTerminalModelFailure(outcome.reason ?? "")) {
          if (runId) await recordFile(runId, folder.id, file, outcome, version);
          counters.failed += 1;
          throw new Error(
            `Extraction is unavailable, so the scan stopped after ${counters.files_new} file(s): ` +
              `${outcome.reason}`,
          );
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

        if (runId) await recordFile(runId, folder.id, file, outcome, version);
      }

      if (!opts.dryRun) {
        await db
          .update(salesInvoiceFolders)
          .set({ last_scanned_at: new Date(), updated_at: new Date() })
          .where(eq(salesInvoiceFolders.id, folder.id));
      }
    }

    const durationMs = Date.now() - startedAt;
    if (runId) {
      await db
        .update(salesScanRuns)
        .set({
          status: "success",
          completed_at: new Date(),
          duration_ms: durationMs,
          ...counters,
        })
        .where(eq(salesScanRuns.id, runId));
    }

    return {
      run_id: runId,
      status: "success",
      folders_scanned: folders.length,
      duration_ms: durationMs,
      ...counters,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = errText(err);
    if (runId) {
      await db
        .update(salesScanRuns)
        .set({
          status: "failed",
          completed_at: new Date(),
          duration_ms: durationMs,
          error_message: message,
          ...counters,
        })
        .where(eq(salesScanRuns.id, runId));
    }

    return {
      run_id: runId,
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
  ctx: { zohoKeys: Set<string>; dryRun: boolean },
): Promise<{ outcome: FileOutcome; proposal: SalesProposal | null }> {
  if (!INVOICE_MIME_TYPES.has(file.mimeType)) {
    return {
      outcome: {
        status: "unsupported",
        reason: isGoogleNativeFile(file.mimeType)
          ? `Google-native file (${file.mimeType}) — export it to PDF to have it read.`
          : `Unsupported file type: ${file.mimeType}`,
        invoiceIds: [],
        storageKey: null,
      },
      proposal: null,
    };
  }

  if (file.size != null && file.size > MAX_DRIVE_FILE_BYTES) {
    return {
      outcome: {
        status: "unsupported",
        reason: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${
          MAX_DRIVE_FILE_BYTES / 1024 / 1024
        } MB limit.`,
        invoiceIds: [],
        storageKey: null,
      },
      proposal: null,
    };
  }

  const buffer = await downloadFile(file.id);

  // Keyed by Drive file id so re-processing overwrites rather than accumulating.
  const storageKey = `sales/drive/${file.id}/${safeFileName(file.name)}`;
  const documentUrl = ctx.dryRun
    ? null
    : await storeOriginal(storageKey, buffer, file.mimeType);

  const extracted = await extractSalesInvoice(buffer, file.mimeType, file.name);

  const result = validateSalesInvoice(extracted, { folderPath: file.folderPath });
  if (!result.ok) {
    // No usable total. Cannot become a row — a zero would silently understate
    // revenue, which is worse than a gap somebody can see.
    return {
      outcome: {
        status: "needs_attention",
        reason: result.reason,
        invoiceIds: [],
        storageKey,
      },
      proposal: null,
    };
  }

  const { value } = result;
  const attention = [...result.attention];

  const org = resolveSalesOrg({
    sellerGstin: value.seller_gstin,
    invoiceNumber: value.invoice_number,
    fileName: file.name,
    folderPath: file.folderPath,
  });
  if (org.conflict) {
    attention.push(
      `Entity signals disagree (${org.signals.join(", ")}) — recorded as ${org.label}.`,
    );
  } else if (!org.organizationId) {
    attention.push("Could not tell which iTarang entity issued this invoice.");
  }

  // --- dedup ---------------------------------------------------------------
  const numberKey = normalizeInvoiceNumber(value.invoice_number);

  const proposal: SalesProposal = {
    invoice_number: value.invoice_number,
    invoice_number_key: numberKey,
    invoice_date: value.invoice_date,
    customer_name: value.customer_name,
    total: value.total,
    sub_total: value.sub_total,
    tax_total: value.tax_total,
    organization_id: org.organizationId,
    org_label: org.label,
    attention,
  };

  // Layer 2a: the same invoice already imported from Drive.
  if (numberKey) {
    const [dup] = await db
      .select({ id: salesInvoices.id })
      .from(salesInvoices)
      .where(eq(salesInvoices.invoice_number_key, numberKey))
      .limit(1);
    if (dup) {
      return {
        outcome: {
          status: "duplicate",
          reason: `Invoice ${value.invoice_number} is already recorded.`,
          invoiceIds: [],
          storageKey,
        },
        proposal,
      };
    }

    // Layer 2b: the same invoice already in the DB from the Zoho era. This is
    // what stops a full backfill double-counting every pre-Vyapar month.
    if (ctx.zohoKeys.has(numberKey)) {
      return {
        outcome: {
          status: "duplicate",
          reason: `Invoice ${value.invoice_number} was already synced from Zoho.`,
          invoiceIds: [],
          storageKey,
        },
        proposal,
      };
    }
  }

  // Layer 3: a same-entity, same-date, same-amount, same-CUSTOMER twin — for an
  // invoice whose number was misread or re-issued in a different format.
  //
  // The customer is part of the test because (org, date, total) alone is NOT
  // unique in the real data: five genuinely distinct Zoho invoices share
  // (ITG, 2026-03-31, 12980.00), one per dealer, and two more pairs share
  // (2026-03-19, 36580.00) and (2026-03-31, 11000.00). Fingerprinting without
  // the customer would flag all of those, and SKIPPING on it would have thrown
  // four real invoices away.
  //
  // And a hit is still only a FLAG, never a skip. The numbers differ, so one of
  // the two records is wrong, and which one cannot be decided here. The live
  // case: Zoho holds ITG/202526/5 and /7 but not /6, and the Drive file "Hakim
  // Ali 5 Charger Invoice.pdf" reads as /6 for the same customer, date and
  // ₹34,125 as Zoho's /7 — almost certainly a 7 misread as a 6, but that is a
  // person's call, not this function's.
  const twin = await findFingerprintTwin(
    org.organizationId,
    value.invoice_date,
    value.total,
    value.customer_name,
  );
  if (twin) {
    attention.push(
      `Possible duplicate of ${twin.source} invoice ${twin.invoice_number ?? "(no number)"} — ` +
        `same customer (${twin.customer_name ?? "?"}), same date and the same ₹${value.total.toFixed(2)}. ` +
        `Confirm before trusting this row.`,
    );
  }

  if (ctx.dryRun) {
    return {
      outcome: {
        status: "imported",
        reason: formatSalesAttention(attention),
        invoiceIds: [],
        storageKey: null,
      },
      proposal,
    };
  }

  try {
    const [row] = await db
      .insert(salesInvoices)
      .values({
        source: "drive",
        invoice_number: value.invoice_number,
        invoice_number_key: numberKey,
        invoice_date: value.invoice_date,
        due_date: value.due_date,
        customer_name: value.customer_name,
        customer_gstin: value.customer_gstin,
        place_of_supply: value.place_of_supply,
        organization_id: org.organizationId,
        seller_gstin: value.seller_gstin,
        sub_total: value.sub_total == null ? null : value.sub_total.toFixed(2),
        tax_total: value.tax_total == null ? null : value.tax_total.toFixed(2),
        total: value.total.toFixed(2),
        // Revenue is booked on issue; collection is recorded separately by
        // finance. A Drive-filed invoice has been issued, so never 'draft'.
        status: "sent",
        drive_file_id: file.id,
        file_name: file.name.slice(0, 255),
        folder_path: file.folderPath || null,
        document_url: documentUrl,
        storage_key: storageKey,
        ai_raw: extracted as never,
        needs_attention: attention.length > 0,
        attention_reason: formatSalesAttention(attention),
      })
      .returning({ id: salesInvoices.id });

    // 'imported' even when flagged. The file-level status answers exactly one
    // question — did this file become an invoice row? — because that is what
    // the admin panel's "could not be imported" section means. Anything
    // imperfect ABOUT the row travels on the row's own needs_attention flag.
    return {
      outcome: {
        status: "imported",
        reason: formatSalesAttention(attention),
        invoiceIds: [row.id],
        storageKey,
      },
      proposal,
    };
  } catch (e: unknown) {
    // Race backstop for sales_invoices_number_key_unique.
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
      return {
        outcome: {
          status: "duplicate",
          reason: "Already imported (caught by the unique index).",
          invoiceIds: [],
          storageKey,
        },
        proposal,
      };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadFolders(folderRowId?: string) {
  const conds = [eq(salesInvoiceFolders.is_active, true)];
  if (folderRowId) conds.push(eq(salesInvoiceFolders.id, folderRowId));
  return db
    .select()
    .from(salesInvoiceFolders)
    .where(and(...conds))
    .orderBy(salesInvoiceFolders.created_at);
}

/**
 * Every historical Zoho invoice number, normalised.
 *
 * Held in memory for the run rather than compared in SQL because the two sides
 * spell the same invoice differently ('ITD/202627/013' vs 'ITD_202627_013') and
 * the folding rules live in normalizeInvoiceNumber, not in Postgres. A few
 * thousand short strings is nothing; re-deriving it per file would be thousands
 * of round trips.
 */
async function loadZohoNumberKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const rows = await db
      .select({ invoice_number: zohoInvoices.invoice_number })
      .from(zohoInvoices);
    for (const r of rows) {
      const k = normalizeInvoiceNumber(r.invoice_number);
      if (k) keys.add(k);
    }
  } catch (e) {
    // Not fatal: without this set the number dedup still catches Drive-vs-Drive
    // repeats and the fingerprint check still flags look-alikes. Loud, though,
    // because a backfill run without it can double-count the Zoho era.
    console.error(
      "[salesScan] could not load Zoho invoice numbers for dedup — a backfill may " +
        "re-import invoices that are already in zoho_invoices:",
      errText(e),
    );
  }
  return keys;
}

/**
 * An existing invoice with the same entity, date, total AND customer but a
 * different number. Checked across both sources.
 *
 * The customer is part of the key on purpose — see the call site: without it
 * the test matches five legitimately distinct invoices in the live data.
 */
async function findFingerprintTwin(
  organizationId: string | null,
  invoiceDate: string | null,
  total: number,
  customerName: string | null,
): Promise<{ source: string; invoice_number: string | null; customer_name: string | null } | null> {
  if (!invoiceDate) return null;
  // With no customer to compare, the remaining signals are too weak to call a
  // duplicate — flagging on them would cry wolf on every same-price sale.
  const wantCustomer = customerKey(customerName);
  if (!wantCustomer) return null;

  const amount = total.toFixed(2);

  const salesConds = [
    eq(salesInvoices.invoice_date, invoiceDate),
    sql`${salesInvoices.total} = ${amount}::numeric`,
  ];
  if (organizationId) {
    salesConds.push(eq(salesInvoices.organization_id, organizationId));
  }
  const fromSales = await db
    .select({
      invoice_number: salesInvoices.invoice_number,
      customer_name: salesInvoices.customer_name,
    })
    .from(salesInvoices)
    .where(and(...salesConds));
  for (const r of fromSales) {
    if (customerKey(r.customer_name) === wantCustomer) {
      return { source: "Drive", invoice_number: r.invoice_number, customer_name: r.customer_name };
    }
  }

  try {
    const zohoConds = [
      eq(zohoInvoices.invoice_date, invoiceDate),
      sql`${zohoInvoices.total} = ${amount}::numeric`,
    ];
    if (organizationId) {
      zohoConds.push(eq(zohoInvoices.organization_id, organizationId));
    }
    const fromZoho = await db
      .select({
        invoice_number: zohoInvoices.invoice_number,
        customer_name: zohoInvoices.customer_name,
      })
      .from(zohoInvoices)
      .where(and(...zohoConds));
    for (const r of fromZoho) {
      if (customerKey(r.customer_name) === wantCustomer) {
        return { source: "Zoho", invoice_number: r.invoice_number, customer_name: r.customer_name };
      }
    }
  } catch {
    // Same tolerance as loadZohoNumberKeys — a missing table costs a warning,
    // not the import.
  }
  return null;
}

/**
 * `${fileId}::${version}` for every file version that reached a SETTLED outcome.
 *
 * 'failed' is deliberately excluded, and the distinction is load-bearing. A
 * failure here is an exception — Drive unreachable, a 429, the model API out of
 * credits — none of which say anything about the file. Treating those as
 * processed would permanently skip the file: its checksum never changes, so it
 * would never be retried and the invoice would be silently missing from revenue
 * for ever. This was not hypothetical: an exhausted OpenAI balance failed 30
 * files in one run, every one of which must be picked up by the next.
 *
 * The other four ARE settled and must not be retried:
 *   imported / duplicate  — the row exists, or an identical one does.
 *   unsupported           — the file type cannot change without a new checksum.
 *   needs_attention       — it WAS read successfully; the content was unusable,
 *                           and re-reading identical bytes costs a model call to
 *                           reach the same conclusion. It is surfaced to a human
 *                           through the attention list instead.
 */
const SETTLED_FILE_STATUSES = [
  "imported",
  "duplicate",
  "unsupported",
  "needs_attention",
];

async function loadSeenVersions(fileIds: string[]): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  const seen = new Set<string>();
  // Chunked: a folder can hold more ids than one IN list should carry.
  for (let i = 0; i < fileIds.length; i += 500) {
    const chunk = fileIds.slice(i, i + 500);
    const rows = await db
      .select({
        drive_file_id: salesScanFiles.drive_file_id,
        md5_checksum: salesScanFiles.md5_checksum,
      })
      .from(salesScanFiles)
      .where(
        and(
          inArray(salesScanFiles.drive_file_id, chunk),
          inArray(salesScanFiles.status, SETTLED_FILE_STATUSES),
        ),
      );
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
  const values = {
    run_id: runId,
    folder_id: folderRowId,
    drive_file_id: file.id,
    drive_file_name: file.name.slice(0, 512),
    folder_path: file.folderPath || null,
    mime_type: file.mimeType.slice(0, 160),
    md5_checksum: (version ?? file.md5Checksum ?? file.modifiedTime ?? "unknown").slice(
      0,
      128,
    ),
    drive_modified_time: file.modifiedTime ? new Date(file.modifiedTime) : null,
    status: outcome.status,
    reason: outcome.reason,
    invoice_ids: outcome.invoiceIds as never,
    storage_key: outcome.storageKey,
  };

  // Upsert rather than insert-and-swallow-23505. A retried file already has a
  // row from the run that failed it, and a plain insert would be rejected by
  // (drive_file_id, md5_checksum) — leaving the log permanently showing the old
  // failure while the invoice had in fact been imported. The newest outcome
  // wins, which is also what makes the retry above visible.
  await db
    .insert(salesScanFiles)
    .values(values)
    .onConflictDoUpdate({
      target: [salesScanFiles.drive_file_id, salesScanFiles.md5_checksum],
      set: {
        run_id: values.run_id,
        status: values.status,
        reason: values.reason,
        invoice_ids: values.invoice_ids,
        storage_key: values.storage_key,
        folder_path: values.folder_path,
      },
    });
}

/** Persist the original document so the invoice is viewable from the dashboard. */
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
    // Losing the copy is not a reason to lose the invoice — the numbers matter
    // more than the attachment, and the Drive original still exists.
    console.error("[salesScan] failed to store original:", errText(err));
    return null;
  }
}

/**
 * Comma-separated folder names → array.
 *
 * A blank string means "no filter" and is honoured as such — an admin who
 * deliberately cleared the field must get what they asked for. Only a NULL
 * column falls back to the default.
 */
function parseNameList(raw: string | null, fallback: string[]): string[] {
  if (raw == null) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A stand-in DriveFile for a failure that belongs to the FOLDER rather than to
 * any one file. Without a row, those failures would leave the run counters
 * saying "0 files" with nothing explaining why.
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
export async function listRecentSalesRuns(limit = 20) {
  return db
    .select()
    .from(salesScanRuns)
    .orderBy(desc(salesScanRuns.started_at))
    .limit(limit);
}

/** Files belonging to one run, for the run-detail drawer. */
export async function listSalesRunFiles(runId: string) {
  return db
    .select()
    .from(salesScanFiles)
    .where(eq(salesScanFiles.run_id, runId))
    .orderBy(desc(salesScanFiles.created_at));
}

/** Files still needing a human, across all runs. */
export async function listSalesAttentionFiles(limit = 100) {
  return db
    .select()
    .from(salesScanFiles)
    .where(inArray(salesScanFiles.status, ["needs_attention", "failed"]))
    .orderBy(desc(salesScanFiles.created_at))
    .limit(limit);
}

/** Imported invoices carrying a flag, which is a different list from the above. */
export async function listSalesAttentionInvoices(limit = 100) {
  return db
    .select()
    .from(salesInvoices)
    .where(eq(salesInvoices.needs_attention, true))
    .orderBy(desc(salesInvoices.created_at))
    .limit(limit);
}
