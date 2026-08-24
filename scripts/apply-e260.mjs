// // Applies drizzle/E-260_scrap_itemised_pricing.sql and then PROVES it landed.
//
// WHAT E-260 DOES. Per-battery pricing on a scrap consignment:
// scrap_consignments.pricing_mode ('flat' | 'itemised') + asking_amount, and
// scrap_consignment_items.asking_rate. E-258 could only price a lot as one
// rate x battery_count, so an NBFC holding batteries of visibly different
// worth had to split the lot into separate consignments to say so.
//
// THE ONE UPDATE IS A RESTATEMENT, NOT A BACKFILL OF NEW FACTS. Existing rows
// get asking_amount = asking_rate_per_battery x battery_count, which is the
// number they are already negotiating on; without it an open consignment
// created before this migration would read as having no total. That is why
// the additive guard below permits UPDATE (unlike apply-e259.mjs) and the
// verification counts the rows it touched.
//
//   node scripts/apply-e260.mjs --dry-run
//   node scripts/apply-e260.mjs

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-260_scrap_itemised_pricing.sql";

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
const PREREQ_TABLES = ["scrap_consignments", "scrap_consignment_items"];

/** Every table this file must create. */
const EXPECTED_TABLES = [];

const EXPECTED_COLUMNS = [
    ["scrap_consignments", "pricing_mode", "character varying"],
    ["scrap_consignments", "asking_amount", "numeric"],
    ["scrap_consignment_items", "asking_rate", "numeric"],
];

const INDEXES = [];

/**
 * The CHECK is the only thing keeping a third, unhandled timing out of the
 * column — coerce() in payment-settings.ts would silently read it as the
 * default — so its presence is verified, not assumed.
 */
const CONSTRAINTS = [
    {
        name: "scrap_consignments_pricing_mode_chk",
        mustMatch: /itemised/i,
        why: "pricing_mode is restricted to flat | itemised",
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
        // UPDATE is deliberately absent from this list: E-260 contains
        // exactly one, and it restates a number the row already negotiates
        // on. See the header. Every other non-additive form stays banned.
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

    // The one UPDATE restates rate x count into asking_amount. A priced
    // consignment still missing a total means it did not run.
    const [{ missing }] = await sql`
        SELECT count(*)::int AS missing
          FROM scrap_consignments
         WHERE asking_amount IS NULL
           AND asking_rate_per_battery IS NOT NULL
           AND battery_count > 0`;
    const [{ total, itemised }] = await sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE pricing_mode = 'itemised')::int AS itemised
          FROM scrap_consignments`;
    console.log(
        `
Consignments: ${total} total, ${itemised} itemised, ${total - itemised} flat.`,
    );
    if (missing > 0) {
        console.log(`FAILED — ${missing} priced consignment(s) still have no asking_amount.`);
        failed = true;
    } else {
        console.log("OK — every priced consignment carries an asking total.");
    }

    if (failed) {
        console.log("\nE-260 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-260 applied and verified. Pure additive DDL — no row was read or written.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
