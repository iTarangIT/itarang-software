/**
 * Apply E-281 (buyback vendor counter-offer).
 *
 * NOT scripts/apply-migration.mjs: that file imports `pg`, which is not a
 * dependency of this project and never has been — the repo runs postgres.js.
 * Same shape as the other _apply-e*.mjs one-offs.
 *
 * Usage:
 *   node --env-file=.env.local      scripts/_apply-e281.mjs        # db-1 (sandbox)
 *   node --env-file=.env.production scripts/_apply-e281.mjs        # db-2 (prod)
 *   ... --verify-only                                              # no writes
 *
 * The file is additive and idempotent, so RE-RUNNING IT is the idempotency check.
 * Do not use the "apply twice inside a transaction then roll back" trick here:
 * postgres.js unsafe() DDL escapes the rollback and the script would print
 * "ROLLED BACK" while the columns stayed live.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const FILE = "drizzle/E-281_buyback_vendor_counter.sql";
const verifyOnly = process.argv.includes("--verify-only");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set — pass --env-file=.env.local or .env.production");
  process.exit(1);
}

const sql = postgres(url, { ssl: { rejectUnauthorized: false }, max: 1, idle_timeout: 5 });

const EXPECTED = [
  ["vendor_thread_lines", "revised_ask_price"],
  ["vendor_threads", "awaiting_party"],
  ["negotiation_rounds", "party"],
];

try {
  console.log(`> target host: ${new URL(url).host}`);

  if (!verifyOnly) {
    console.log(`> applying ${FILE}`);
    // BEGIN/COMMIT in the simple query: one round trip, all-or-nothing.
    await sql.unsafe(`BEGIN;\n${readFileSync(FILE, "utf8")}\nCOMMIT;`).simple();
    console.log("> ok — applied");
  }

  // ---- verification, by column, then by the one thing the backfill promises ---
  let bad = 0;
  for (const [table, column] of EXPECTED) {
    const [row] = await sql`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    `;
    if (!row) {
      console.error(`  MISSING  ${table}.${column}`);
      bad++;
    } else {
      console.log(
        `  ok       ${table}.${column} — ${row.data_type}, nullable=${row.is_nullable}, default=${row.column_default ?? "none"}`,
      );
    }
  }

  // The backfill's whole point: a thread already carrying a vendor counter must
  // read as OUR move, or the new Counter button stays hidden on exactly the
  // deals that motivated the migration.
  const [b] = await sql`
    SELECT
      count(*) FILTER (WHERE status = 'COUNTERED')                                AS countered,
      count(*) FILTER (WHERE status = 'COUNTERED' AND awaiting_party = 'ITARANG')  AS ours,
      count(*) FILTER (WHERE status <> 'COUNTERED' AND awaiting_party <> 'VENDOR') AS stray
    FROM vendor_threads
  `;
  console.log(
    `  backfill  COUNTERED=${b.countered}, of which awaiting ITARANG=${b.ours}; non-countered not-VENDOR=${b.stray}`,
  );
  if (b.countered !== b.ours) {
    console.error("  FAIL: a COUNTERED thread is not awaiting iTarang");
    bad++;
  }
  if (Number(b.stray) !== 0) {
    console.error("  FAIL: a non-countered thread is not awaiting the vendor");
    bad++;
  }

  console.log(bad === 0 ? "> VERIFIED" : `> ${bad} PROBLEM(S)`);
  if (bad) process.exitCode = 1;
} catch (e) {
  console.error("> failed:", e.message);
  if (e.position) console.error("  position:", e.position);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
