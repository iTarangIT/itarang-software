// One-off: apply E-396 (WhatsApp visit proof) to database-1 (sandbox) or database-2 (prod).
//
//   node scripts/_apply-e396.mjs database-1
//
// visit_captures: + source, + shop_distance_m, gps_accuracy_m DROP NOT NULL. Reads that
// host's URL from the env file, never prints it. Applies twice (the second pass must be a
// no-op), then re-checks the columns on a FRESH connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in the env file`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };
const file = readFileSync("drizzle/E-396_whatsapp_visit_proof.sql", "utf8");
const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  const [t] = await sql`SELECT to_regclass('public.visit_captures') IS NOT NULL AS ok`;
  if (!t.ok) throw new Error("visit_captures missing on this database — apply E-363 first");
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  const cols = await check`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visit_captures'
       AND column_name IN ('source', 'shop_distance_m', 'gps_accuracy_m') ORDER BY 1`;
  console.table(cols);
  const ok =
    cols.length === 3 &&
    cols.find((c) => c.column_name === "source")?.is_nullable === "NO" &&
    cols.find((c) => c.column_name === "shop_distance_m")?.is_nullable === "YES" &&
    cols.find((c) => c.column_name === "gps_accuracy_m")?.is_nullable === "YES";
  const [n] = await check`SELECT count(*)::int AS rows, count(*) FILTER (WHERE source = 'crm')::int AS crm FROM visit_captures`;
  console.log(`visit_captures rows: ${n.rows} (source crm: ${n.crm})`);
  console.log(ok ? "E-396 verified" : "E-396 NOT as expected");
  if (!ok) process.exitCode = 1;
} finally {
  await check.end();
}
