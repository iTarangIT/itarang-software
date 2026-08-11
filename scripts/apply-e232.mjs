/**
 * Applies drizzle/E-232_auction_catchup_battery_master_bidder_repoint.sql and
 * verifies the result.
 *
 * There is no migration runner in this project (see drizzle/MIGRATION_CHECKLIST.md).
 * Same shape as scripts/apply-e231.mjs: apply, then PROVE every object exists,
 * so "it ran" and "it worked" are not the same claim.
 *
 *   node --env-file=.env.local scripts/apply-e232.mjs
 *   node --env-file=.env.local scripts/apply-e232.mjs --check   (verify only)
 *
 * E-232 has three halves and the FIRST is the one worth watching. PART 1 is
 * catch-up DDL for six tables that were only ever created by `db:push` and have
 * no migration file at all; on a database that received that push it is a pure
 * no-op, and on one that did not it is the difference between the rest of the
 * file applying and aborting with 42P01. This script therefore reports, per
 * table, whether it pre-existed — that line is the actual finding.
 *
 * Additive and idempotent throughout, so re-running is safe.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const FILE = join(
  process.cwd(),
  "drizzle",
  "E-232_auction_catchup_battery_master_bidder_repoint.sql",
);

const CHECK_ONLY = process.argv.includes("--check");

/** PART 1 — catch-up: these six had no migration file before E-232. */
const CATCHUP_TABLES = [
  "nbfc_recovery_pipeline",
  "auction_lots",
  "auction_bids",
  "auction_settlements",
  "nbfc_auction_lot_actions",
  "nbfc_auction_cancel_requests",
];

/** PART 3 — the additive columns, by table. */
const EXPECTED_COLUMNS = {
  auction_bids: ["bidder_dealer_id", "bidder_kind"],
  auction_lots: [
    "seller_tenant_id",
    "auction_type",
    "starts_at",
    "anti_snipe_seconds",
    "reserve_price",
    "title",
    "published_at",
  ],
  auction_settlements: ["winner_dealer_id"],
  nbfc_recovery_pipeline: ["battery_id"],
};

/** PART 2 — the battery master. */
const BATTERY_COLUMNS = [
  "id",
  "tenant_id",
  "serial",
  "model",
  "capacity",
  "manufacturing_date",
  "condition_grade",
  "recovery_date",
  "warehouse",
  "lat",
  "lng",
  "city",
  "state",
  "loan_sanction_id",
  "recovery_pipeline_id",
  "image_urls",
  "state_code",
  "notes",
  "created_at",
  "updated_at",
];

const EXPECTED_INDEXES = [
  "auction_bids_bidder_dealer_idx",
  "auction_lots_seller_tenant_idx",
  "auction_lots_open_due_idx",
  "auction_lots_close_due_idx",
  "auction_settlements_winner_dealer_idx",
  "nbfc_recovery_pipeline_battery_idx",
  "recovery_batteries_tenant_idx",
  "recovery_batteries_state_idx",
];

