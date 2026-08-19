// Applies drizzle/E-250_intent_review_loop.sql — the intent-review loop
// (human overrides that move the lead, attached call recordings, and the
// DB-driven calibration set).
//
//   node scripts/apply-e250.mjs <env-file|->            # dry run: reports, writes nothing
//   node scripts/apply-e250.mjs <env-file|-> --apply
//
// Sandbox:     node scripts/apply-e250.mjs .env.local --apply
// Production:  node scripts/apply-e250.mjs .env.production --apply
//
// TARGET SELECTION IS EXPLICIT AND MANDATORY, for the reason apply-e251.mjs
// spells out: every applier before it defaulted to .env.local, **.env.local is
// SANDBOX (database-1)**, and that default is how a change meant for production
// silently landed on sandbox on 2026-08-18. There is no default here and no
// `--both` flag — writing to production must be its own deliberate command, not
// a side effect of one aimed at sandbox. The resolved host AND which
// environment that host IS are printed before anything is written.
//
// ── DEPENDS ON E-159 ─────────────────────────────────────────────────────────
// Section 1 of E-250 widens `intent_score_feedback`, which E-159 creates. E-250
// wraps that section in `EXCEPTION WHEN undefined_table` so a database without
// E-159 gets a NOTICE instead of an aborted migration — safe, but it means an
// E-159-less database would take E-250 and SILENTLY skip a fifth of it. The
// review UI would then 500 on every correction with "column ai_band does not
// exist", which reads like a code bug rather than a missing migration.
//
// So this script checks for E-159 first and, with --apply, applies it too.
// E-159 is `CREATE TABLE IF NOT EXISTS` throughout, so that is a no-op wherever
// it is already present. drizzle/MIGRATION_CHECKLIST.md currently shows E-159
// as unapplied on all four columns, but the checklist ticks are known to lag
// reality — this probes the live database rather than trusting them.
//
// ── IDEMPOTENT ───────────────────────────────────────────────────────────────
// Re-running reports every object as already-present and writes nothing new.
// Note there is deliberately NO "apply twice in a transaction then roll back"
// self-check: postgres.js `unsafe()` DDL escapes the rollback, so that idiom
// prints "ROLLED BACK" while the tables are live. The BEFORE/AFTER reports are
// the check instead, and they read from the live catalog.

import { readFileSync } from "node:fs";
import postgres from "postgres";

const [target, ...flags] = process.argv.slice(2);
const APPLY = flags.includes("--apply");

if (!target) {
  console.error("usage: node scripts/apply-e250.mjs <env-file|-> [--apply]");
  console.error("   eg: node scripts/apply-e250.mjs .env.local              # sandbox, dry run");
  console.error("       node scripts/apply-e250.mjs .env.local --apply      # sandbox");
  console.error("       node scripts/apply-e250.mjs .env.production --apply # production");
  process.exit(1);
}

function resolveUrl() {
  if (target === "-") {
    if (!process.env.DATABASE_URL) {
      throw new Error("'-' given but DATABASE_URL is not set in the environment.");
    }
    return { url: process.env.DATABASE_URL, from: "process env" };
  }
  // First ACTIVE (uncommented) DATABASE_URL line. .env files here carry
  // commented-out alternates for the other environment, and picking one of
  // those up is the same wrong-target mistake in a different costume.
  const m = readFileSync(target, "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error(`No active DATABASE_URL line in ${target}.`);
  return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: target };
}

const { url, from } = resolveUrl();
const e250 = readFileSync("drizzle/E-250_intent_review_loop.sql", "utf8");
const e159 = readFileSync("drizzle/E-159_intent_score_feedback.sql", "utf8");

const host = new URL(url).hostname;
const envName = host.startsWith("database-2")
  ? "PRODUCTION  (crm.itarang.com)"
  : host.startsWith("database-1")
    ? "sandbox     (sandbox.itarang.com)"
    : "UNKNOWN — verify before continuing";

console.log(`HOST : ${host}   (from ${from})`);
console.log(`ENV  : ${envName}`);
console.log(`MODE : ${APPLY ? "APPLY (will write)" : "DRY RUN (reports only, writes nothing)"}\n`);

// ── What E-250 must leave behind ─────────────────────────────────────────────
// (table, column); a null column means "the table itself".
const EXPECTED = [
  // New tables
  ["lead_call_recordings", null],
  ["intent_calibration_examples", null],
  // §1 — the correction record, widened
  ["intent_score_feedback", "ai_band"],
  ["intent_score_feedback", "reviewer_role"],
  ["intent_score_feedback", "review_kind"],
  ["intent_score_feedback", "source"],
  ["intent_score_feedback", "external_key"],
  ["intent_score_feedback", "recording_id"],
  ["intent_score_feedback", "agreed"],
  ["intent_score_feedback", "applied_to_lead"],
  ["intent_score_feedback", "applied_at"],
  // §4 — prompt provenance + the human answer on the call
  ["ai_call_logs", "extraction_version"],
  ["ai_call_logs", "calibration_set_hash"],
  ["ai_call_logs", "human_band"],
  ["ai_call_logs", "human_reviewed_by"],
  ["ai_call_logs", "human_reviewed_at"],
  // §5 — is the lead's live band the AI's or a human's
  ["dealer_leads", "intent_band_source"],
  ["dealer_leads", "intent_overridden_by"],
  ["dealer_leads", "intent_overridden_at"],
];

const EXPECTED_INDEXES = [
  "intent_score_feedback_external_key_idx",
  "intent_score_feedback_disagreement_idx",
  "lead_call_recordings_claim_idx",
  "lead_call_recordings_lead_idx",
  "lead_call_recordings_call_idx",
  "intent_calibration_examples_active_idx",
];

