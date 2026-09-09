// Applies drizzle/E-292_refurbish_flow_v3.sql and then PROVES it landed.
//
// E-292 rebuilds the refurbishment LOT engine to the v3 design: triage columns
// on recovery_batteries, PI / counter / refurbisher / margin / close columns on
// refurbishment_lots, refurbisher cost + final_cost on refurbishment_jobs, the
// new `refurbishers` + `refurbisher_portal_credentials` tables and
// users.refurbisher_id. It also REMAPS v2 lot statuses (proposed -> estimated,
// awaiting_advance -> pi_accepted, ...) and job status in_progress ->
// at_refurbisher on lot items, and recreates the one-open-job partial index.
//
// REQUIRED BEFORE THE v3 CODE DEPLOYS: drizzle lists every column in its
// SELECT/INSERT, so an unapplied host fails every lot read with
// `column "pi_amount" does not exist`.
//
//   node scripts/apply-e292.mjs --dry-run
//   node scripts/apply-e292.mjs
//   DATABASE_URL=... node scripts/apply-e292.mjs      # to target the OTHER db
//
// This repo drifts between two RDS instances, so the host is printed and
// labelled before anything is written. Read it. A census of lot statuses is
// printed BEFORE the remap so mid-flight lots are visible.

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-292_refurbish_flow_v3.sql";

function resolveUrl() {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
  }
  const env = readFileSync(".env.local", "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
  return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit - check the host below)" };
}

const PREREQ_TABLES = ["refurbishment_lots", "refurbishment_jobs", "refurbishment_lot_events", "recovery_batteries", "users"];
const EXPECTED_TABLES = ["refurbishers", "refurbisher_portal_credentials"];
const EXPECTED_COLUMNS = [
  ["recovery_batteries", "health_pct"],
  ["recovery_batteries", "triage_choice"],
  ["refurbishment_lots", "pi_amount"],
  ["refurbishment_lots", "pi_url"],
  ["refurbishment_lots", "refurbisher_id"],
  ["refurbishment_lots", "itarang_margin_amount"],
  ["refurbishment_lots", "close_outcome"],
  ["refurbishment_lots", "counter_total"],
  ["refurbishment_jobs", "refurbisher_cost"],
  ["refurbishment_jobs", "final_cost"],
  ["users", "refurbisher_id"],
];
const V2_STATUSES = ["proposed", "awaiting_advance", "advance_paid", "pickup_scheduled", "delivered", "revision_pending"];

