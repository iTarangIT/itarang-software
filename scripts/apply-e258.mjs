// Applies drizzle/E-258_scrap_consignments.sql and then PROVES it landed.
//
// Usage:  DATABASE_URL=postgresql://…database-2… node scripts/apply-e258.mjs
//         DATABASE_URL=postgresql://…database-2… node scripts/apply-e258.mjs --dry-run
//
// TARGET SELECTION — READ THIS BEFORE RUNNING.
// An explicit process.env.DATABASE_URL always wins. Falling back to .env.local
// is a coin flip: that file carries BOTH the database-1 (sandbox) and
// database-2 (PRODUCTION) URLs with one commented out, it is flipped by hand,
// and the two databases drift. The host is printed, together with which
// environment that host IS, before a single byte is written.
//
// WHAT E-258 DOES. Three new tables — scrap_consignments,
// scrap_consignment_items, scrap_consignment_offers — plus one nullable column
// on recovery_batteries (scrap_consignment_id). It backs the NBFC → iTarang
// scrap sale: bundle scrapped batteries, photograph them, negotiate a rate per
// battery, pay by RazorpayX payout (or record an offline transfer), transfer
// the lot.
//
// It is REQUIRED before the code deploys. All three tables are mirrored in
// schema.ts and read with a bare db.select(), and Drizzle names every column
// of a mirrored table in its generated SQL — so without this file the scrap
// desk fails with `relation "scrap_consignments" does not exist`, and the
// battery register fails with `column "scrap_consignment_id" does not exist`
// (that column is on recovery_batteries, which EXISTING screens already read).
//
// THE ONE INDEX THAT IS NOT DECORATION.
// scrap_consignment_items_open_battery_uidx is a PARTIAL UNIQUE index on
// (battery_id) WHERE is_open — it is what makes it impossible to sell the same
// battery to iTarang twice. Drizzle's index builder cannot express a WHERE
// clause, so this migration is its ONLY source and the verification below
// checks the predicate rather than just the name.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-258_scrap_consignments.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** Tables E-258 depends on. A missing one means E-232 was never applied here. */
const PREREQ_TABLES = ["recovery_batteries", "nbfc_recovery_pipeline", "nbfc_tenants"];

/** Every table this file must create. */
const EXPECTED_TABLES = [
    "scrap_consignments",
    "scrap_consignment_items",
    "scrap_consignment_offers",
];

/** A representative column from each new table, plus the one added column. */
const EXPECTED_COLUMNS = [
    ["scrap_consignments", "ref_code", "character varying"],
    ["scrap_consignments", "status", "character varying"],
    ["scrap_consignments", "agreed_rate_per_battery", "numeric"],
    ["scrap_consignments", "agreed_amount", "numeric"],
    ["scrap_consignments", "payment_status", "character varying"],
    ["scrap_consignments", "payee_ifsc", "character varying"],
    ["scrap_consignments", "photo_urls", "ARRAY"],
    ["scrap_consignment_items", "battery_id", "uuid"],
    ["scrap_consignment_items", "is_open", "boolean"],
    ["scrap_consignment_offers", "round", "integer"],
    ["scrap_consignment_offers", "party", "character varying"],
    ["scrap_consignment_offers", "rate_per_battery", "numeric"],
    ["recovery_batteries", "scrap_consignment_id", "uuid"],
];

/** Plain indexes — name presence is enough. */
const INDEXES = [
    "scrap_consignments_ref_uidx",
    "scrap_consignments_tenant_idx",
    "scrap_consignments_status_idx",
    "scrap_consignment_items_consignment_idx",
    "scrap_consignment_items_battery_idx",
    "scrap_consignment_items_uidx",
    "scrap_consignment_offers_round_uidx",
    "scrap_consignment_offers_consignment_idx",
    "recovery_batteries_scrap_consignment_idx",
];

/** Indexes whose PREDICATE carries the rule — checked, not assumed. */
const PARTIAL_INDEXES = [
    {
        name: "scrap_consignment_items_open_battery_uidx",
        mustMatch: /\bWHERE\b.*\bis_open\b/is,
        why: "one battery may sit in at most ONE open consignment",
    },
    {
        name: "scrap_consignments_open_idx",
        mustMatch: /\bWHERE\b.*\bstatus\b/is,
        why: "the admin inbox's default 'what is still live' scan",
    },
];

