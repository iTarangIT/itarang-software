// Applies drizzle/E-263_recovery_visit_attempts.sql and then PROVES it landed.
//
// WHAT E-263 DOES. Records the doorstep the agent reached and nobody answered:
// one append-only row per journey that did not produce a battery, each with its
// own GPS fix, plus when the agent said they would return.
//
// E-262 modelled a collection as one event, so an agent who drove out and found
// the customer absent had two options in the UI — claim a collection that did
// not happen, or do nothing. "Do nothing" is indistinguishable from never
// having left, which made the work invisible exactly when somebody needed proof
// it had been done.
//
// REQUIRED BEFORE THE CODE DEPLOYS. `recovery_assignments` gains two columns
// and is read with a bare db.select() on the Recovery queue, so an unapplied
// environment fails that page with `column "next_visit_at" does not exist`.
//
// No DML, no backfill — there is no history of visits to reconstruct.
//
//   node scripts/apply-e263.mjs --dry-run
//   node scripts/apply-e263.mjs

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-263_recovery_visit_attempts.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** A missing one means E-262 was never applied here. */
const PREREQ_TABLES = ["recovery_assignments"];

const EXPECTED_TABLES = ["recovery_visit_attempts"];

const EXPECTED_COLUMNS = [
    ["recovery_visit_attempts", "assignment_id", "uuid"],
    ["recovery_visit_attempts", "tenant_id", "uuid"],
    ["recovery_visit_attempts", "attempt_no", "integer"],
    ["recovery_visit_attempts", "outcome", "character varying"],
    ["recovery_visit_attempts", "gps_lat", "numeric"],
    ["recovery_visit_attempts", "gps_server_timestamp", "timestamp with time zone"],
    ["recovery_visit_attempts", "distance_from_address_m", "numeric"],
    ["recovery_visit_attempts", "notes", "text"],
    ["recovery_visit_attempts", "next_visit_at", "timestamp with time zone"],
    ["recovery_assignments", "next_visit_at", "timestamp with time zone"],
    ["recovery_assignments", "visit_attempt_count", "integer"],
];

const PLAIN_INDEXES = [
    "recovery_visit_attempts_assignment_idx",
    "recovery_visit_attempts_tenant_idx",
    "recovery_visit_attempts_no_unique",
];

/**
 * Verified by predicate, not by name. `recovery_assignments_next_visit_idx`
 * without its WHERE would index every row including the ones with no return
 * visit — a different index answering a different question.
 */
const PARTIAL_INDEXES = [
    {
        name: "recovery_assignments_next_visit_idx",
        mustMatch: /\(tenant_id, next_visit_at\).*WHERE.*next_visit_at IS NOT NULL/is,
        why: "the queue's 'who is overdue for a return visit' view",
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
            console.log(`FAILED — ${t} does not exist on this DB. Apply E-262 first.`);
            process.exit(1);
        }
    }
    console.log(`OK — all ${PREREQ_TABLES.length} prerequisite tables present.`);

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

    for (const name of PLAIN_INDEXES) {
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
                ? `OK — ${name} present WITH its predicate (${why}).`
                : `FAILED — ${name} exists but reads: ${idx.indexdef}`,
        );
        if (!ok) failed = true;
    }

    const [{ open }] = await sql`
        SELECT count(*)::int AS open
          FROM recovery_assignments
         WHERE is_current AND status IN ('assigned', 'in_progress', 'collected')`;
    const [{ visits }] = await sql`SELECT count(*)::int AS visits FROM recovery_visit_attempts`;
    console.log(`\nOpen collection jobs: ${open}. Visits logged: ${visits}.`);
    console.log("  An agent who finds nobody home can now say so from the same link.");

    if (failed) {
        console.log("\nE-263 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-263 applied and verified. Pure additive DDL — no row was read or written.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
