// One-off: apply E-373 (ai_dial_dispositions, dialer_number_stats, ai_redial_plan —
// AI dialer Dispositions v3 + re-attempt rules, Priya KPI tracker tasks 6 and 8)
// to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e373.mjs database-1
//   node scripts/_apply-e373.mjs database-2
//   ENV_FILE=../itarang-software/.env.local node scripts/_apply-e373.mjs database-1   (from a worktree)
//
// Additive: three new tables, not mirrored in schema.ts. Reads that host's URL from
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

const file = readFileSync("drizzle/E-373_ai_dial_dispositions.sql", "utf8");
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

const want = {
  ai_dial_dispositions: [
    "dial_key", "lead_id", "campaign_id", "phone_key", "direction", "l1", "l2", "l3", "rule_no",
    "rules_version", "sip_code", "answered_by", "call_result", "callback_agreed", "call_language",
    "ended_by", "end_reason_raw", "duration_secs", "effects", "dialled_at", "created_at", "updated_at",
  ],
  dialer_number_stats: [
    "phone_key", "lead_id", "reject_streak", "caller_id_check_at", "dead_audio_count",
    "intro_hangup_count", "last_l2", "last_dial_at", "updated_at",
  ],
  ai_redial_plan: ["lead_id", "due_at", "l3", "once_only", "used", "source_dial", "created_at", "updated_at"],
};

const check = postgres(url, opts);
try {
  for (const [table, cols] of Object.entries(want)) {
    const got = (
      await check`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table}
         ORDER BY ordinal_position`
    ).map((c) => c.column_name);
    if (JSON.stringify(got) !== JSON.stringify(cols)) {
      throw new Error(`${table}: columns differ: ${got.join(", ")}`);
    }
    const [pk] = await check`
      SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
       WHERE c.relname = ${table} AND i.indisprimary`;
    if (pk.n !== 1) throw new Error(`${table}: primary key missing`);
    console.log(`${table}: ${cols.length} columns + primary key`);
  }
  console.log("E-373 verified");
} finally {
  await check.end();
}
