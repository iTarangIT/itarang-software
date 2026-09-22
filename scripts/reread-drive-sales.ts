/**
 * Re-read every imported Drive sales invoice from its file, and correct the
 * rows whose figures were invented.
 *
 * WHY
 *   extractSalesInvoice used to send PDFs to the model raw. The Vyapar invoices
 *   are "Microsoft: Print To PDF" output with no text layer, and on those the
 *   model read the large bold text (customer, invoice number) and made up the
 *   rest — amounts, GSTINs, and a date copied from its own prompt (2026-07-02).
 *   ITG/202627/034 is ₹4,35,302 on 08-08-2026; production held ₹4,14,770 on
 *   2026-07-02. ITG/202627/037 is ₹6,24,089; production held ₹96,524.
 *
 *   The extractor now renders pages locally and sends images. But an imported
 *   file is settled — no scan reads it again — so the rows already written
 *   stay wrong until something re-reads them. This is that something.
 *
 *   It re-reads EVERY Drive row, not only the flagged ones: a fabricated
 *   reading with a plausible date raised no flag at all (ITG/202627/040 is
 *   ₹20,475 to P.P AUTOMOBILES; the sandbox held ₹2,40,475 to "HP Automobiles").
 *
 * WHAT IT WRITES (with --commit)
 *   Only rows whose figures changed, via rereadSalesInvoice — number, date,
 *   parties, amounts, entity, model output, attention flags. Payment fields
 *   and status are never touched. Rows that would collide with another invoice
 *   are reported and left alone.
 *
 *   Also re-queues files the scan log settled as a Drive-vs-Drive duplicate
 *   ("already recorded"): that verdict rested on a number read by the old
 *   extractor. Their log row is deleted so the next scan reads them again and
 *   its own dedup decides. Zoho-era duplicates are left settled — their
 *   numbers match their filenames.
 *
 * Dry run by default. A dry run still downloads every file and makes one
 * vision call per row.
 *
 *   node --import tsx --env-file=.env.local      scripts/reread-drive-sales.ts
 *   node --import tsx --env-file=.env.local      scripts/reread-drive-sales.ts --commit
 *   node --import tsx --env-file=.env.production scripts/reread-drive-sales.ts [--commit]
 *
 * Options:
 *   --commit        write (default is a rehearsal)
 *   --id <uuid>     re-read one row only
 */
import { and, eq, isNotNull, notIlike } from "drizzle-orm";

import { db } from "@/lib/db";
import { salesInvoices, salesScanFiles } from "@/lib/db/schema";
import {
  loadZohoNumberKeys,
  rereadSalesInvoice,
  type RereadFields,
  type SalesReread,
} from "@/lib/sales/driveSalesScan";
import { normalizeInvoiceNumber } from "@/lib/sales/normalizeInvoiceNumber";

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const ONLY_ID = argv.includes("--id") ? argv[argv.indexOf("--id") + 1] : null;

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const inr = (v: string | null) => (v == null ? "—" : `₹${INR.format(Number(v))}`);

const SHOWN: (keyof RereadFields)[] = [
  "invoice_number",
  "invoice_date",
  "customer_name",
  "seller_gstin",
  "organization_id",
  "sub_total",
  "tax_total",
  "total",
];

function describe(r: SalesReread): string {
  const lines = [`  ${r.file_name ?? r.id}  (${r.folder_path ?? "?"})`];
  if (r.after) {
    for (const k of SHOWN) {
      const money = k === "sub_total" || k === "tax_total" || k === "total";
      const a = money ? inr(r.before[k]) : (r.before[k] ?? "—");
      const b = money ? inr(r.after[k]) : (r.after[k] ?? "—");
      if (a !== b) lines.push(`      ${k.padEnd(16)} ${a}  →  ${b}`);
    }
    if (r.after.attention_reason) lines.push(`      flags now        ${r.after.attention_reason}`);
  }
  if (r.reason) lines.push(`      ${r.reason}`);
  return lines.join("\n");
}

