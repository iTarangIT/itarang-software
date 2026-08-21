/**
 * Deletes the non-Indian leads the scraper saved before the geo gate existed.
 *
 * Dry-run by default — it writes the backup and prints the plan, and only
 * touches the database when passed --apply.
 *
 *   node --import tsx scripts/_delete-foreign-leads.ts          # plan + backup
 *   node --import tsx scripts/_delete-foreign-leads.ts --apply  # execute
 *
 * Targets are chosen in JS by the same detectForeignCountry() the pipeline now
 * uses, then deleted BY EXPLICIT ID. The predicate is never re-expressed as
 * SQL, so there is no way for the two to disagree about what gets removed.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { detectForeignCountry } from "@/lib/scraper/geo";

const APPLY = process.argv.includes("--apply");
const URL = process.env.SURVEY_DATABASE_URL!;
const sql = postgres(URL, { ssl: { rejectUnauthorized: false }, max: 3, idle_timeout: 20 });

const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

async function main() {
  // ---- 1. Pick targets in scraped_dealer_leads
  const scraped = await sql`
    SELECT * FROM scraped_dealer_leads`;
  const foreign = scraped.filter((r) =>
    detectForeignCountry({ address: r.raw_data?.address ?? null }),
  );
  console.log(`scraped_dealer_leads: ${scraped.length} rows, ${foreign.length} foreign`);

  // ---- 2. Map them to dealer_leads, guarded on NAME as well as phone.
  // dealer_leads.phone is UNIQUE and these numbers were fabricated by
  // stamping +91 on foreign ones, so a collision with a genuine Indian mobile
  // is conceivable. Requiring the name to match too means a collision is
  // skipped and reported rather than silently deleting someone's real lead.
  const namesByPhone = new Map<string, Set<string>>();
  for (const r of foreign) {
    if (!r.phone) continue;
    const ten = r.phone.replace(/^\+91/, "");
    if (!namesByPhone.has(ten)) namesByPhone.set(ten, new Set());
    namesByPhone.get(ten)!.add(norm(r.dealer_name));
  }
  const phones = [...namesByPhone.keys()];

  const candidates = phones.length
    ? await sql`SELECT * FROM dealer_leads WHERE phone = ANY(${phones})`
    : [];

  const toDelete: any[] = [];
  const skipped: any[] = [];
  for (const row of candidates) {
    const names = namesByPhone.get(row.phone!);
    if (names?.has(norm(row.dealer_name))) toDelete.push(row);
    else skipped.push(row);
  }
  console.log(`dealer_leads: ${candidates.length} phone matches, ${toDelete.length} confirmed, ${skipped.length} skipped on name mismatch`);
  for (const s of skipped) {
    console.log(`  SKIP ${s.id} ${s.phone} "${s.dealer_name}" — name does not match the foreign lead`);
  }

  // ---- 3. Refuse to run if anything references the dealer_leads rows.
  const ids = toDelete.map((r) => r.id);
  if (ids.length) {
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name IN ('lead_id','linked_lead_id')`;
    const deps: string[] = [];
    for (const { table_name, column_name } of cols) {
      try {
        const r = await sql.unsafe(
          `SELECT count(*)::int n FROM public."${table_name}" WHERE "${column_name}" = ANY($1)`,
          [ids],
        );
        if (r[0].n > 0) deps.push(`${table_name}.${column_name}=${r[0].n}`);
      } catch {
        /* table without the column shape we assumed — ignore */
      }
    }
    if (deps.length) {
      console.error(`\nABORT: these leads are referenced elsewhere: ${deps.join(", ")}`);
      console.error("Delete or repoint those rows first.");
      process.exitCode = 1;
      return;
    }
    console.log("no dependent rows reference the targeted dealer_leads ids");
  }

  // ---- 4. Backup BEFORE touching anything.
  const dir = path.join(process.cwd(), "reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `foreign-leads-deleted-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        deleted_at: new Date().toISOString(),
        database: URL.replace(/:[^:@]+@/, ":***@"),
        reason:
          "Scraper had no country scoping; Apify/Places returned non-Indian businesses. Restore by re-inserting these rows.",
        scraped_dealer_leads: foreign,
        dealer_leads: toDelete,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nbackup written: ${file}`);

  const byCountry: Record<string, number> = {};
  for (const r of foreign) {
    const c = detectForeignCountry({ address: r.raw_data?.address ?? null })!;
    byCountry[c] = (byCountry[c] ?? 0) + 1;
  }
  console.log("plan:", JSON.stringify(byCountry));
  console.log(`plan: DELETE ${foreign.length} scraped_dealer_leads, ${ids.length} dealer_leads`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply to execute.");
    return;
  }

  // ---- 5. Delete, both tables in one transaction.
  const scrapedIds = foreign.map((r) => r.id);
  const result = await sql.begin(async (tx) => {
    const dl = ids.length
      ? await tx`DELETE FROM dealer_leads WHERE id = ANY(${ids}) RETURNING id`
      : [];
    const sdl = scrapedIds.length
      ? await tx`DELETE FROM scraped_dealer_leads WHERE id = ANY(${scrapedIds}) RETURNING id`
      : [];
    return { dl: dl.length, sdl: sdl.length };
  });
  console.log(`\nDELETED ${result.sdl} scraped_dealer_leads, ${result.dl} dealer_leads`);

  // ---- 6. Verify on a fresh read.
  const after = await sql`SELECT raw_data->>'address' AS address FROM scraped_dealer_leads`;
  const left = after.filter((r) => detectForeignCountry({ address: r.address }));
  const leftPromoted = phones.length
    ? await sql`SELECT id FROM dealer_leads WHERE id = ANY(${ids})`
    : [];
  console.log(`verify: ${left.length} foreign scraped leads remain (expected 0)`);
  console.log(`verify: ${leftPromoted.length} targeted dealer_leads rows remain (expected 0)`);
  if (left.length || leftPromoted.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
