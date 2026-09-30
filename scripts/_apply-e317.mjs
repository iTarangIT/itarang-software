// One-off: apply E-317 (lead source lock) to database-1 (sandbox) or database-2 (prod).
//   node scripts/_apply-e317.mjs database-1
//   node scripts/_apply-e317.mjs database-2
// Same pattern as _apply-e312-e314.mjs: reads that host's URL from .env.local
// (commented or not), never prints it; runs the file twice (second pass must be
// a no-op); prints door / origin counts before and after, then verifies.
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

const counts = async (label) => {
  const v = postgres(url, { max: 1, ssl: { rejectUnauthorized: false } });
  try {
    const doors = await v`SELECT COALESCE(source_door, '(none)') AS door, COUNT(*)::int AS n
                            FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC`;
    const origins = await v`SELECT COALESCE(source_origin, '(none)') AS origin, COUNT(*)::int AS n
                              FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC`;
    console.log(`\n── ${label}: Entered via (source_door)`);
    console.table(doors);
    console.log(`── ${label}: Found via (source_origin)`);
    console.table(origins);
  } finally {
    await v.end();
  }
};

await counts("BEFORE");

const ddl = readFileSync("drizzle/E-317_lead_source_lock.sql", "utf8");
for (const pass of [1, 2]) {
  const sql = postgres(url, { max: 1, ssl: { rejectUnauthorized: false }, onnotice: (n) => console.log("notice:", n.message) });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
    });
    console.log(`E-317 pass ${pass}: ok`);
  } finally {
    await sql.end();
  }
}

await counts("AFTER");

const v = postgres(url, { max: 1, ssl: { rejectUnauthorized: false } });
const trg = await v`SELECT tgname FROM pg_trigger WHERE tgname IN ('dealer_leads_source_door', 'dealer_leads_source_lock') ORDER BY 1`;
const fn = await v`SELECT prosrc LIKE '%manual_upload_lead%' AS still_maps_manual FROM pg_proc WHERE proname = 'dealer_leads_source_door_fn'`;
console.log("\ntriggers:", trg.map((t) => t.tgname).join(", ") || "NONE");
console.log("door fn still maps manual_upload_lead:", fn[0]?.still_maps_manual);
await v.end();