async function main() {
  console.log(COMMIT ? "COMMIT — rows will be rewritten\n" : "DRY RUN — nothing is written\n");

  const conds = [eq(salesInvoices.source, "drive"), isNotNull(salesInvoices.drive_file_id)];
  if (ONLY_ID) conds.push(eq(salesInvoices.id, ONLY_ID));
  const rows = await db
    .select()
    .from(salesInvoices)
    .where(and(...conds))
    .orderBy(salesInvoices.folder_path, salesInvoices.file_name);

  const zohoKeys = await loadZohoNumberKeys();
  const results: SalesReread[] = [];
  for (const [i, row] of rows.entries()) {
    const r = await rereadSalesInvoice(row, { dryRun: !COMMIT, zohoKeys });
    results.push(r);
    console.log(`[${i + 1}/${rows.length}] ${r.status.padEnd(10)} ${row.file_name}`);
  }

  const by = (s: SalesReread["status"]) => results.filter((r) => r.status === s);
  for (const status of ["changed", "conflict", "unreadable", "failed"] as const) {
    const group = by(status);
    if (group.length === 0) continue;
    console.log(`\n=== ${status.toUpperCase()} (${group.length})`);
    for (const r of group) console.log(describe(r));
  }

  // What the CEO revenue card will move by, per month.
  const sum = (xs: SalesReread[], pick: (r: SalesReread) => RereadFields | null) =>
    xs.reduce((acc, r) => acc + Number(pick(r)?.total ?? 0), 0);
  const changed = by("changed");
  const months = new Map<string, { before: number; after: number }>();
  for (const r of changed) {
    for (const [side, f] of [["before", r.before], ["after", r.after!]] as const) {
      const m = f.invoice_date?.slice(0, 7) ?? "no date";
      const e = months.get(m) ?? { before: 0, after: 0 };
      e[side] += Number(f.total ?? 0);
      months.set(m, e);
    }
  }
  console.log("\n=== REVENUE MOVEMENT (changed rows only, by invoice month)");
  for (const [m, e] of [...months].sort()) {
    console.log(`  ${m}   ₹${INR.format(e.before).padStart(14)}  →  ₹${INR.format(e.after).padStart(14)}`);
  }
  console.log(
    `  total     ₹${INR.format(sum(changed, (r) => r.before)).padStart(14)}  →  ₹${INR.format(
      sum(changed, (r) => r.after),
    ).padStart(14)}`,
  );

  // Not caused by the old extractor and not changed here, but the same question
  // — is this revenue counted twice? — so it belongs on the same report.
  const inZoho = results.filter((r) => {
    const n = r.after?.invoice_number ?? r.before.invoice_number;
    const k = normalizeInvoiceNumber(n);
    return k != null && zohoKeys.has(k);
  });
  if (inZoho.length > 0) {
    console.log(`\n=== ALSO IN ZOHO — possibly counted twice, left as is (${inZoho.length})`);
    for (const r of inZoho) {
      console.log(`  ${r.file_name}  ${r.after?.invoice_number ?? r.before.invoice_number}  ${inr(r.before.total)}`);
    }
  }

  // Drive-vs-Drive duplicates whose verdict rested on an old reading.
  const requeue = ONLY_ID
    ? []
    : await db
        .select({
          id: salesScanFiles.id,
          name: salesScanFiles.drive_file_name,
          reason: salesScanFiles.reason,
        })
        .from(salesScanFiles)
        .where(
          and(
            eq(salesScanFiles.status, "duplicate"),
            notIlike(salesScanFiles.reason, "%synced from Zoho%"),
          ),
        );
  if (requeue.length > 0) {
    console.log(`\n=== RE-QUEUED FOR THE NEXT SCAN (${requeue.length})`);
    for (const f of requeue) console.log(`  ${f.name} — was: ${f.reason}`);
    if (COMMIT) {
      for (const f of requeue) {
        await db.delete(salesScanFiles).where(eq(salesScanFiles.id, f.id));
      }
    }
  }

  console.log(
    `\n${rows.length} rows: ${by("changed").length} changed, ${by("unchanged").length} unchanged, ` +
      `${by("conflict").length} conflict, ${by("unreadable").length} unreadable, ${by("failed").length} failed` +
      (COMMIT ? "" : "  (dry run — re-run with --commit to write)"),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
