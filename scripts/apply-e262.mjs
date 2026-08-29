// Applies drizzle/E-262_recovery_agent_dispatch.sql and then PROVES it landed.
//
// WHAT E-262 DOES. The physical leg between "flagged for recovery" and "on the
// inspection bench": a per-NBFC directory of recovery agents, one dispatch row
// per collection job carrying a single-use link token and the GPS the agent
// captured at the address, and one row per watermarked photograph they took.
//
// Modelled field for field on field_investigations / nbfc_fi_agents /
// field_investigation_photos (E-148), which already solved assign → tokenised
// link → GPS + photo capture → reviewer decision.
//
// REQUIRED BEFORE THE CODE DEPLOYS. All three tables are mirrored in schema.ts
// and read with a bare db.select(), so an unapplied environment fails the
// Recovery queue and the NBFC settings page on their first read.
//
// THREE PARTIAL INDEXES ARE THE POINT, not decoration — Drizzle cannot express
// a WHERE on an index, so this file is their only source:
//   recovery_assignments_open_unique         one live assignment per loan
//   recovery_assignments_link_token_unique   the token is a credential
//   recovery_assignment_photos_slot_unique   one photo per named slot
// Each is verified BY ITS PREDICATE below, not merely by name: an index that
// exists without its WHERE clause enforces the wrong rule, and would do so
// silently.
//
// ALSO ADDS a unique index E-232 assumed but never wrote —
// nbfc_recovery_pipeline (tenant_id, battery_serial). flagLoanForRecovery
// find-or-creates on that pair and the Recovery queue maps by it. This script
// COUNTS THE DUPLICATES FIRST and refuses rather than letting the CREATE fail
// halfway through the file.
//
// No DML, no backfill; re-running is a no-op.
//
//   node scripts/apply-e262.mjs --dry-run
//   node scripts/apply-e262.mjs

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-262_recovery_agent_dispatch.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** A missing one means the recovery module itself was never applied here. */
const PREREQ_TABLES = ["nbfc_recovery_pipeline", "recovery_batteries", "loan_sanctions"];

const EXPECTED_TABLES = [
    "nbfc_recovery_agents",
    "recovery_assignments",
    "recovery_assignment_photos",
];

const EXPECTED_COLUMNS = [
    ["nbfc_recovery_agents", "tenant_id", "uuid"],
    ["nbfc_recovery_agents", "name", "character varying"],
    ["nbfc_recovery_agents", "phone", "character varying"],
    ["nbfc_recovery_agents", "coverage_area", "text"],
    ["nbfc_recovery_agents", "active", "boolean"],
    // varchar, NOT uuid — loan_sanctions.id is character varying. Getting this
    // wrong is the trap E-232 had to ship a self-correction block for.
    ["recovery_assignments", "loan_sanction_id", "character varying"],
    ["recovery_assignments", "status", "character varying"],
    ["recovery_assignments", "is_current", "boolean"],
    ["recovery_assignments", "link_token", "character varying"],
    ["recovery_assignments", "link_expires_at", "timestamp with time zone"],
    ["recovery_assignments", "dispatch_error", "text"],
    ["recovery_assignments", "gps_lat", "numeric"],
    ["recovery_assignments", "gps_server_timestamp", "timestamp with time zone"],
    ["recovery_assignments", "stated_lat", "numeric"],
    ["recovery_assignments", "distance_from_address_m", "numeric"],
    ["recovery_assignments", "condition_notes", "text"],
    ["recovery_assignments", "review_decision", "character varying"],
    ["recovery_assignments", "cancel_source", "character varying"],
    ["recovery_assignment_photos", "assignment_id", "uuid"],
    ["recovery_assignment_photos", "photo_type", "character varying"],
    ["recovery_assignment_photos", "image_url", "text"],
    ["recovery_assignment_photos", "watermark_applied", "boolean"],
];

