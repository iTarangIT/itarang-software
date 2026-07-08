// Applies drizzle/E-183_emi_tracker_standalone.sql to whatever DATABASE_URL
// points at in .env.local. Idempotent — safe to re-run. Run with:
//   node scripts/apply-e183.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const ddl = readFileSync("drizzle/E-183_emi_tracker_standalone.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  await sql.unsafe(ddl);
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'nbfc_emi_tracker_overrides' AND column_name = 'is_standalone'`;
  const [{ nullable }] = await sql`
    SELECT is_nullable AS nullable FROM information_schema.columns
    WHERE table_name = 'nbfc_emi_tracker_overrides' AND column_name = 'loan_application_id'`;
  console.log(
    n > 0 && nullable === "YES"
      ? "OK — is_standalone exists and loan_application_id is nullable."
      : `FAILED — is_standalone=${n}, loan_application_id nullable=${nullable}.`,
  );
} finally {
  await sql.end();
}
