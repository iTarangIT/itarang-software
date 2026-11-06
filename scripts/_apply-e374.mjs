// One-off: apply E-374 (dialer_campaign_line_health gains the carrier pause's
// cursor, refund count and probe state — Priya KPI tracker task 10) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e374.mjs database-1
//   node scripts/_apply-e374.mjs database-2
//   ENV_FILE=../itarang-software/.env.local node scripts/_apply-e374.mjs database-1   (from a worktree)
//
// Additive: 13 columns + a partial index on an E-360 table, not mirrored in schema.ts. Reads that host's URL from
// .env.local (commented or not), never prints it. Applies the file twice (the second
// pass must be a no-op), then re-checks the tables and their columns on a FRESH
// connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const file = readFileSync("drizzle/E-374_carrier_pause_probe.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const want = [
  "block_kind", "sip_code", "cursor_queue_position", "cursor_lead_id", "refunded_rows", "pause_day",
  "pauses_today", "probe_count", "next_probe_at", "last_probe_at", "last_probe_result",
  "needs_manual_resume", "alert_sent_at",
];

const check = postgres(url, opts);
try {
  const got = (
    await check`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'dialer_campaign_line_health'`
  ).map((c) => c.column_name);
  const missing = want.filter((c) => !got.includes(c));
  if (missing.length) throw new Error(`missing columns: ${missing.join(", ")}`);
  const [idx] = await check`
    SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'dialer_campaign_line_health_probe_idx'`;
  if (idx.n !== 1) throw new Error("probe index missing");
  console.log(`E-374 verified: ${want.length} columns + probe index`);
} finally {
  await check.end();
}