/** Refuse to run a file that mutates data or narrows a type. */
function assertAdditive(sqlText) {
    const stripped = sqlText
        .replace(/\$c\$[\s\S]*?\$c\$/g, "''")
        .replace(/--[^\n]*/g, "");
    const forbidden = [
        /\bDROP\s+COLUMN\b/i,
        /\bDROP\s+TABLE\b/i,
        /\bDROP\s+INDEX\b/i,
        /\bTRUNCATE\b/i,
        /\bDELETE\s+FROM\b/i,
        /\bINSERT\s+INTO\b/i,
        /\bUPDATE\s+\w+\s+SET\b/i,
        /\bALTER\s+TYPE\b/i,
        /\bSET\s+NOT\s+NULL\b/i,
        /\bRENAME\b/i,
    ];
    const hits = forbidden.filter((re) => re.test(stripped)).map((re) => String(re));
    if (hits.length) {
        console.log("REFUSING TO RUN — non-additive statement(s) found:", hits.join(", "));
        process.exit(1);
    }
}

const { url, from } = resolveUrl();
const ddl = readFileSync(FILE, "utf8");
assertAdditive(ddl);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 20 });
let failed = false;

try {
    const host = new URL(url).hostname;
    console.log("HOST:", host, `(from ${from})`);
    console.log(
        host.startsWith("database-2")
            ? "  ^^ database-2 IS PRODUCTION."
            : host.startsWith("database-1")
              ? "  ^^ database-1 is sandbox."
              : "  ^^ UNRECOGNISED HOST — stop and check before proceeding.",
    );
    console.log(DRY_RUN ? "MODE: dry run (nothing will be written)\n" : "MODE: APPLY\n");

    for (const t of PREREQ_TABLES) {
        const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
        if (r === null) {
            console.log(`FAILED — ${t} does not exist on this DB. Apply E-232 first, or check the database.`);
            process.exit(1);
        }
    }
    console.log(`OK — all ${PREREQ_TABLES.length} prerequisite tables present.`);

    let beforeTables = 0;
    for (const t of EXPECTED_TABLES) {
        const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
        if (r !== null) beforeTables++;
    }
    console.log(`Tables already present before this run: ${beforeTables}/${EXPECTED_TABLES.length}`);

    if (DRY_RUN) {
        console.log("\nDry run — file parsed and passed the additive guard. Nothing written.");
        await sql.end({ timeout: 5 });
        process.exit(0);
    }

    await sql.unsafe(ddl);
    console.log("Migration executed. Verifying...\n");

    for (const t of EXPECTED_TABLES) {
        const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
        console.log(r !== null ? `OK — table ${t}` : `FAILED — table ${t} is MISSING.`);
        if (r === null) failed = true;
    }

    for (const [table, column, expectedType] of EXPECTED_COLUMNS) {
        const [row] = await sql`
            SELECT data_type, column_default
              FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
        if (!row) {
            console.log(`FAILED — ${table}.${column} is MISSING.`);
            failed = true;
            continue;
        }
        const typeOk = row.data_type === expectedType;
        console.log(
            typeOk
                ? `OK — ${table}.${column} (${row.data_type}${row.column_default ? `, default ${row.column_default}` : ""})`
                : `FAILED — ${table}.${column} is ${row.data_type}, expected ${expectedType}.`,
        );
        if (!typeOk) failed = true;
    }

    for (const name of INDEXES) {
        const [idx] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${name}`;
        console.log(idx ? `OK — index ${name}` : `FAILED — index ${name} is MISSING.`);
        if (!idx) failed = true;
    }

    for (const { name, mustMatch, why } of PARTIAL_INDEXES) {
        const [idx] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${name}`;
        if (!idx) {
            console.log(`FAILED — partial index ${name} is MISSING (${why}).`);
            failed = true;
            continue;
        }
        const ok = mustMatch.test(idx.indexdef);
        console.log(
            ok
                ? `OK — ${name} exists and is genuinely PARTIAL (${why}).`
                : `FAILED — ${name} exists but its predicate is wrong: ${idx.indexdef}`,
        );
        if (!ok) failed = true;
    }

    // No backfill ships with this file, on purpose. This is the number that
    // says whether the feature has anything to work on yet.
    const [{ scrap_batteries }] = await sql`
        SELECT count(*)::int AS scrap_batteries
          FROM recovery_batteries b
          LEFT JOIN nbfc_recovery_pipeline p ON p.id = b.recovery_pipeline_id
         WHERE b.state_code = 'scrapped' OR p.stage = 'scrap'`;
    console.log(
        `\nScrap batteries already sellable on this DB: ${scrap_batteries}.`,
    );
    console.log(
        scrap_batteries === 0
            ? "  Expected on a fresh DB — a battery becomes sellable once its recovery row reaches 'scrap'."
            : "  These appear in the NBFC's scrap picker immediately.",
    );

    if (failed) {
        console.log("\nE-258 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-258 applied and verified. Pure additive DDL — no row was read or written.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
