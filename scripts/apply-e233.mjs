/**
 * Applies drizzle/E-233_refurbishment_jobs.sql and verifies the result.
 *
 *   node --env-file=.env.local scripts/apply-e233.mjs
 *   node --env-file=.env.local scripts/apply-e233.mjs --check
 *
 * Same shape as apply-e232.mjs: apply, then PROVE the objects exist.
 *
 * The check worth watching here is the PARTIAL unique index
 * `refurbishment_jobs_one_open_per_battery`. It is the only thing stopping two
 * operators from raising two open jobs for the same battery, at which point
 * "the refurbishment cost of this battery" — the number that rolls into the
 * auction base price — stops having a single answer. This script asserts the
 * index exists AND that its predicate is present, because an index created
 * without the WHERE clause would look identical in a name-only check while
 * forbidding a battery from ever being refurbished twice.
 *
 * DEPENDS ON E-232 — refurbishment_jobs.battery_id references recovery_batteries.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const FILE = join(process.cwd(), "drizzle", "E-233_refurbishment_jobs.sql");
const CHECK_ONLY = process.argv.includes("--check");

const JOB_COLUMNS = [
  "id",
  "tenant_id",
  "battery_id",
  "recovery_pipeline_id",
  "requested_by_user_id",
  "assigned_workshop",
  "checklist",
  "accessories",
  "estimated_cost",
  "actual_cost",
  "status",
  "notes",
  "requested_at",
  "started_at",
  "returned_at",
  "created_at",
  "updated_at",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (run with --env-file=.env.local)");
    process.exit(2);
  }

  const host = new URL(url).host;
  console.log(`host: ${host}`);
  console.log(`file: ${FILE}`);
  console.log(CHECK_ONLY ? "mode: --check (no writes)\n" : "mode: apply\n");

  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

  try {
    // E-233 alters nbfc_battery_evaluations and references recovery_batteries.
    // Fail with the real reason rather than a bare 42P01 from mid-file.
    const [{ r: e232 }] = await sql`
      SELECT to_regclass('public.recovery_batteries') AS r
    `;
    if (!e232) {
      throw new Error(
        "E-232 has not been applied to this database (recovery_batteries is missing). Apply scripts/apply-e232.mjs first.",
      );
    }

    const [{ r: before }] = await sql`
      SELECT to_regclass('public.refurbishment_jobs') AS r
    `;
    console.log(
      before
        ? "· refurbishment_jobs already present — expecting a no-op"
        : "· refurbishment_jobs absent — creating",
    );

    if (!CHECK_ONLY) {
      await sql.unsafe(readFileSync(FILE, "utf8"));
      console.log("· applied without error\n");
    }

    const problems = [];

    const cols = await sql`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'refurbishment_jobs'
       ORDER BY ordinal_position
    `;
    if (cols.length === 0) {
      problems.push("refurbishment_jobs missing after apply");
    } else {
      const missing = JOB_COLUMNS.filter(
        (c) => !cols.some((x) => x.column_name === c),
      );
      if (missing.length) {
        problems.push(`refurbishment_jobs missing column(s): ${missing.join(", ")}`);
      }
    }

    const evalCols = await sql`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'nbfc_battery_evaluations'
         AND column_name IN ('photo_urls', 'condition_grade')
    `;
    const evalMissing = ["photo_urls", "condition_grade"].filter(
      (c) => !evalCols.some((x) => x.column_name === c),
    );
    if (evalMissing.length) {
      problems.push(
        `nbfc_battery_evaluations missing column(s): ${evalMissing.join(", ")}`,
      );
    }
    const photoUrls = evalCols.find((c) => c.column_name === "photo_urls");
    if (photoUrls && photoUrls.data_type !== "ARRAY") {
      problems.push(
        `nbfc_battery_evaluations.photo_urls should be text[], got ${photoUrls.data_type}`,
      );
    }

    // The partial index, and its predicate. A name-only check would pass on an
    // index created WITHOUT the WHERE clause — which would silently forbid a
    // battery from ever being refurbished a second time.
    const [idx] = await sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'refurbishment_jobs_one_open_per_battery'
    `;
    if (!idx) {
      problems.push("missing index: refurbishment_jobs_one_open_per_battery");
    } else if (!/WHERE/i.test(idx.indexdef)) {
      problems.push(
        "refurbishment_jobs_one_open_per_battery exists but is NOT partial — " +
          "it would forbid refurbishing a battery twice",
      );
    }

    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM refurbishment_jobs`;

    console.log("VERIFIED");
    console.log(`  refurbishment_jobs           ${cols.length} columns, ${n} rows`);
    console.log(
      `  nbfc_battery_evaluations     + ${evalCols.map((c) => c.column_name).join(", ") || "(none)"}`,
    );
    console.log(
      `  one-open-job-per-battery     ${idx ? (/WHERE/i.test(idx.indexdef) ? "partial unique ✓" : "PRESENT BUT NOT PARTIAL") : "MISSING"}`,
    );

    if (problems.length) throw new Error(`\n  - ${problems.join("\n  - ")}`);

    console.log(
      `\nE-233 ${CHECK_ONLY ? "verified" : "applied and verified"} on ${host}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message ?? error);
  process.exit(1);
});
