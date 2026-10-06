// One-off (6 Oct 2026): HSN 850790 (parts of accumulators — "LCD Display with
// Box") was classed as 'battery' by classifyHsn, so batteries sold counted the
// LCD box beside every battery. Re-class those lines as 'other'.
//   node scripts/_fix-850790-class.mjs database-1|database-2 [--commit]
import postgres from "postgres";
import { readFileSync } from "node:fs";
const target = process.argv[2];
const COMMIT = process.argv.includes("--commit");
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2 [--commit]");
const env = target === "database-2" ? ".env.production" : ".env.local";
const line = readFileSync(env, "utf8").split(/\r?\n/).find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in ${env}`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const sql = postgres(url, { max: 1, prepare: false, ssl: { rejectUnauthorized: false } });
const summary = () => sql`SELECT source, product_class, count(*)::int n, coalesce(sum(quantity),0)::int qty
  FROM invoice_line_items GROUP BY 1,2 ORDER BY 1,2`;
console.log(target, COMMIT ? "COMMIT" : "DRY RUN");
console.table(await summary());
const hit = await sql`SELECT source, count(*)::int n, coalesce(sum(quantity),0)::int qty FROM invoice_line_items
  WHERE product_class = 'battery' AND hsn LIKE '850790%' GROUP BY 1`;
console.log("to re-class:", hit);
if (COMMIT) {
  const r = await sql`UPDATE invoice_line_items SET product_class = 'other'
    WHERE product_class = 'battery' AND hsn LIKE '850790%'`;
  console.log("updated", r.count);
  console.table(await summary());
}
await sql.end();
