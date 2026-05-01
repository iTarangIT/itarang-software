// Apply E-002 schema additions via direct SQL (drizzle-kit hangs non-TTY).
// Run: node scripts/apply-e002-schema.mjs
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

const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  prepare: false,
  ssl: "require",
});

const stmts = [
  `ALTER TABLE nbfc ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP WITH TIME ZONE;`,
  `CREATE TABLE IF NOT EXISTS nbfc_portal_credentials (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     nbfc_id INTEGER NOT NULL REFERENCES nbfc(id),
     supabase_user_id UUID NOT NULL,
     email_dispatched_at TIMESTAMP WITH TIME ZONE,
     dispatch_status VARCHAR(32) NOT NULL,
     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
   );`,
  `CREATE INDEX IF NOT EXISTS nbfc_portal_credentials_nbfc_id_idx
     ON nbfc_portal_credentials(nbfc_id);`,
  `CREATE INDEX IF NOT EXISTS nbfc_portal_credentials_dispatch_status_idx
     ON nbfc_portal_credentials(dispatch_status);`,
];

try {
  for (const s of stmts) {
    console.log(s.split("\n")[0].slice(0, 80));
    await sql.unsafe(s);
  }
  console.log("OK — E-002 schema applied");
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
