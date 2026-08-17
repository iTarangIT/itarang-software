// Applies drizzle/E-241_offer_close_vocabulary.sql to whatever DATABASE_URL
// points at in .env.local. Idempotent — safe to re-run:
//   node scripts/apply-e241.mjs
//
// What breaks without it, and how loudly:
//
//   NOTHING. This is the quiet one in the series. E-241 is COMMENT-ONLY — no
//   DDL, no data, no constraint. The four values its feature introduces
//   (nbfc_offer_negotiations.kind='close', negotiation_status='closed', and
//   'withdrawn' on both nbfc_financing_offers.status and
//   nbfc_lead_assignments.status) are ALREADY legal on every database: the first
//   two because E-238 deliberately ships no CHECK on party/kind/
//   negotiation_status, the latter two because the E-131 and E-140 CHECKs have
//   permitted 'withdrawn' since they were written. Skipping this file costs you
//   accurate COMMENTs in the catalogue and nothing else.
//
//   That is precisely why it is worth applying anyway: without it the E-238
//   COMMENTs still enumerate the OLD value sets, and the next person reading the
//   catalogue is told that 'close'/'closed' are corruption.
//
// Verified below rather than trusted, because a comment-only migration has no
// other observable effect: the four COMMENTs are read back out of
// obj_description/col_description and checked for the E-241 marker. The CHECK
// constraints the feature relies on are asserted too — if a database somehow
// lacks 'withdrawn' in either, the close flow would 23514 at runtime, and this
// is the cheapest place to find that out.
//
// TARGET SELECTION. By default this reads the ACTIVE DATABASE_URL out of
// .env.local — but .env.local is flipped between database-1 (sandbox) and
// database-2 (PRODUCTION) by hand, and the two drift, so "whatever the env says"
// is a coin flip about which one you are altering. Pass an explicit target to
// remove the guess:
//
//   DATABASE_URL=postgresql://…database-1… node scripts/apply-e241.mjs
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
const ddl = readFileSync("drizzle/E-241_offer_close_vocabulary.sql", "utf8");

/** The four columns this migration re-documents, and what must appear in each. */
const EXPECTED_COMMENTS = [
  { table: "nbfc_offer_negotiations", column: "kind", needle: "close (dealer ended the deal" },
  { table: "nbfc_financing_offers", column: "negotiation_status", needle: "closed (the dealer ended the deal" },
  { table: "nbfc_financing_offers", column: "status", needle: "E-140/E-241" },
  { table: "nbfc_lead_assignments", column: "status", needle: "dealer_closed_deal" },
];

/** Values the close flow writes that a CHECK could reject at runtime. */
const REQUIRED_CHECK_VALUES = [
  { table: "nbfc_financing_offers", column: "status", value: "withdrawn" },
  { table: "nbfc_lead_assignments", column: "status", value: "withdrawn" },
];

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
let failed = false;
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

  // Fail with the real reason rather than a bare 42P01 from mid-file.
  for (const t of ["nbfc_offer_negotiations", "nbfc_financing_offers", "nbfc_lead_assignments"]) {
    const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
    if (r === null) {
      console.log(`FAILED — ${t} does not exist on this DB. Apply E-131 / E-140 / E-238 first.`);
      process.exit(1);
    }
  }

  await sql.unsafe(ddl);

  for (const { table, column, needle } of EXPECTED_COMMENTS) {
    const [row] = await sql`
      SELECT col_description(c.oid, a.attnum) AS comment
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE c.relname = ${table} AND a.attname = ${column}`;
    const ok = typeof row?.comment === "string" && row.comment.includes(needle);
    console.log(
      ok
        ? `OK — ${table}.${column} COMMENT carries the E-241 wording.`
        : `FAILED — ${table}.${column} COMMENT is missing "${needle}" (got: ${row?.comment ?? "NULL"}).`,
    );
    if (!ok) failed = true;
  }

  // Not written by this file, but the whole feature rests on them. A database
  // whose CHECK predates the 'withdrawn' value would take the close flow down
  // with a 23514 the first time a dealer clicks Close deal.
  for (const { table, column, value } of REQUIRED_CHECK_VALUES) {
    const [row] = await sql`
      SELECT bool_or(pg_get_constraintdef(con.oid) LIKE ${"%" + column + "%" + value + "%"}) AS ok
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE con.contype = 'c' AND rel.relname = ${table}`;
    const ok = row?.ok === true;
    console.log(
      ok
        ? `OK — ${table}.${column} CHECK permits '${value}' (pre-existing; E-241 adds no constraint).`
        : `FAILED — ${table}.${column} CHECK does NOT permit '${value}'. The Close deal flow will 23514 on this DB.`,
    );
    if (!ok) failed = true;
  }

  if (failed) process.exit(1);
  console.log("\nE-241 applied. Comment-only — no DDL ran, no rows changed.");
} finally {
  await sql.end();
}