// Notices matter here — E-250's guarded sections report a skipped section via
// RAISE NOTICE rather than failing, so they are the only signal that part of the
// migration did not run. But postgres.js's default handler dumps the ENTIRE
// notice object, including the full SQL of the statement that raised it, which
// on a re-run buries everything under hundreds of lines of echoed DDL and makes
// the AFTER report impossible to find.
//
// So: one line per notice, and fold away the "already exists, skipping" chorus
// that an idempotent re-run necessarily produces — counting those instead,
// because the count IS the useful information ("this run was a no-op").
let skipCount = 0;
const sql = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  connect_timeout: 20,
  onnotice: (n) => {
    const msg = n.message ?? String(n);
    if (/already exists, skipping/i.test(msg)) {
      skipCount += 1;
      return;
    }
    console.log(`  NOTICE  ${msg}`);
  },
});

async function hasTable(name) {
  const [r] = await sql`SELECT to_regclass(${"public." + name}) AS t`;
  return Boolean(r.t);
}

async function report(label) {
  console.log(`--- ${label} ---`);
  const missing = [];

  for (const [table, column] of EXPECTED) {
    let present;
    if (column === null) {
      present = await hasTable(table);
      console.log(`  ${present ? "present" : "MISSING"}  table ${table}`);
    } else {
      const [r] = await sql`SELECT 1 AS ok FROM information_schema.columns
                             WHERE table_schema='public'
                               AND table_name=${table}
                               AND column_name=${column}`;
      present = Boolean(r);
      console.log(`  ${present ? "present" : "MISSING"}  ${table}.${column}`);
    }
    if (!present) missing.push(column === null ? `table ${table}` : `${table}.${column}`);
  }

  const idx = (
    await sql`SELECT indexname FROM pg_indexes
               WHERE schemaname='public' AND indexname = ANY(${EXPECTED_INDEXES})`
  ).map((r) => r.indexname);
  for (const i of EXPECTED_INDEXES) {
    const present = idx.includes(i);
    console.log(`  ${present ? "present" : "MISSING"}  index ${i}`);
    if (!present) missing.push(`index ${i}`);
  }

  console.log("");
  return missing;
}

/**
 * The external_key index must be PARTIAL.
 *
 * scripts/intent/importSheetReviews.ts writes
 *   ON CONFLICT (external_key) WHERE external_key IS NOT NULL DO NOTHING
 * and Postgres only matches that against an index whose own predicate is the
 * same. If the index were created without the WHERE clause — by an older copy
 * of the file, or by hand — the index would still show as "present" above while
 * every import statement failed with "no unique or exclusion constraint
 * matching the ON CONFLICT specification". Checking the predicate is the
 * difference between "the index exists" and "the importer will work".
 */
async function checkPartialIndex() {
  const [r] = await sql`SELECT indexdef FROM pg_indexes
                         WHERE schemaname='public'
                           AND indexname='intent_score_feedback_external_key_idx'`;
  if (!r) return;
  const ok = /UNIQUE/i.test(r.indexdef) && /WHERE\s*\(?external_key IS NOT NULL/i.test(r.indexdef);
  console.log(
    ok
      ? "  ok      external_key index is UNIQUE and partial — the Sheet importer's ON CONFLICT will match it"
      : `  WARNING external_key index is not the expected partial unique index:\n          ${r.indexdef}`,
  );
  return ok;
}

try {
  // ── E-159 dependency ──
  const hadFeedbackTable = await hasTable("intent_score_feedback");
  console.log(
    `E-159 : intent_score_feedback ${hadFeedbackTable ? "present" : "MISSING — E-250 §1 would silently no-op"}\n`,
  );

  const missingBefore = await report("BEFORE");

  if (!APPLY) {
    console.log(
      missingBefore.length === 0
        ? "Nothing to do — every E-250 object is already present on this database."
        : `Dry run — nothing written. ${missingBefore.length} object(s) would be created.`,
    );
    if (!hadFeedbackTable) {
      console.log(
        "\nNOTE: E-159 is missing here. Running with --apply will apply E-159 first\n" +
          "      (CREATE TABLE IF NOT EXISTS — a no-op where it already exists), then E-250.",
      );
    }
    console.log("\nRe-run with --apply to execute.");
    process.exit(0);
  }

  if (!hadFeedbackTable) {
    console.log("applying E-159 first (E-250 §1 depends on it)…");
    await sql.unsafe(e159);
    console.log("E-159 applied.\n");
  }

  console.log("applying E-250…");
  await sql.unsafe(e250);
  console.log(
    skipCount > 0
      ? `applied. (${skipCount} object(s) already existed and were skipped — this was a re-run)\n`
      : "applied.\n",
  );

  const missingAfter = await report("AFTER");
  await checkPartialIndex();
  console.log("");

  if (missingAfter.length > 0) {
    console.log("NOT everything landed — check the NOTICEs above:");
    for (const m of missingAfter) console.log(`  still missing: ${m}`);
    console.log(
      "\nA missing intent_score_feedback.* column almost always means E-159 is absent\n" +
        "and §1 skipped with a NOTICE. Apply E-159, then re-run this script.",
    );
    process.exitCode = 1;
  } else {
    console.log("All E-250 objects present on this database.");
    console.log(
      `Now tick E-250 for ${
        host.startsWith("database-2")
          ? "the `local (db-2)` and `prod` columns"
          : host.startsWith("database-1")
            ? "the `db-1` and `sandbox` columns"
            : "this environment's column pair"
      } in drizzle/MIGRATION_CHECKLIST.md.`,
    );
    if (!hadFeedbackTable) {
      console.log("Tick E-159 for the same pair — it was applied by this run.");
    }
  }
} finally {
  await sql.end();
}