async function main() {
  const { url, from } = resolveUrl();
  const host = new URL(url).host;
  const label = host.includes("database-2") ? "database-2 (checklist: prod)" : host.includes("database-1") ? "database-1 (checklist: sandbox)" : "UNKNOWN";
  console.log(`host  : ${host}  - ${label}`);
  console.log(`from  : ${from}`);
  console.log(`mode  : ${DRY_RUN ? "DRY RUN (BEGIN ... ROLLBACK)" : "APPLY (COMMIT)"}\n`);

  let notices = 0;
  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, max: 1, onnotice: () => { notices += 1; } });
  try {
    const present = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY(${PREREQ_TABLES})`;
    const have = new Set(present.map((r) => r.table_name));
    console.log("prerequisite tables:");
    let blocked = false;
    for (const t of PREREQ_TABLES) {
      const ok = have.has(t);
      if (!ok) blocked = true;
      console.log(`  ${ok ? "OK     " : "MISSING"} ${t}`);
    }
    if (blocked) {
      console.error("\nABORT: apply E-233, E-270, E-271 first - the lot tables are missing here.");
      await sql.end();
      process.exit(1);
    }

    console.log("\nlot status census BEFORE:");
    const census = await sql`SELECT status, count(*)::int AS n FROM refurbishment_lots GROUP BY 1 ORDER BY 1`;
    for (const r of census) console.log(`  ${String(r.n).padStart(4)}  ${r.status}${V2_STATUSES.includes(r.status) ? "   <- v2, will be remapped" : ""}`);
    if (census.length === 0) console.log("  (no lots)");

    const dupes = await sql`
      SELECT battery_id, count(*)::int AS n FROM refurbishment_jobs
       WHERE status IN ('requested','in_progress','at_refurbisher','ready')
       GROUP BY battery_id HAVING count(*) > 1`;
    if (dupes.length) {
      console.error(`\nABORT: ${dupes.length} battery(ies) already hold two open jobs - the new unique index would fail:`);
      for (const d of dupes) console.error(`  ${d.battery_id} x ${d.n}`);
      await sql.end();
      process.exit(1);
    }

    const already = await sql`SELECT 1 FROM information_schema.columns WHERE table_name='refurbishment_lots' AND column_name='pi_amount'`;
    console.log(`\nalready applied? ${already.length ? "yes (re-run is a no-op)" : "no - will be applied"}`);

    console.log(`\n--- ${DRY_RUN ? "dry-running" : "applying"} ${FILE} ---`);
    let rolledBack = false;
    try {
      await sql.begin(async (tx) => {
        const t0 = Date.now();
        await tx.unsafe(readFileSync(FILE, "utf8"));
        console.log(`  OK  (${Date.now() - t0}ms)`);
        if (DRY_RUN) { rolledBack = true; throw new Error("__rollback__"); }
      });
    } catch (e) {
      if (!(e instanceof Error && e.message === "__rollback__")) throw e;
    }
    console.log(`${notices} "already exists, skipping" notice(s) - 0 means everything was new.`);

    if (!rolledBack) {
      console.log("\nverify:");
      for (const t of EXPECTED_TABLES) {
        const r = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=${t}`;
        console.log(`  ${r.length ? "OK     " : "MISSING"} table ${t}`);
      }
      for (const [t, c] of EXPECTED_COLUMNS) {
        const r = await sql`SELECT 1 FROM information_schema.columns WHERE table_name=${t} AND column_name=${c}`;
        console.log(`  ${r.length ? "OK     " : "MISSING"} ${t}.${c}`);
      }
      const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename='refurbishment_jobs' AND indexname LIKE 'refurbishment_jobs_one_open_per_battery%'`;
      console.log(`  index: ${idx.map((i) => i.indexname).join(", ") || "MISSING"}`);
      const width = await sql`SELECT column_name, character_maximum_length FROM information_schema.columns WHERE table_name='refurbishment_lots' AND column_name IN ('last_party','cancelled_by_party')`;
      for (const w of width) console.log(`  ${w.column_name} varchar(${w.character_maximum_length})${w.character_maximum_length >= 16 ? "" : "  <- NOT WIDENED"}`);
      const after = await sql`SELECT status, count(*)::int AS n FROM refurbishment_lots GROUP BY 1 ORDER BY 1`;
      console.log("\nlot status census AFTER:");
      for (const r of after) console.log(`  ${String(r.n).padStart(4)}  ${r.status}${V2_STATUSES.includes(r.status) ? "   <- STILL v2 ?!" : ""}`);
      const legacyJobs = await sql`SELECT count(*)::int AS n FROM refurbishment_jobs WHERE status='in_progress' AND lot_id IS NOT NULL`;
      console.log(`lot items still in_progress: ${legacyJobs[0].n} (expected 0)`);
      console.log("\nCOMMITTED.");
    } else {
      console.log("\nALL CLEAN - rolled back, database unchanged. Re-run without --dry-run to commit.");
    }
    await sql.end();
    process.exit(0);
  } catch (err) {
    console.error("\nFAILED - transaction rolled back, database unchanged.");
    console.error("  code    :", err.code);
    console.error("  message :", err.message);
    if (err.where) console.error("  where   :", err.where);
    await sql.end();
    process.exit(2);
  }
}

main();
