/**
 * Applies drizzle/E-234_auction_lot_items_visibility_audience.sql and verifies.
 *
 *   node --env-file=.env.local scripts/apply-e234.mjs
 *   node --env-file=.env.local scripts/apply-e234.mjs --check
 *
 * DEPENDS ON E-232.
 *
 * Two checks here are worth more than "the tables exist":
 *
 *   1. `auction_lot_audience.dealer_id` must be character varying. It points at
 *      accounts.id, which holds strings like 'ACC-ITARANG-20260409-971'. A uuid
 *      column applies and verifies perfectly and then rejects every real dealer
 *      with 22P02 at publish time. E-232 shipped exactly that bug once already.
 *
 *   2. The UNIQUE on (lot_id, battery_id) must exist. Without it a double-click
 *      on "add to lot" silently doubles the quantity and the base price, and
 *      nothing downstream can tell that from a genuine two-of-a-kind pallet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const FILE = join(
  process.cwd(),
  "drizzle",
  "E-234_auction_lot_items_visibility_audience.sql",
);
const CHECK_ONLY = process.argv.includes("--check");

const TABLES = {
  auction_lot_items: [
    "id",
    "lot_id",
    "battery_id",
    "condition",
    "item_price",
    "created_at",
  ],
  auction_lot_visibility: [
    "lot_id",
    "scope",
    "states",
    "cities",
    "centre_lat",
    "centre_lng",
    "radius_km",
    "created_at",
  ],
  auction_lot_audience: [
    "id",
    "lot_id",
    "dealer_id",
    "dealer_name",
    "city",
    "state",
    "distance_km",
    "channel",
    "status",
    "sent_at",
    "error",
    "created_at",
  ],
};

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
    const [{ r: e232 }] = await sql`
      SELECT to_regclass('public.recovery_batteries') AS r
    `;
    if (!e232) {
      throw new Error(
        "E-232 has not been applied to this database (recovery_batteries is missing). Apply scripts/apply-e232.mjs first.",
      );
    }

    for (const t of Object.keys(TABLES)) {
      const [{ r }] = await sql`SELECT to_regclass(${"public." + t}) AS r`;
      console.log(`· ${t} ${r ? "already present" : "absent — creating"}`);
    }

    if (!CHECK_ONLY) {
      await sql.unsafe(readFileSync(FILE, "utf8"));
      console.log("\n· applied without error");
    }

    const problems = [];
    console.log("\nVERIFIED");

    for (const [table, expected] of Object.entries(TABLES)) {
      const cols = await sql`
        SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table}
      `;
      if (cols.length === 0) {
        problems.push(`${table} missing after apply`);
        console.log(`  ${table}  MISSING`);
        continue;
      }
      const missing = expected.filter(
        (c) => !cols.some((x) => x.column_name === c),
      );
      if (missing.length) {
        problems.push(`${table} missing column(s): ${missing.join(", ")}`);
      }
      console.log(`  ${table}  ${cols.length} columns`);
    }

    // (1) dealer_id must be varchar, not uuid.
    const [dealerCol] = await sql`
      SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'auction_lot_audience'
         AND column_name = 'dealer_id'
    `;
    if (dealerCol && dealerCol.data_type !== "character varying") {
      problems.push(
        `auction_lot_audience.dealer_id is ${dealerCol.data_type}, must be character varying ` +
          `(accounts.id holds strings like 'ACC-ITARANG-20260409-971'; uuid rejects every real dealer with 22P02)`,
      );
    }
    console.log(
      `  dealer_id type       ${dealerCol?.data_type ?? "?"} ${dealerCol?.data_type === "character varying" ? "✓" : "✗"}`,
    );

    // (2) the two uniques that stop silent duplication.
    const uniques = await sql`
      SELECT conname FROM pg_constraint
       WHERE contype = 'u'
         AND conname IN ('auction_lot_items_lot_battery_key',
                         'auction_lot_audience_lot_dealer_channel_key')
    `;
    const found = uniques.map((u) => u.conname);
    for (const want of [
      "auction_lot_items_lot_battery_key",
      "auction_lot_audience_lot_dealer_channel_key",
    ]) {
      if (!found.includes(want)) problems.push(`missing unique constraint: ${want}`);
    }
    console.log(`  unique constraints   ${found.length}/2`);

    // (3) auction_auto_bids must carry a dealer column AND the re-keyed unique
    //     index. Without both, the proxy engine cannot tell whose standing
    //     order is whose, and E-093's (lot_id, tenant_id) index lets the second
    //     dealer to set a maximum on a lot silently cancel the first one's —
    //     because after the E-232 re-point every dealer bid on a lot carries
    //     the SELLER's tenant_id.
    const [autoDealer] = await sql`
      SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'auction_auto_bids'
         AND column_name = 'bidder_dealer_id'
    `;
    if (!autoDealer) {
      problems.push("auction_auto_bids.bidder_dealer_id missing");
    } else if (autoDealer.data_type !== "character varying") {
      problems.push(
        `auction_auto_bids.bidder_dealer_id is ${autoDealer.data_type}, must be character varying`,
      );
    }

    const autoIdx = await sql`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('auction_auto_bids_lot_bidder_active_uidx',
                           'auction_auto_bids_lot_tenant_active_uidx')
    `;
    const hasNew = autoIdx.some(
      (i) => i.indexname === "auction_auto_bids_lot_bidder_active_uidx",
    );
    const hasOld = autoIdx.some(
      (i) => i.indexname === "auction_auto_bids_lot_tenant_active_uidx",
    );
    if (!hasNew) problems.push("missing index: auction_auto_bids_lot_bidder_active_uidx");
    // The swap is the half worth confirming. A database left holding the E-093
    // index still refuses a second dealer's standing order on the same lot,
    // which is exactly the bug this migration exists to remove.
    if (hasOld) {
      problems.push(
        "auction_auto_bids_lot_tenant_active_uidx still present — the index swap did not complete, " +
          "so a second dealer still cannot set a standing maximum on a lot another dealer is bidding on",
      );
    }
    console.log(
      `  auto-bid dealer key  column ${autoDealer ? "✓" : "✗"}, new index ${hasNew ? "✓" : "✗"}, old index ${hasOld ? "STILL PRESENT ✗" : "dropped ✓"}`,
    );

    const [pending] = await sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'auction_lot_audience_pending_idx'
    `;
    if (!pending) problems.push("missing index: auction_lot_audience_pending_idx");
    else if (!/WHERE/i.test(pending.indexdef)) {
      problems.push("auction_lot_audience_pending_idx exists but is not partial");
    }
    console.log(
      `  pending fan-out idx  ${pending ? (/WHERE/i.test(pending.indexdef) ? "partial ✓" : "NOT PARTIAL") : "MISSING"}`,
    );

    const [{ n: items }] = await sql`SELECT COUNT(*)::int AS n FROM auction_lot_items`;
    const [{ n: aud }] = await sql`SELECT COUNT(*)::int AS n FROM auction_lot_audience`;
    console.log(`  rows                 items=${items} audience=${aud} (ship empty)`);

    if (problems.length) throw new Error(`\n  - ${problems.join("\n  - ")}`);

    console.log(
      `\nE-234 ${CHECK_ONLY ? "verified" : "applied and verified"} on ${host}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message ?? error);
  process.exit(1);
});
