// Read-only schema check: does live DB already have E-002 columns/tables?
import * as fs from "node:fs";
import * as path from "node:path";
import postgres from "postgres";

const ENV_FILE =
  process.env.NBFC_ENV_FILE ||
  path.resolve(process.cwd(), "../../../keys/sandbox.env");
if (fs.existsSync(ENV_FILE)) {
  const raw = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  const col = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='nbfc' AND column_name='activated_at';
  `;
  const tbl = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name='nbfc_portal_credentials';
  `;
  console.log(JSON.stringify({
    nbfc_activated_at_present: col.length > 0,
    nbfc_portal_credentials_present: tbl.length > 0,
  }));
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
