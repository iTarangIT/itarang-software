/**
 * Dry-run a migration file: execute it inside a transaction, then ROLLBACK.
 *
 * Run: node --import tsx --env-file=.env.local scripts/_dryrun-migration.ts drizzle/E-216_...sql
 *
 * DDL is transactional in Postgres, so this proves the file applies cleanly
 * without leaving anything behind. Exists because E-216 shipped an index on
 * COALESCE(expense_date, approved_at::date) that Postgres rejects — a
 * volatility error no amount of reading the file would have caught, and which
 * only showed up when a human pasted it into pgAdmin.
 *
 * Points at whatever DATABASE_URL is set to. Verify that is a dev DB first.
 */
import fs from "node:fs";
import postgres from "postgres";

const FILE = process.argv[2];

async function main() {
  if (!FILE) {
    console.error("usage: _dryrun-migration.ts <path-to.sql>");
    process.exit(1);
  }
  const text = fs.readFileSync(FILE, "utf8");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  console.log(`file : ${FILE}`);
  console.log(`host : ${new URL(url).host}`);
  console.log("mode : BEGIN … ROLLBACK (nothing is kept)\n");

  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      console.log("APPLIED CLEANLY — every statement succeeded.");
      // Force the rollback: the whole point is to leave no trace.
      throw new RollbackSignal();
    });
  } catch (err) {
    if (err instanceof RollbackSignal || (err as Error)?.name === "RollbackSignal") {
      console.log("rolled back — database unchanged.");
      await sql.end();
      process.exit(0);
    }
    const e = err as { message?: string; code?: string; position?: string };
    console.error("\nFAILED");
    console.error("  code     :", e.code);
    console.error("  message  :", e.message);
    if (e.position) {
      const upto = text.slice(0, Number(e.position));
      console.error("  at line  :", upto.split("\n").length);
    }
    await sql.end();
    process.exit(2);
  }
}

class RollbackSignal extends Error {
  constructor() {
    super("rollback");
    this.name = "RollbackSignal";
  }
}

main();
