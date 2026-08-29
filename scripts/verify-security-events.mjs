// verify-security-events.mjs — print the most recent rows the Live-Attack detector
// wrote to `security_events`, straight from the DB, independent of the UI. Handy for
// confirming a run of scripts/attack-sandbox.sh actually landed.
//
//   node scripts/verify-security-events.mjs           # last 40 rows
//   node scripts/verify-security-events.mjs 100        # last 100 rows
//
// Reads DATABASE_URL from .env.local (same connection the app uses). NOTE: this shows
// what's in the DB your LOCAL app points at. The deployed sandbox writes to whichever
// DB ITS env points at — if you attacked sandbox.itarang.com and see nothing here,
// the sandbox may be writing to a different database than your .env.local. In that
// case just use the Live Attacks page on the sandbox instead.

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const limit = Number(process.argv[2]) || 40;

const envPath = path.resolve(process.cwd(), ".env.local");
if (!fs.existsSync(envPath)) {
  console.error("No .env.local found in", process.cwd());
  process.exit(1);
}
const env = fs.readFileSync(envPath, "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) {
  console.error("DATABASE_URL not found in .env.local");
  process.exit(1);
}
const url = m[1].trim().replace(/^["']|["']$/g, "");

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows } = await c.query(
  `select occurred_at, event_type, severity, action, matched_rule, method, path, status
     from security_events
    order by occurred_at desc
    limit $1`,
  [limit],
);

if (rows.length === 0) {
  console.log("security_events is empty for this DB — nothing recorded yet.");
} else {
  console.log(`last ${rows.length} security_events (newest first):\n`);
  for (const r of rows) {
    const ts = r.occurred_at?.toISOString?.() ?? String(r.occurred_at);
    console.log(
      [
        ts,
        String(r.severity).padEnd(8),
        String(r.action).padEnd(7),
        String(r.event_type).padEnd(20),
        String(r.matched_rule).padEnd(22),
        `${r.method} ${r.path}`,
      ].join("  "),
    );
  }

  // Quick tally by type over the returned window.
  const byType = {};
  for (const r of rows) byType[r.event_type] = (byType[r.event_type] || 0) + 1;
  console.log("\nby type:", byType);
}

await c.end();
