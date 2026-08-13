/**
 * Applies drizzle/E-235_dealer_leads_list_indexes.sql and verifies.
 *
 *   node --env-file=.env.local scripts/apply-e235.mjs
 *   node --env-file=.env.local scripts/apply-e235.mjs --check
 *
 * INDEX-ONLY. No columns, no data, nothing destructive. The merged /leads screen
 * is CORRECT without this migration — it is only slower — so a failure here
 * never breaks a page, unlike E-224.
 *
 * The check worth more than "the indexes exist" is the PARTIAL PREDICATE.
 * E-112 already ships `dealer_leads_is_active_idx ... WHERE is_active = true`,
 * and that index cannot serve this list: the query filters
 * `is_active IS NOT FALSE`, which also admits NULL, and Postgres will not prove
 * `IS NOT FALSE ⊆ = true`. An index created here with the wrong predicate would
 * verify as "present" and still never be used — the exact trap this migration
 * exists to escape — so each partial index is checked for `IS NOT FALSE`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const FILE = join(
  process.cwd(),
  "drizzle",
  "E-235_dealer_leads_list_indexes.sql",
);
const CHECK_ONLY = process.argv.includes("--check");

// indexname → predicate that must appear in indexdef (null = no partial clause)
const EXPECTED = {
  dealer_leads_active_touch_idx: "IS NOT FALSE",
  dealer_leads_active_owner_idx: "IS NOT FALSE",
  dealer_leads_active_created_idx: "IS NOT FALSE",
  dealer_leads_asm_idx: "asm_id IS NOT NULL",
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
    const [{ r }] = await sql`SELECT to_regclass('public.dealer_leads') AS r`;
    if (!r) throw new Error("dealer_leads does not exist on this database.");

    // CREATE INDEX takes a write lock on the table for its duration. Print the
    // size so an unexpectedly large table is visible before the lock, not after.
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM dealer_leads`;
    const [{ active }] = await sql`
      SELECT COUNT(*)::int AS active FROM dealer_leads WHERE is_active IS NOT FALSE
    `;
    console.log(`· dealer_leads rows: ${n} (${active} active)`);

    const before = await sql`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'dealer_leads'
    `;
    const beforeNames = new Set(before.map((i) => i.indexname));
    for (const name of Object.keys(EXPECTED)) {
      console.log(`· ${name} ${beforeNames.has(name) ? "already present" : "absent — creating"}`);
    }

    if (!CHECK_ONLY) {
      await sql.unsafe(readFileSync(FILE, "utf8"));
      console.log("\n· applied without error");
    }

    const problems = [];
    const rows = await sql`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'dealer_leads'
    `;
    const byName = new Map(rows.map((i) => [i.indexname, i.indexdef]));

    console.log("");
    for (const [name, predicate] of Object.entries(EXPECTED)) {
      const def = byName.get(name);
      if (!def) {
        problems.push(`missing index: ${name}`);
        console.log(`  ${name.padEnd(34)} MISSING`);
        continue;
      }
      if (!def.includes(predicate)) {
        problems.push(
          `${name} exists but its predicate is wrong — expected "${predicate}", got: ${def}`,
        );
        console.log(`  ${name.padEnd(34)} WRONG PREDICATE ✗`);
        continue;
      }
      console.log(`  ${name.padEnd(34)} ✓`);
    }

    // Informational: the E-112 index this migration works around. Not a failure
    // — it serves other queries — but its predicate explains why E-235 exists.
    const legacy = byName.get("dealer_leads_is_active_idx");
    if (legacy) {
      console.log(
        `\n  note: E-112's dealer_leads_is_active_idx is still present and still` +
          `\n        "WHERE is_active = true", so it cannot serve the merged list.` +
          `\n        That is expected — E-235's indexes are the ones that can.`,
      );
    }

    if (problems.length) throw new Error(`\n  - ${problems.join("\n  - ")}`);

    console.log(
      `\nE-235 ${CHECK_ONLY ? "verified" : "applied and verified"} on ${host}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message ?? error);
  process.exit(1);
});
