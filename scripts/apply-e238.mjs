// Applies drizzle/E-238_offer_negotiation.sql to whatever DATABASE_URL points
// at in .env.local. Idempotent — safe to re-run:
//   node scripts/apply-e238.mjs
//
// What breaks without it, and how loudly:
//
//   LOUDLY. Unlike E-236/E-237 — whose columns are deliberately UNmirrored in
//   schema.ts and reached through raw sql so a missing column costs a feature
//   and not a page — E-238 IS mirrored, and
//   src/app/api/nbfc/offer/[leadId]/route.ts does a bare
//   db.select().from(nbfcFinancingOffers). Drizzle names every column of a
//   mirrored table in its generated SQL, so on a database without this file the
//   NBFC Acquire offer panel fails on its first read with
//   `column "negotiation_status" does not exist`. There is no degraded mode to
//   fall back to; apply it before deploying the code.
//
// Verified below rather than trusted: the four offer columns, the negotiation
// table's shape, and — the one worth asserting by hand — that
// nbfc_offer_negotiations_offer_round_uidx is genuinely UNIQUE. A non-unique
// index of the same name looks identical in a name-only check while letting two
// concurrent submits both write "round 3", which is the exact race the index
// exists to lose.
//
// TARGET SELECTION. By default this reads the ACTIVE DATABASE_URL out of
// .env.local, exactly like apply-e23x.mjs before it — but .env.local is flipped
// between database-1 (sandbox) and database-2 (PRODUCTION) by hand, and the two
// drift, so "whatever the env says" is a coin flip about which one you are
// altering. Pass an explicit target to remove the guess:
//
//   DATABASE_URL=postgresql://…database-1… node scripts/apply-e238.mjs
//
// An explicit process.env.DATABASE_URL wins over the file. The host is printed
// before anything is written either way — read it before trusting the run.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
  const env = readFileSync(".env.local", "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
  return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local" };
}

const { url, from } = resolveUrl();
const ddl = readFileSync("drizzle/E-238_offer_negotiation.sql", "utf8");

const EXPECTED_COLS = [
  "assignment_id", "conditions", "created_at", "created_by", "down_payment",
  "emi_amount", "id", "kind", "lead_id", "loan_amount", "message", "nbfc_id",
  "offer_id", "party", "processing_fee", "roi_pct", "round", "tenant_id",
  "tenure_months",
];
const EXPECTED_OFFER_COLS = ["fixed_at", "fixed_by", "negotiation_round", "negotiation_status"];

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  const host = new URL(url).hostname;
  console.log("HOST:", host, `(from ${from})`);
  console.log(
    host.startsWith("database-2")
      ? "  ^^ database-2 IS PRODUCTION."
      : host.startsWith("database-1")
        ? "  ^^ database-1 is sandbox."
        : "",
  );

  const hasOffers = await sql`SELECT to_regclass('nbfc_financing_offers') AS t`;
  if (hasOffers[0].t === null) {
    // Fail with the real reason rather than a bare 42P01 from mid-file.
    console.log("FAILED — nbfc_financing_offers does not exist on this DB (E-140 not applied). Apply E-140/E-161 first.");
    process.exit(1);
  }

  await sql.unsafe(ddl);

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'nbfc_offer_negotiations'
     ORDER BY column_name`;
  const offerCols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'nbfc_financing_offers'
       AND column_name IN ('negotiation_status', 'negotiation_round', 'fixed_at', 'fixed_by')
     ORDER BY column_name`;
  const uidx = await sql`
    SELECT indexdef FROM pg_indexes
     WHERE indexname = 'nbfc_offer_negotiations_offer_round_uidx'`;
  const rows = await sql`SELECT count(*)::int AS n FROM nbfc_offer_negotiations`;

  const got = cols.map((r) => r.column_name);
  const gotOffer = offerCols.map((r) => r.column_name);
  const missing = EXPECTED_COLS.filter((c) => !got.includes(c));
  const missingOffer = EXPECTED_OFFER_COLS.filter((c) => !gotOffer.includes(c));
  const isUnique = uidx.length === 1 && /CREATE UNIQUE INDEX/i.test(uidx[0].indexdef);

  console.log(
    missing.length === 0
      ? `OK — nbfc_offer_negotiations present with ${got.length} columns, ${rows[0].n} rows.`
      : `FAILED — nbfc_offer_negotiations missing ${JSON.stringify(missing)}.`,
  );
  console.log(
    missingOffer.length === 0
      ? "OK — nbfc_financing_offers carries negotiation_status / negotiation_round / fixed_at / fixed_by."
      : `FAILED — nbfc_financing_offers missing ${JSON.stringify(missingOffer)}.`,
  );
  console.log(
    isUnique
      ? "OK — nbfc_offer_negotiations_offer_round_uidx is genuinely UNIQUE; a double-submit will 23505 rather than duplicate a round."
      : uidx.length === 0
        ? "FAILED — nbfc_offer_negotiations_offer_round_uidx is absent."
        : `FAILED — index exists but is NOT unique: ${uidx[0].indexdef}`,
  );

  if (missing.length || missingOffer.length || !isUnique) process.exit(1);
} finally {
  await sql.end();
}
