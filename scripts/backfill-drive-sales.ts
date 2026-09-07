/**
 * E-280 — backfill sales invoices from Google Drive.
 *
 * The ticker imports 25 files every 6 hours, which is right for the steady
 * state (~15-25 new invoices a month) and wrong for the initial load: the live
 * folder holds ~135 sale PDFs going back to November 2025, so the ticker would
 * take a day and a half to catch up. This runs the same pipeline with a large
 * budget, outside any HTTP timeout.
 *
 * DRY RUN BY DEFAULT, and that default matters. The Drive tree holds BOTH eras:
 * invoices Zoho generated (already rows in `zoho_invoices`) and Vyapar ones
 * that exist nowhere else. The whole backfill rests on the invoice-number dedup
 * recognising the former, so read the report before committing.
 *
 * WHAT TO LOOK FOR — and it is NOT "everything old is a duplicate".
 * `zoho_invoices` turned out to have real holes: it begins on 2025-12-26, holds
 * no ITD/202526 series at all, and jumps straight from ITG/202526/5 to /7. So a
 * Zoho-era file importing as NEW is usually a genuine invoice that was never
 * recorded, and recovering it is half the point of this backfill.
 *
 * The signal to check is the FLAGGED list at the end. A row flagged "Possible
 * duplicate of …" matched an existing invoice on entity, date, amount AND
 * customer while carrying a different number — which usually means a digit was
 * misread, and committing it would count that invoice twice.
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-drive-sales.ts --register <driveUrlOrId>
 *   node --import tsx --env-file=.env.local scripts/backfill-drive-sales.ts            # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-drive-sales.ts --commit
 *
 * Options:
 *   --register <url|id>  create the sales folder row, then exit
 *   --commit             actually write (default is a rehearsal)
 *   --max <n>            file cap (default 500)
 *   --minutes <n>        time budget (default 40)
 *
 * A dry run still costs one download and one vision call per file. It is a
 * rehearsal, not a cheap preview.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesInvoiceFolders } from "@/lib/db/schema";
import { getFolderName, parseDriveFolderId } from "@/lib/google/drive";
import { runSalesScan, type SalesProposal } from "@/lib/sales/driveSalesScan";

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");

function opt(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

const MAX_FILES = Number(opt("--max") ?? 500);
const BUDGET_MS = Number(opt("--minutes") ?? 40) * 60_000;

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

async function register(input: string) {
  const folderId = parseDriveFolderId(input);
  if (!folderId) {
    console.error(`Could not read a Drive folder id out of: ${input}`);
    process.exit(1);
  }
  const [existing] = await db
    .select()
    .from(salesInvoiceFolders)
    .where(eq(salesInvoiceFolders.drive_folder_id, folderId))
    .limit(1);
  if (existing) {
    console.log(`Already registered: ${existing.label ?? folderId} (${folderId})`);
    return;
  }
  const label = await getFolderName(folderId).catch(() => null);
  const [row] = await db
    .insert(salesInvoiceFolders)
    .values({ drive_folder_id: folderId, label })
    .returning();
  console.log(`Registered "${row.label ?? folderId}" (${folderId})`);
  console.log(`  include: ${row.include_names}   exclude: ${row.exclude_names}`);
}

async function main() {
  const reg = opt("--register");
  if (reg) {
    await register(reg);
    process.exit(0);
  }

  const folders = await db
    .select()
    .from(salesInvoiceFolders)
    .where(eq(salesInvoiceFolders.is_active, true));
  if (folders.length === 0) {
    console.error(
      "No active sales folder is configured. Register one first:\n" +
        "  node --import tsx --env-file=.env.local scripts/backfill-drive-sales.ts --register <driveUrlOrId>",
    );
    process.exit(1);
  }
  console.log(
    `Folders: ${folders.map((f) => `${f.label ?? f.drive_folder_id} [in:${f.include_names} out:${f.exclude_names}]`).join(", ")}`,
  );
  console.log(
    COMMIT
      ? "MODE: COMMIT — rows will be written.\n"
      : "MODE: dry run — nothing will be written. Add --commit when the report looks right.\n",
  );

  // Grouped by the month folder, because that is the unit the report is read in:
  // a Zoho-era month that is not entirely `duplicate` is the failure signal.
  const byFolder = new Map<
    string,
    { imported: number; duplicate: number; attention: number; other: number; total: number }
  >();
  const flagged: Array<{ path: string; name: string; why: string }> = [];
  const problems: Array<{ path: string; name: string; status: string; why: string }> = [];

  const onFile = ({
    file,
    outcome,
    proposal,
  }: {
    file: { name: string; folderPath: string };
    outcome: { status: string; reason: string | null };
    proposal: SalesProposal | null;
  }) => {
    const key = file.folderPath || "(root)";
    const agg =
      byFolder.get(key) ??
      { imported: 0, duplicate: 0, attention: 0, other: 0, total: 0 };

    if (outcome.status === "imported") {
      agg.imported += 1;
      agg.total += proposal?.total ?? 0;
      if (proposal?.attention.length) {
        agg.attention += 1;
        flagged.push({
          path: key,
          name: file.name,
          why: proposal.attention.join(" "),
        });
      }
      console.log(
        `  + ${outcome.status.padEnd(9)} ${file.name}\n` +
          `      ${proposal?.invoice_number ?? "(no number)"}  ${proposal?.invoice_date ?? "(no date)"}  ` +
          `${proposal?.org_label ?? "(no entity)"}  ₹${INR.format(proposal?.total ?? 0)}  ${proposal?.customer_name ?? ""}`,
      );
    } else if (outcome.status === "duplicate") {
      agg.duplicate += 1;
      console.log(`  = duplicate ${file.name} — ${outcome.reason ?? ""}`);
    } else {
      agg.other += 1;
      problems.push({
        path: key,
        name: file.name,
        status: outcome.status,
        why: outcome.reason ?? "",
      });
      console.log(`  ! ${outcome.status.padEnd(9)} ${file.name} — ${outcome.reason ?? ""}`);
    }
    byFolder.set(key, agg);
  };

  const t0 = Date.now();
  const summary = await runSalesScan({
    dryRun: !COMMIT,
    maxFiles: MAX_FILES,
    timeBudgetMs: BUDGET_MS,
    onFile: onFile as never,
  });

  console.log("\n================ BY MONTH FOLDER ================");
  let grand = 0;
  for (const [path, a] of [...byFolder].sort()) {
    grand += a.total;
    console.log(
      `${path}\n    new ${a.imported}  duplicate ${a.duplicate}  problems ${a.other}` +
        `  flagged ${a.attention}  value ₹${INR.format(a.total)}`,
    );
  }

  console.log("\n================ SUMMARY ================");
  console.log(`status            : ${summary.status}${summary.skipped_reason ? " — " + summary.skipped_reason : ""}`);
  console.log(`files seen        : ${summary.files_seen}`);
  console.log(`files processed   : ${summary.files_new}   (the rest were already done)`);
  console.log(`would import      : ${summary.imported}`);
  console.log(`already recorded  : ${summary.skipped_duplicate}`);
  console.log(`needs attention   : ${summary.needs_attention}`);
  console.log(`unsupported       : ${summary.unsupported}`);
  console.log(`failed            : ${summary.failed}`);
  console.log(`new revenue value : ₹${INR.format(grand)}`);
  console.log(`elapsed           : ${Math.round((Date.now() - t0) / 1000)}s`);

  if (flagged.length) {
    console.log(`\n---- ${flagged.length} row(s) would import WITH A FLAG ----`);
    for (const f of flagged) console.log(`  ${f.path} :: ${f.name}\n      ${f.why}`);
  }
  if (problems.length) {
    console.log(`\n---- ${problems.length} file(s) would NOT become a row ----`);
    for (const p of problems) console.log(`  [${p.status}] ${p.path} :: ${p.name}\n      ${p.why}`);
  }

  if (!COMMIT) {
    console.log(
      "\nNothing was written. Before adding --commit, read the FLAGGED list above:\n" +
        "each of those matched an existing invoice on entity, date, amount AND customer\n" +
        "but carries a different number, which usually means a digit was misread and\n" +
        "committing it would count that invoice twice.\n" +
        "A Zoho-era file importing as NEW is expected, not a bug — zoho_invoices has\n" +
        "real gaps (no ITD/202526 series at all, and it skips ITG/202526/6).",
    );
  } else {
    const [row] = await db
      .select({
        n: sql<string>`COUNT(*)`,
        total: sql<string>`COALESCE(SUM(total), 0)`,
      })
      .from((await import("@/lib/db/schema")).salesInvoices);
    console.log(
      `\nsales_invoices now holds ${row?.n} row(s), total ₹${INR.format(Number(row?.total ?? 0))}.`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
