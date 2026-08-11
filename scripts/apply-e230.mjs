// Applies drizzle/E-230_oem_price_validity.sql to whatever DATABASE_URL points
// at in .env.local. Idempotent — safe to re-run:
//
//   node scripts/apply-e230.mjs --check    read-only: report state, write nothing
//   node scripts/apply-e230.mjs            apply, then verify
//
// WHY THIS ONE IS URGENT RATHER THAN TIDY-UP. Unlike most of this family, an
// unapplied E-230 breaks the READ path, not just writes: listOemCatalogue() and
// listExpiringOemPrices() both name valid_until explicitly, so /oem-pricing
// renders "Couldn't load the OEM price book" and the six-hourly sweep logs a
// failed query every tick. There is no degraded mode — E-226's table is simply
// missing two columns the E-230 code requires.
//
// WHAT IT CHANGES, AND THE ONE THING TO LOOK AT
//   + oem_reference_prices.valid_until        (nullable — NULL means open-ended,
//   + oem_reference_prices.expiry_notified_at  which is what every existing row
//                                              already meant, so no row changes
//                                              behaviour)
//   - DROP INDEX oem_reference_prices_live_uniq
//   + CREATE UNIQUE INDEX oem_reference_prices_open_from_uniq
//                                             (asset_type, product_id,
//                                              effective_from) WHERE effective_to
//                                              IS NULL
//   + oem_reference_prices_expiry_idx          partial, feeds the sweep
//
// The index swap is the only non-additive statement in the file. It drops no
// data and no column, and both statements are inside one BEGIN/COMMIT, so there
// is no instant at which a product could acquire two same-start live rows. What
// it deliberately makes legal is two OPEN rows with DIFFERENT starts — the price
// in force plus the one queued behind it, which is the whole point of E-230.
//
// The pre-apply row count is printed so the "no existing row changes behaviour"
// claim is checkable rather than asserted: every one of them should still read
// valid_until IS NULL afterwards.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const CHECK_ONLY = process.argv.includes("--check");

// Which key of .env.local to connect through. Defaults to DATABASE_URL, so the
// documented invocations above are unchanged. The override exists because this
// repo has two live DBs that drift (database-1 = sandbox, database-2 = prod) and
// only ONE of them is ever in DATABASE_URL: without it, targeting the other
// means editing DATABASE_URL in place, which silently repoints the dev server
// and the BullMQ worker at production for as long as the edit is there. Add a
// second key (e.g. DATABASE_URL_DB2=...) and pass --env-key=DATABASE_URL_DB2.
// The value stays in .env.local rather than on argv, where it would be visible
// in the process list and shell history.
const ENV_KEY =
  process.argv.find((a) => a.startsWith("--env-key="))?.split("=")[1] ??
  "DATABASE_URL";

const env = readFileSync(".env.local", "utf8");
const found = env.match(new RegExp(`^${ENV_KEY}=(.*)$`, "m"));
if (!found) {
  console.error(`FAILED — no ${ENV_KEY} in .env.local.`);
  process.exit(1);
}
const url = found[1].trim().replace(/^["']|["']$/g, "");
const ddl = readFileSync("drizzle/E-230_oem_price_validity.sql", "utf8");

const sql = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  connect_timeout: 15,
});

/** The four things E-230 is responsible for, read straight from the catalog. */
async function state() {
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'oem_reference_prices'
       AND column_name IN ('valid_until', 'expiry_notified_at')
     ORDER BY column_name`;

  const idx = await sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'oem_reference_prices'
       AND indexname IN ('oem_reference_prices_live_uniq',
                         'oem_reference_prices_open_from_uniq',
                         'oem_reference_prices_expiry_idx')
     ORDER BY indexname`;

  const table = await sql`SELECT to_regclass('oem_reference_prices') AS t`;

  return {
    exists: table[0].t !== null,
    cols: cols.map((r) => r.column_name),
    idx: idx.map((r) => r.indexname),
  };
}

try {
  console.log("HOST:", new URL(url).hostname);

  const before = await state();

  // E-226 is the parent. Without it the first ALTER in the file errors, and
  // saying so plainly beats a raw 42P01 from three statements in.
  if (!before.exists) {
    console.log(
      "FAILED — oem_reference_prices does not exist on this DB. E-230 extends " +
        "E-226; apply drizzle/E-226_oem_reference_prices.sql first.",
    );
    process.exit(1);
  }

  // Counted before the DDL so the claim "no existing row changes behaviour" is
  // verifiable: all of these must still read valid_until IS NULL afterwards.
  const [{ count: rowsBefore }] = await sql`
    SELECT count(*)::int AS count FROM oem_reference_prices`;
  const [{ count: openBefore }] = await sql`
    SELECT count(*)::int AS count FROM oem_reference_prices
     WHERE effective_to IS NULL`;

  console.log(
    `BEFORE — columns ${JSON.stringify(before.cols)}, ` +
      `indexes ${JSON.stringify(before.idx)}, ` +
      `${rowsBefore} price row(s), ${openBefore} open.`,
  );

  if (CHECK_ONLY) {
    const done =
      before.cols.length === 2 &&
      before.idx.includes("oem_reference_prices_open_from_uniq");
    console.log(
      done
        ? "CHECK — E-230 is already applied here. Nothing to do."
        : "CHECK — E-230 is NOT applied here. /oem-pricing will 500 on load and " +
            "the oem-price-sweep ticker will log a failed query every tick. " +
            "Re-run without --check to apply.",
    );
    await sql.end();
    process.exit(0);
  }

  await sql.unsafe(ddl);

  const after = await state();

  const [{ count: rowsAfter }] = await sql`
    SELECT count(*)::int AS count FROM oem_reference_prices`;
  // The load-bearing check: E-230 backfills nothing, so every pre-existing row
  // must still be open-ended. A non-zero count here would mean the file had
  // dated rows nobody chose dates for, and the expiry sweep would start
  // notifying about them.
  const [{ count: dated }] = await sql`
    SELECT count(*)::int AS count FROM oem_reference_prices
     WHERE valid_until IS NOT NULL`;

  const colsOk = after.cols.length === 2;
  const idxOk =
    after.idx.includes("oem_reference_prices_open_from_uniq") &&
    after.idx.includes("oem_reference_prices_expiry_idx") &&
    !after.idx.includes("oem_reference_prices_live_uniq");

  console.log(
    colsOk
      ? "OK — oem_reference_prices.valid_until + .expiry_notified_at present; " +
          "prices can now carry a validity window and a queued successor."
      : `FAILED — expected both columns, got ${JSON.stringify(after.cols)}.`,
  );
  console.log(
    idxOk
      ? "OK — live_uniq swapped for open_from_uniq, expiry_idx created; a " +
          "product may now hold the price in force plus one scheduled behind it."
      : `FAILED — index state is ${JSON.stringify(after.idx)}; expected ` +
          `open_from_uniq + expiry_idx present and live_uniq gone.`,
  );
  console.log(
    rowsAfter === rowsBefore && dated === 0
      ? `OK — no backfill: all ${rowsAfter} existing price row(s) still read ` +
          `valid_until IS NULL, i.e. open-ended, which is exactly what they ` +
          `meant under E-226. No existing price changed behaviour.`
      : `CHECK THIS — ${rowsBefore} row(s) before, ${rowsAfter} after, ${dated} ` +
          `now carrying a valid_until. E-230 backfills nothing, so both numbers ` +
          `should be unchanged and dated should be 0.`,
  );

  if (!colsOk || !idxOk) process.exit(1);
} catch (err) {
  console.error("FAILED —", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
