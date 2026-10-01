// One-off: apply E-319 (acquisition campaign links) and E-320 (lead source
// backfill) to database-1 (sandbox) or database-2 (prod). Tracker ID 81.
//
//   node scripts/_apply-e319-e320.mjs database-1 --dry-run      both files, ONE transaction, rolled back
//   node scripts/_apply-e319-e320.mjs database-1 --only=e319    schema + trigger only
//   node scripts/_apply-e319-e320.mjs database-1 --only=e320    the backfill only (needs E-319)
//   node scripts/_apply-e319-e320.mjs database-2
//
// Reads that host's URL from .env.local (commented or not), never prints it.
// Each file runs twice — the second pass must change nothing — and the source
// counts are printed before and after.
//
// ⚠ E-320 is PERMANENT: the E-317 lock keeps the first door / origin / campaign
// a lead is given. Read the dry-run counts before running it for real.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? null;
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2 [--dry-run] [--only=e319|e320]");
if (only && !["e319", "e320"].includes(only)) throw new Error("--only=e319 | --only=e320");
const line = readFileSync(".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0], dryRun ? "(dry run — rolled back)" : "", only ? `(only ${only})` : "");

const FILES = [
  { key: "e319", name: "E-319", sql: readFileSync("drizzle/E-319_acquisition_campaign_links.sql", "utf8") },
  { key: "e320", name: "E-320", sql: readFileSync("drizzle/E-320_lead_source_backfill.sql", "utf8") },
].filter((f) => !only || f.key === only);
const ROLLBACK = Symbol("rollback");
const skipped = [];

const snapshot = async (q) => {
  const doors = await q`
    SELECT COALESCE(source_door, '(none)') AS door, count(*)::int AS leads,
           count(*) FILTER (WHERE source_origin IS NULL)::int AS no_origin,
           count(*) FILTER (WHERE acquisition_campaign_id IS NULL)::int AS no_campaign
      FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC`;
  const origins = await q`
    SELECT COALESCE(source_origin, '(none)') AS origin, count(*)::int AS leads
      FROM dealer_leads GROUP BY 1 ORDER BY 2 DESC`;
  let campaigns = [];
  try {
    campaigns = await q.savepoint
      ? await q.savepoint((sp) => sp`SELECT kind, count(*)::int AS campaigns FROM acquisition_campaigns GROUP BY 1 ORDER BY 1`)
      : await q`SELECT kind, count(*)::int AS campaigns FROM acquisition_campaigns GROUP BY 1 ORDER BY 1`;
  } catch {
    campaigns = [{ kind: "(kind column not there yet)", campaigns: null }];
  }
  return { doors, origins, campaigns };
};

const show = (label, s) => {
  console.log(`\n── ${label} ──`);
  console.table(s.doors);
  console.table(s.origins);
  console.table(s.campaigns);
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function runAll(tx) {
  show("before", await snapshot(tx));
  for (const f of FILES) {
    await tx.unsafe(f.sql);
    const first = await snapshot(tx);
    console.log(`${f.name} pass 1: ok`);
    await tx.unsafe(f.sql);
    const second = await snapshot(tx);
    console.log(`${f.name} pass 2: ok — ${same(first, second) ? "changed nothing (idempotent)" : "CHANGED SOMETHING  <-- FAIL"}`);
    if (!same(first, second)) throw new Error(`${f.name} is not idempotent`);
  }
  if (skipped.length) throw new Error(`a migration skipped itself: ${skipped.join("; ")}`);
  show("after", await snapshot(tx));

  const trig = await tx`
    SELECT position('purchased_list' IN prosrc) > 0 AS prefills_neodove_origin
      FROM pg_proc WHERE proname = 'dealer_leads_source_door_fn'`;
  console.log("insert trigger pre-fills the NeoDove origin:", trig[0]?.prefills_neodove_origin ?? "(function missing)");
  const cols = await tx`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE (table_name IN ('upload_batches', 'scraper_runs') AND column_name = 'acquisition_campaign_id')
        OR (table_name = 'acquisition_campaigns' AND column_name IN ('kind', 'is_active', 'updated_at'))
     ORDER BY 1, 2`;
  console.log("E-319 columns:", cols.map((c) => `${c.table_name}.${c.column_name}`).join(", ") || "(none)");
  const top = await tx`
    SELECT c.kind, left(c.name, 70) AS name, c.origin,
           (SELECT count(*)::int FROM dealer_leads dl WHERE dl.acquisition_campaign_id = c.id) AS leads
      FROM acquisition_campaigns c ORDER BY 4 DESC LIMIT 12`;
  if (top.length) {
    console.log("\nlargest campaigns:");
    console.table(top);
  }
  const orphan = await tx`
    SELECT count(*)::int AS n FROM acquisition_campaigns c
     WHERE NOT EXISTS (SELECT 1 FROM dealer_leads dl WHERE dl.acquisition_campaign_id = c.id)`;
  console.log("campaigns with no lead:", orphan[0].n);
}

const sql = postgres(url, {
  max: 1,
  ssl: { rejectUnauthorized: false },
  onnotice: (n) => {
    // Postgres' own "already exists, skipping" is the idempotency working. A
    // RAISE NOTICE from the files themselves means a block bailed out.
    if (/does not exist, skipping|already exists, skipping/.test(n.message)) return;
    if (/^skip |skipped/i.test(n.message)) skipped.push(n.message);
    else console.log("  notice:", n.message);
  },
});
try {
  await sql.begin(async (tx) => {
    await runAll(tx);
    if (dryRun) throw ROLLBACK;
  });
  console.log("\ncommitted");
} catch (e) {
  if (e !== ROLLBACK) throw e;
  console.log("\nrolled back — nothing was changed");
} finally {
  await sql.end();
}
