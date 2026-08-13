/**
 * Applies drizzle/E-231_notification_access.sql and verifies the result.
 *
 * There is no migration runner in this project (see drizzle/MIGRATION_CHECKLIST.md),
 * and an unapplied file surfaces as a runtime `relation "notification_access"
 * does not exist` — which is exactly how E-231 announced itself. This script is
 * the same shape as scripts/apply-e226.mjs: apply, then PROVE the objects exist,
 * so "it ran" and "it worked" are not the same claim.
 *
 *   node --env-file=.env.local scripts/apply-e231.mjs
 *
 * The migration is additive and idempotent, so re-running is a no-op.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const FILE = join(process.cwd(), "drizzle", "E-231_notification_access.sql");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (run with --env-file=.env.local)");
    process.exit(2);
  }

  const host = new URL(url).host;
  console.log(`host: ${host}`);
  console.log(`file: ${FILE}\n`);

  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

  try {
    const before = await sql`SELECT to_regclass('public.notification_access') AS t`;
    const existed = before[0].t !== null;
    console.log(existed ? "· table already present — expecting a no-op" : "· table absent — creating");

    await sql.unsafe(readFileSync(FILE, "utf8"));
    console.log("· applied without error");

    // Prove it, rather than trust the absence of an exception.
    const [{ t }] = await sql`SELECT to_regclass('public.notification_access') AS t`;
    if (!t) throw new Error("table still missing after apply");

    const cols = await sql`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'notification_access'
       ORDER BY ordinal_position
    `;
    const pk = await sql`
      SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'notification_access'::regclass AND i.indisprimary
       ORDER BY a.attnum
    `;
    const checks = await sql`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'notification_access'::regclass AND contype = 'c'
    `;
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM notification_access`;

    console.log("\nVERIFIED");
    console.log(`  columns     ${cols.map((c) => `${c.column_name}:${c.data_type}`).join(", ")}`);
    console.log(`  primary key (${pk.map((p) => p.attname).join(", ")})`);
    console.log(`  checks      ${checks.map((c) => c.conname).join(", ") || "(none)"}`);
    console.log(`  rows        ${n}  ${n === 0 ? "(ships empty, as designed)" : ""}`);

    const expected = [
      "dashboard",
      "notification_type",
      "enabled",
      "updated_by",
      "updated_at",
    ];
    const missing = expected.filter((c) => !cols.some((x) => x.column_name === c));
    if (missing.length) throw new Error(`missing column(s): ${missing.join(", ")}`);
    if (pk.length !== 2) throw new Error(`expected a 2-column primary key, got ${pk.length}`);

    console.log(`\nE-231 applied and verified on ${host}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message ?? error);
  process.exit(1);
});