async function columnsOf(sql, table) {
  const rows = await sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
     ORDER BY ordinal_position
  `;
  return rows;
}

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
    // ---- Pre-state. The catch-up half is the interesting one. ----
    const preExisting = {};
    for (const t of CATCHUP_TABLES) {
      const [{ r }] = await sql`SELECT to_regclass(${"public." + t}) AS r`;
      preExisting[t] = r !== null;
    }
    const [{ r: batteryPre }] = await sql`
      SELECT to_regclass('public.recovery_batteries') AS r
    `;

    console.log("PART 1 — catch-up tables, before:");
    for (const t of CATCHUP_TABLES) {
      console.log(
        `  ${preExisting[t] ? "present  (no-op)" : "ABSENT   (will be created)"}  ${t}`,
      );
    }
    const absent = CATCHUP_TABLES.filter((t) => !preExisting[t]);
    if (absent.length) {
      console.log(
        `\n  NOTE: ${absent.length} table(s) were never created on this database.`,
      );
      console.log(
        "        Without PART 1 the ALTERs in PART 3 would have aborted with 42P01.",
      );
    }
    console.log(
      `\nPART 2 — recovery_batteries ${batteryPre ? "already present" : "absent (will be created)"}\n`,
    );

    if (!CHECK_ONLY) {
      await sql.unsafe(readFileSync(FILE, "utf8"));
      console.log("· applied without error\n");
    }

    // ---- Prove it. ----
    const problems = [];

    for (const t of CATCHUP_TABLES) {
      const [{ r }] = await sql`SELECT to_regclass(${"public." + t}) AS r`;
      if (!r) problems.push(`table missing after apply: ${t}`);
    }

    const battery = await columnsOf(sql, "recovery_batteries");
    if (battery.length === 0) {
      problems.push("recovery_batteries missing after apply");
    } else {
      const missing = BATTERY_COLUMNS.filter(
        (c) => !battery.some((x) => x.column_name === c),
      );
      if (missing.length) {
        problems.push(`recovery_batteries missing column(s): ${missing.join(", ")}`);
      }
      const imageUrls = battery.find((c) => c.column_name === "image_urls");
      if (imageUrls && imageUrls.data_type !== "ARRAY") {
        problems.push(
          `recovery_batteries.image_urls should be text[], got ${imageUrls.data_type}`,
        );
      }
    }

    console.log("VERIFIED");
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const cols = await columnsOf(sql, table);
      const missing = expected.filter(
        (c) => !cols.some((x) => x.column_name === c),
      );
      if (missing.length) {
        problems.push(`${table} missing column(s): ${missing.join(", ")}`);
        console.log(`  ${table}  MISSING ${missing.join(", ")}`);
      } else {
        console.log(`  ${table}  + ${expected.join(", ")}`);
      }
    }
    console.log(`  recovery_batteries  ${battery.length} columns`);

    // bidder_kind must default to 'nbfc' — existing rows ARE nbfc bids, and a
    // wrong default would silently mislabel the entire pre-E-232 bid history.
    const bidderKind = (await columnsOf(sql, "auction_bids")).find(
      (c) => c.column_name === "bidder_kind",
    );
    if (bidderKind && !String(bidderKind.column_default ?? "").includes("nbfc")) {
      problems.push(
        `auction_bids.bidder_kind default should be 'nbfc', got ${bidderKind.column_default}`,
      );
    }

    // The dealer/loan reference columns must be varchar, NOT uuid.
    //
    // This is the assertion that would have caught the original draft of
    // E-232. `accounts.id` and `loan_sanctions.id` are character varying(255)
    // holding strings like 'ACC-ITARANG-20260409-971', so a uuid column here
    // applies and verifies perfectly and then rejects every real dealer with
    // 22P02 at the first bid — a failure that surfaces days after the
    // migration is ticked off as done.
    const dealerCols = await sql`
      SELECT table_name, column_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (   (table_name = 'auction_bids'        AND column_name = 'bidder_dealer_id')
              OR (table_name = 'auction_settlements' AND column_name = 'winner_dealer_id')
              OR (table_name = 'recovery_batteries'  AND column_name = 'loan_sanction_id'))
    `;
    for (const c of dealerCols) {
      if (c.data_type !== "character varying") {
        problems.push(
          `${c.table_name}.${c.column_name} is ${c.data_type}, must be character varying ` +
            `(accounts.id and loan_sanctions.id are varchar; a uuid column rejects every real value with 22P02)`,
        );
      }
    }
    console.log(
      `  dealer/loan id types  ${dealerCols.filter((c) => c.data_type === "character varying").length}/${dealerCols.length} varchar`,
    );

    const idx = await sql`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY(${EXPECTED_INDEXES})
    `;
    const foundIdx = idx.map((i) => i.indexname);
    const missingIdx = EXPECTED_INDEXES.filter((i) => !foundIdx.includes(i));
    console.log(`  indexes             ${foundIdx.length}/${EXPECTED_INDEXES.length}`);
    if (missingIdx.length) problems.push(`missing index(es): ${missingIdx.join(", ")}`);

    const [{ n: batteryRows }] = await sql`
      SELECT COUNT(*)::int AS n FROM recovery_batteries
    `;
    const [{ n: legacyBids }] = await sql`
      SELECT COUNT(*)::int AS n FROM auction_bids WHERE bidder_kind = 'nbfc'
    `;
    const [{ n: dealerBids }] = await sql`
      SELECT COUNT(*)::int AS n FROM auction_bids WHERE bidder_dealer_id IS NOT NULL
    `;
    const [{ n: sellerless }] = await sql`
      SELECT COUNT(*)::int AS n FROM auction_lots WHERE seller_tenant_id IS NULL
    `;
    console.log(`  recovery_batteries  ${batteryRows} rows (ships empty, as designed)`);
    console.log(`  auction_bids        ${legacyBids} legacy nbfc bids, ${dealerBids} dealer bids`);
    console.log(
      `  auction_lots        ${sellerless} lot(s) with no seller_tenant_id (pre-E-232 lots; expected)`,
    );

    if (problems.length) {
      throw new Error(`\n  - ${problems.join("\n  - ")}`);
    }

    console.log(
      `\nE-232 ${CHECK_ONLY ? "verified" : "applied and verified"} on ${host}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message ?? error);
  process.exit(1);
});
