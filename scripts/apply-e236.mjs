/**
 * Applies drizzle/E-236_lead_disposition_taxonomy.sql and verifies.
 *
 *   node --env-file=.env.local scripts/apply-e236.mjs
 *   node --env-file=.env.local scripts/apply-e236.mjs --check
 *
 * ADDITIVE ONLY — five nullable columns on dealer_leads, five on
 * lead_touchpoints, two partial indexes. Nothing is dropped or narrowed.
 *
 * WHAT THIS CHECKS BEYOND "the columns exist". Both partial indexes are
 * verified to actually BE partial. A non-partial index here would still verify
 * as present and would still be used, so this is a hygiene check rather than a
 * correctness one — but `dealer_leads` is ~97% never-dispositioned rows, and an
 * index that carries them all is most of a table scan wearing an index's name.
 *
 * The filter degrades safely without this file: src/lib/leads/leadListQuery.ts
 * emits the disposition predicates only when the filter is set, so an
 * unapplied E-236 shows up as an empty filter dropdown, never as a
 * "column does not exist" error on the leads list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const FILE = join(
  process.cwd(),
  "drizzle",
  "E-236_lead_disposition_taxonomy.sql",
);
const CHECK_ONLY = process.argv.includes("--check");

const EXPECTED_COLUMNS = {
  dealer_leads: [
    "last_disposition",
    "last_disposition_bucket",
    "last_connect_status",
    "last_disposition_at",
    "last_disposition_source",
  ],
  lead_touchpoints: [
    "disposition",
    "disposition_bucket",
    "connect_status",
    "external_stage",
    "external_tag",
  ],
};

// indexname → the predicate its definition must contain.
const EXPECTED_INDEXES = {
  dealer_leads_disposition_idx: "last_disposition IS NOT NULL",
  lead_touchpoints_disposition_idx: "disposition IS NOT NULL",
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (run with --env-file=.env.local)");
    process.exit(2);
  }

  const host = new URL(url).host;
  console.log(`host: ${host}`);
  console.log(`file: ${FILE}`);
  console.log(CHECK_ONLY ? "mode: --check (no writes)\n" : "mode: apply\n");

  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

  try {
    for (const table of Object.keys(EXPECTED_COLUMNS)) {
      const [{ r }] = await sql`SELECT to_regclass(${"public." + table}) AS r`;
      // Not fatal: the migration itself skips a missing table with a NOTICE, so
      // the script must reach the same verdict rather than a harder one.
      console.log(`· ${table}: ${r ? "present" : "ABSENT — block will be skipped"}`);
    }

    if (!CHECK_ONLY) {
      await sql.unsafe(readFileSync(FILE, "utf8"));
      console.log("\n· applied without error");
    }

    const problems = [];
    console.log("");

    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const [{ r }] = await sql`SELECT to_regclass(${"public." + table}) AS r`;
      if (!r) {
        console.log(`  ${table}: skipped (table absent)`);
        continue;
      }
      const rows = await sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table}
      `;
      const present = new Set(rows.map((c) => c.column_name));
      for (const col of columns) {
        const ok = present.has(col);
        if (!ok) problems.push(`missing column: ${table}.${col}`);
        console.log(`  ${`${table}.${col}`.padEnd(44)} ${ok ? "✓" : "MISSING"}`);
      }
    }

    const idx = await sql`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = ANY(${Object.keys(EXPECTED_INDEXES)})
    `;
    const byName = new Map(idx.map((i) => [i.indexname, i.indexdef]));

    console.log("");
    for (const [name, predicate] of Object.entries(EXPECTED_INDEXES)) {
      const def = byName.get(name);
      if (!def) {
        // Only a problem if its table exists — otherwise the block was skipped.
        const table = name.startsWith("dealer_leads")
          ? "dealer_leads"
          : "lead_touchpoints";
        const [{ r }] = await sql`SELECT to_regclass(${"public." + table}) AS r`;
        if (r) problems.push(`missing index: ${name}`);
        console.log(`  ${name.padEnd(44)} ${r ? "MISSING" : "skipped"}`);
        continue;
      }
      if (!def.includes(predicate)) {
        problems.push(
          `${name} exists but is not partial — expected "WHERE ${predicate}", got: ${def}`,
        );
        console.log(`  ${name.padEnd(44)} NOT PARTIAL ✗`);
        continue;
      }
      console.log(`  ${name.padEnd(44)} ✓`);
    }

    // How much of the backfill is still to do. Reported rather than asserted:
    // zero is the correct answer on a database that has never received a
    // NeoDove webhook, and a non-zero one is the cue to run
    // scripts/backfill-dispositions.mjs.
    const [{ r: hasLeads }] = await sql`SELECT to_regclass('public.dealer_leads') AS r`;
    if (hasLeads && !problems.length) {
      const [{ n }] = await sql`
        SELECT COUNT(*)::int AS n FROM dealer_leads WHERE last_disposition IS NOT NULL
      `;
      console.log(`\n  leads carrying a disposition: ${n}`);
      if (n === 0) {
        console.log(
          "  → run `npm run backfill:dispositions` to populate from stored webhooks",
        );
      }
    }

    if (problems.length) throw new Error(`\n  - ${problems.join("\n  - ")}`);

    console.log(
      `\nE-236 ${CHECK_ONLY ? "verified" : "applied and verified"} on ${host}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message ?? error);
  process.exit(1);
});
