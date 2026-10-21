// One-off: apply E-354 (office_hours_settings, ID 85 #8) and E-355 (wider
// lead clock kinds: ready_assign, quote_deliver, quote_revise — IDs 85/86) to
// database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e354-e355.mjs database-1
//   node scripts/_apply-e354-e355.mjs database-2
//
// DDL, additive. Reads that host's URL from .env.local (commented or not),
// never prints it. Applies each file twice (the second pass must be a no-op),
// then checks on a FRESH connection — postgres.js DDL is not undone by a
// rollback, so the check is a real one.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const files = ["drizzle/E-354_office_hours_settings.sql", "drizzle/E-355_ready_assign_quote_clocks.sql"];
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const f of files) {
    const body = readFileSync(f, "utf8");
    for (const pass of [1, 2]) {
      await sql.begin((tx) => tx.unsafe(body));
      console.log(`${f} pass ${pass}: ok`);
    }
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  const [t] = await check`SELECT to_regclass('public.office_hours_settings') IS NOT NULL AS ok`;
  if (!t.ok) throw new Error("✗ office_hours_settings missing");
  const cols = await check`
    SELECT table_name, character_maximum_length AS len FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'clock' AND table_name IN ('lead_clocks', 'lead_limit_events')`;
  for (const c of cols) {
    if (c.len < 20) throw new Error(`✗ ${c.table_name}.clock still varchar(${c.len})`);
    console.log(`${c.table_name}.clock varchar(${c.len})`);
  }
  const [k] = await check`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'lead_clocks_clock_check'`;
  if (!k || !k.def.includes("ready_assign")) throw new Error("✗ lead_clocks_clock_check lacks the new kinds");
  console.log("✓ E-354 and E-355 applied");
} finally {
  await check.end();
}
