// Applies drizzle/E-241_scraper_batch_job_queue.sql and then PROVES it landed.
//
// Usage:  node --env-file=.env.local scripts/apply-e241-scraper-batch-job-queue.mjs
//         node --env-file=.env.local scripts/apply-e241-scraper-batch-job-queue.mjs --dry-run
//
// WHY THE LONG NAME. Two unrelated migrations both claimed E-241 — the
// offer-close-vocabulary one and this branch's
// `E-241_scraper_batch_job_queue.sql` — and their appliers collided on
// `scripts/apply-e241.mjs`, leaving that file with unresolved merge markers.
// One .mjs cannot be both scripts (both declare `url`, `sql` and a top-level
// try block), so the newcomer moved, exactly as E-240 moved when main merged a
// conflicting E-239 while that branch was open.
//
// SINCE THEN the other side renumbered: on 2026-08-17 the offer-close file
// became `E-245_offer_close_vocabulary.sql` with `scripts/apply-e245.mjs`, so
// the collision this long name was invented to dodge no longer exists and
// `scripts/apply-e241.mjs` is now a free path. THIS FILE KEEPS ITS NAME anyway:
// it is referenced by that name in MIGRATION_CHECKLIST.md and in the runbook,
// and churning it a second time would cost more than the tidiness is worth.
//
// This .sql keeps E-241 for the reason the renumber did not apply to it: it was
// already applied to db-1/sandbox under the E-241 name on 2026-08-16 AND it is
// the file `main` merged first, so E-241 is legitimately its number. Renaming
// it would buy nothing (there is no ledger in the database) while invalidating
// the apply record. See the note in MIGRATION_CHECKLIST.md.
//
// The file is additive and idempotent (CREATE TABLE / CREATE INDEX IF NOT
// EXISTS), so a second run is a no-op — but "no exception was thrown" is not
// evidence, so this verifies every object by querying information_schema and
// pg_indexes afterwards, including that the two partial indexes are genuinely
// partial. That last check matters: Drizzle's index builder cannot express a
// WHERE clause, so the migration is the only source of the predicate, and an
// index silently created without it would still "exist" while scanning the
// whole table on every 30s dispatch tick.
//
// It also refuses to run if E-227 is missing, because E-241's dispatcher calls
// reapStuckRuns() on every tick and without scraper_runs.last_progress_at that
// reaps healthy long-running batch jobs at minute 11.

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const DRY = process.argv.includes("--dry-run");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with --env-file=.env.local");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 2,
  connect_timeout: 20,
  idle_timeout: 10,
});

const EXPECTED_COLUMNS = [
  "id",
  "batch_id",
  "seq",
  "query_text",
  "city",
  "max_results",
  "expand_with_ai",
  "status",
  "run_id",
  "attempts",
  "last_error",
  "schedule_mode",
  "run_after",
  "window_start",
  "window_end",
  "window_days",
  "created_by",
  "created_at",
  "dispatched_at",
  "finished_at",
  "leads_promoted",
];

const EXPECTED_INDEXES = {
  idx_scraper_job_queue_claim: "partial",
  idx_scraper_job_queue_batch: "plain",
  idx_scraper_job_queue_run: "partial",
};

try {
  const host = new URL(url).hostname;
  console.log(`[E-241] target: ${host}${new URL(url).pathname}`);

  // ── Dependency gate ──────────────────────────────────────────────────────
  const [dep] = await sql`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'scraper_runs' AND column_name = 'last_progress_at'`;
  if (dep.n === 0) {
    console.error(
      "[E-241] REFUSING: scraper_runs.last_progress_at is missing.\n" +
        "        Apply drizzle/E-227_scraper_multi_query.sql first — without it the\n" +
        "        stuck-run reaper kills healthy batch jobs after 10 minutes.",
    );
    process.exit(2);
  }
  console.log("[E-241] dependency OK — E-227 is present");

  // ── Apply ────────────────────────────────────────────────────────────────
  const file = path.join(process.cwd(), "drizzle", "E-241_scraper_batch_job_queue.sql");
  const ddl = fs.readFileSync(file, "utf8");

  // Guard against ever pointing this at a file that mutates data. Every object
  // here is pure additive DDL and it should stay that way.
  //
  // Scan CODE, not prose: strip `--` comments AND single-quoted string
  // literals first (handling '' escapes). This file is mostly COMMENT ON
  // statements, and their text says things like "not a failed INSERT at
  // dispatch time" — a naive scan reads that as a data-mutating statement and
  // refuses to apply a migration that does nothing of the sort.
  const code = ddl
    .replace(/^\s*--.*$/gm, "")
    .replace(/'(?:[^']|'')*'/g, "''");
  const forbidden =
    /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE|DROP\s+COLUMN|DROP\s+TABLE|ALTER\s+TYPE|SET\s+NOT\s+NULL)\b/i;
  const hit = code.match(forbidden);
  if (hit) {
    console.error(
      `[E-241] REFUSING: the .sql contains a non-additive statement (${hit[0]}).`,
    );
    process.exit(3);
  }

  if (DRY) {
    console.log("[E-241] --dry-run: not applying. DDL is additive and passed the guard.");
  } else {
    // The file carries its own BEGIN/COMMIT, so it is sent verbatim.
    await sql.unsafe(ddl);
    console.log("[E-241] applied");
  }

  // ── Verify ───────────────────────────────────────────────────────────────
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'scraper_job_queue'`;
  const have = new Set(cols.map((c) => c.column_name));
  const missing = EXPECTED_COLUMNS.filter((c) => !have.has(c));

  if (missing.length) {
    console.error(`[E-241] FAILED — missing column(s): ${missing.join(", ")}`);
    process.exit(4);
  }
  console.log(`[E-241] verified ${EXPECTED_COLUMNS.length} columns`);

  const idx = await sql`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'scraper_job_queue'`;
  const byName = new Map(idx.map((i) => [i.indexname, i.indexdef]));

  for (const [name, kind] of Object.entries(EXPECTED_INDEXES)) {
    const def = byName.get(name);
    if (!def) {
      console.error(`[E-241] FAILED — index ${name} is missing`);
      process.exit(5);
    }
    const isPartial = / WHERE /i.test(def);
    if (kind === "partial" && !isPartial) {
      console.error(
        `[E-241] FAILED — index ${name} exists but is NOT partial:\n        ${def}`,
      );
      process.exit(6);
    }
    console.log(`[E-241] verified index ${name} (${kind})`);
  }

  const [rows] = await sql`SELECT count(*)::int AS n FROM scraper_job_queue`;
  console.log(`[E-241] OK — scraper_job_queue holds ${rows.n} row(s)`);
} catch (err) {
  console.error("[E-241] ERROR:", err?.message ?? err);
  if (err?.code) console.error("        SQLSTATE:", err.code);
  process.exitCode = 1;
} finally {
  await sql.end();
}
