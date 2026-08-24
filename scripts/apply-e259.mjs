// Applies drizzle/E-259_scrap_payment_terms.sql and then PROVES it landed.
//
// Same shape as scripts/apply-e258.mjs, which this migration extends: print
// the target host and say plainly which environment it is, refuse any
// non-additive statement, run the file, then read every table, column,
// constraint and index back out of information_schema / pg_indexes rather
// than trusting that "no error" meant "applied".
//
// WHAT E-259 DOES. One new table — nbfc_scrap_payment_settings, the per-NBFC
// answer to "do we pay before the batteries arrive or after" — plus two
// nullable columns on scrap_consignments (received_at, received_by) recording
// the arrival that a post_lot term waits on.
//
// WHY IT IS REQUIRED BEFORE THE CODE DEPLOYS. received_at is selected by the
// bare db.select() behind every scrap consignment read, so an unapplied
// environment fails the Scrap Purchase desk and the NBFC's Scrap Sales page
// with `column "received_at" does not exist`, and getScrapPaymentTiming()
// 500s on the missing table instead of falling back to the default.
//
// NO BACKFILL, ON PURPOSE. An NBFC with no settings row reads as 'post_lot'
// (the safer term) and the settings screen shows that as a default rather
// than as a decision nobody took. Inserting a row per tenant would erase that
// distinction, which is why the additive guard below also refuses INSERT.
//
//   node scripts/apply-e259.mjs --dry-run
//   node scripts/apply-e259.mjs
//
// DATABASE_URL in the environment wins over .env.local, so the host can be
// pinned explicitly for a run against sandbox or production.

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-259_scrap_payment_terms.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** A missing one means E-258 was never applied here. */
const PREREQ_TABLES = ["scrap_consignments", "nbfc_tenants"];

/** Every table this file must create. */
const EXPECTED_TABLES = ["nbfc_scrap_payment_settings"];

const EXPECTED_COLUMNS = [
    ["nbfc_scrap_payment_settings", "tenant_id", "uuid"],
    ["nbfc_scrap_payment_settings", "payment_timing", "character varying"],
    ["nbfc_scrap_payment_settings", "note", "text"],
    ["nbfc_scrap_payment_settings", "updated_by", "uuid"],
    ["scrap_consignments", "received_at", "timestamp with time zone"],
    ["scrap_consignments", "received_by", "uuid"],
];

const INDEXES = ["nbfc_scrap_payment_settings_tenant_uidx"];

/**
 * The CHECK is the only thing keeping a third, unhandled timing out of the
 * column — coerce() in payment-settings.ts would silently read it as the
 * default — so its presence is verified, not assumed.
 */
const CONSTRAINTS = [
    {
        name: "nbfc_scrap_payment_settings_timing_chk",
        mustMatch: /pre_lot/i,
        why: "payment_timing is restricted to pre_lot | post_lot",
    },
];

/** Refuse to run a file that mutates data or narrows a type. */
function assertAdditive(sqlText) {
    const stripped = sqlText
        .replace(/\$do\$[\s\S]*?\$do\$/g, "''")
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
            console.log(`FAILED — ${t} does not exist on this DB. Apply E-258 first, or check the database.`);
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

    for (const { name, mustMatch, why } of CONSTRAINTS) {
        const [row] = await sql`
            SELECT pg_get_constraintdef(oid) AS def
              FROM pg_constraint
             WHERE conname = ${name}`;
        if (!row) {
            console.log(`FAILED — constraint ${name} is MISSING (${why}).`);
            failed = true;
            continue;
        }
        const ok = mustMatch.test(row.def);
        console.log(
            ok
                ? `OK — ${name} present (${why}).`
                : `FAILED — ${name} exists but reads: ${row.def}`,
        );
        if (!ok) failed = true;
    }

    // No backfill ships with this file, on purpose — every NBFC without a row
    // is read as post_lot. This is the number that says how many are still on
    // the default rather than on a term somebody chose.
    const [{ tenants }] = await sql`SELECT count(*)::int AS tenants FROM nbfc_tenants`;
    const [{ decided }] = await sql`SELECT count(*)::int AS decided FROM nbfc_scrap_payment_settings`;
    console.log(
        `\nNBFCs: ${tenants} total, ${decided} with a term set, ${tenants - decided} on the post_lot default.`,
    );
    console.log("  Set a term at Settings → NBFC → Payments.");

    if (failed) {
        console.log("\nE-259 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-259 applied and verified. Pure additive DDL — no row was read or written.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
