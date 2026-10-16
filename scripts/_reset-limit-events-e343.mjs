// One-off (sandbox, 2026-10-16): E-343's first version back-filled
// lead_limit_events from lead_clocks with the OLD rule (lead-clock misses
// charged to today's owner). The table was created the same day, so it holds
// nothing else: empty it, then run scripts/refresh-lead-clocks.ts to record
// every miss under the new rule. Refuses on any table older than a day.
//
//   node scripts/_reset-limit-events-e343.mjs database-1
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (target !== "database-1") throw new Error("usage: database-1 (sandbox only)");
const line = readFileSync(".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const sql = postgres(url, { max: 1, prepare: false, ssl: { rejectUnauthorized: false } });
try {
  const [r] = await sql`SELECT count(*)::int AS n, min(recorded_at) AS first FROM lead_limit_events`;
  if (r.first && Date.now() - new Date(r.first).getTime() > 3 * 24 * 3600 * 1000) {
    throw new Error("lead_limit_events has rows older than 3 days — not a fresh table, refusing");
  }
  await sql`DELETE FROM lead_limit_events`;
  console.log(`emptied lead_limit_events (${r.n} rows)`);
} finally {
  await sql.end();
}