const PLAIN_INDEXES = [
    "nbfc_recovery_agents_tenant_active_idx",
    "recovery_assignments_tenant_status_idx",
    "recovery_assignments_loan_idx",
    "recovery_assignment_photos_assignment_idx",
    "nbfc_recovery_pipeline_tenant_serial_unique",
];

/**
 * Verified by their PREDICATE, not their name. Each of these carries a business
 * rule; an index created without its WHERE would enforce something else
 * entirely — `recovery_assignments_open_unique` without its clause would allow
 * exactly ONE assignment per loan for all time, including the cancelled ones.
 */
const PARTIAL_INDEXES = [
    {
        name: "recovery_assignments_open_unique",
        mustMatch: /UNIQUE.*\(loan_sanction_id\).*WHERE.*is_current.*status/is,
        why: "one live assignment per loan — two agents at one door is a phone call from the borrower, not a log entry",
    },
    {
        name: "recovery_assignments_link_token_unique",
        mustMatch: /UNIQUE.*\(link_token\).*WHERE.*link_token IS NOT NULL/is,
        why: "the token is the credential on an unauthenticated route",
    },
    {
        name: "recovery_assignment_photos_slot_unique",
        mustMatch: /UNIQUE.*\(assignment_id, photo_type\).*WHERE.*extra/is,
        why: "the agent's phone auto-retries a failed submit; without this a dropped connection duplicates a shot",
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
            console.log(`FAILED — ${t} does not exist on this DB. The recovery module is not applied here.`);
            process.exit(1);
        }
    }
    console.log(`OK — all ${PREREQ_TABLES.length} prerequisite tables present.`);

    // The one statement in this file that can fail on DATA rather than schema.
    // Checked BEFORE the write so the failure is a readable message here rather
    // than a 23505 halfway through the file.
    const dupes = await sql`
        SELECT tenant_id, battery_serial, count(*)::int AS n
          FROM nbfc_recovery_pipeline
         GROUP BY 1, 2
        HAVING count(*) > 1`;
    if (dupes.length > 0) {
        console.log(
            `\nFAILED — ${dupes.length} duplicate (tenant_id, battery_serial) pair(s) in nbfc_recovery_pipeline.`,
        );
        console.log(
            "  nbfc_recovery_pipeline_tenant_serial_unique cannot be created until these are reconciled.",
        );
        for (const d of dupes.slice(0, 10)) {
            console.log(`    ${d.battery_serial} — ${d.n} rows (tenant ${d.tenant_id})`);
        }
        process.exit(1);
    }
    console.log("OK — nbfc_recovery_pipeline has no duplicate (tenant_id, battery_serial) pairs.");

    let beforeTables = 0;
    for (const t of EXPECTED_TABLES) {
        const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
        if (r !== null) beforeTables++;
    }
    console.log(`Tables already present before this run: ${beforeTables}/${EXPECTED_TABLES.length}`);

    if (DRY_RUN) {
        console.log("\nDry run — file parsed, additive guard passed, duplicate check clean. Nothing written.");
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

    // No backfill, on purpose: there is no history of agent dispatches to
    // reconstruct. Every flagged loan starts with no assignment, which is the
    // truth — nobody has been sent anywhere yet.
    const [{ flagged }] = await sql`
        SELECT count(*)::int AS flagged
          FROM loan_sanctions
         WHERE recovery_flagged_at IS NOT NULL`;
    const [{ assignments }] = await sql`SELECT count(*)::int AS assignments FROM recovery_assignments`;
    const [{ agents }] = await sql`SELECT count(*)::int AS agents FROM nbfc_recovery_agents`;
    console.log(
        `\nFlagged loans: ${flagged}. Recovery agents on file: ${agents}. Assignments: ${assignments}.`,
    );
    console.log("  Add agents at Settings → Recovery Agents, then dispatch one from the Recovery queue.");

    if (failed) {
        console.log("\nE-262 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-262 applied and verified. Pure additive DDL — no row was read or written.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
