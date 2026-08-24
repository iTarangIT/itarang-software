// Applies drizzle/E-264_whatsapp_journey_foundation.sql and then PROVES it landed.
//
// WHAT E-264 DOES. Lays the substrate for running the whole customer onboarding
// journey over WhatsApp: a hashed no-login magic-link table, somewhere to park
// an interactive prompt while Meta's 24-hour service window is shut, an
// "unassigned" flag for a self-serve lead that has no dealer yet, and an
// expression index so finding the chat that belongs to a lead stops being a
// sequential scan.
//
// REQUIRED BEFORE THE CODE DEPLOYS — and, unusually, required before the code
// even RUNS. `leads` and `whatsapp_onboarding_sessions` are read with bare
// db.select() calls all over the app, and Drizzle names every column in
// schema.ts in its SELECT list. An unapplied environment therefore fails the
// admin KYC review page (and much else) with:
//     column "assignment_status" does not exist
// That is not a symptom of a code bug; it is this file not having been run.
//
// No DML, no backfill. Nothing here reads or writes a single row of data.
//
//   node scripts/apply-e264.mjs --dry-run
//   node scripts/apply-e264.mjs
//   DATABASE_URL=... node scripts/apply-e264.mjs      # to target the OTHER db
//
// The DB this repo drifts between two RDS instances, so the host is printed and
// labelled before anything is written. Read it.

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-264_whatsapp_journey_foundation.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** Tables E-264 attaches to. A missing one means this DB is far older than expected. */
const PREREQ_TABLES = ["leads", "whatsapp_onboarding_sessions", "co_borrowers", "co_borrower_documents"];

const EXPECTED_TABLES = ["lead_action_tokens"];

const EXPECTED_COLUMNS = [
    ["lead_action_tokens", "lead_id", "character varying"],
    ["lead_action_tokens", "purpose", "character varying"],
    ["lead_action_tokens", "token_hash", "character varying"],
    ["lead_action_tokens", "audience", "character varying"],
    ["lead_action_tokens", "wa_phone", "character varying"],
    ["lead_action_tokens", "ref_id", "character varying"],
    ["lead_action_tokens", "expires_at", "timestamp with time zone"],
    ["lead_action_tokens", "consumed_at", "timestamp with time zone"],
    ["lead_action_tokens", "created_by", "uuid"],
    ["whatsapp_onboarding_sessions", "pending_prompt", "jsonb"],
    ["whatsapp_onboarding_sessions", "pending_prompt_at", "timestamp with time zone"],
    ["whatsapp_onboarding_sessions", "window_nudges_sent", "integer"],
    ["leads", "assignment_status", "character varying"],
    ["leads", "dealer_assigned_at", "timestamp with time zone"],
    ["leads", "dealer_assigned_by", "uuid"],
];

const PLAIN_INDEXES = [
    "lead_action_tokens_hash_unique",
    "lead_action_tokens_lead_purpose_idx",
    "co_borrower_documents_lead_type_idx",
];

/**
 * Verified by predicate, not by name. Each of these WITHOUT its WHERE clause is
 * a different index answering a different question — and would still pass a
 * check that only looked for the name.
 */
const PARTIAL_INDEXES = [
    {
        name: "whatsapp_sessions_lead_id_idx",
        mustMatch: /context.*->.*'lead'.*->>.*'leadId'/is,
        why: "finding the chat that belongs to a lead without scanning every session",
    },
    {
        name: "leads_unassigned_queue_idx",
        mustMatch: /WHERE.*assignment_status.*=.*'unassigned'/is,
        why: "the admin queue of self-serve leads waiting for a dealer",
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
            console.log(`FAILED — ${t} does not exist on this DB. This is not the database you think it is.`);
            process.exit(1);
        }
    }
    console.log(`OK — all ${PREREQ_TABLES.length} prerequisite tables present.`);

    // The unique index on co_borrowers(lead_id) is created inside a guarded DO
    // block that falls back to a NON-unique index when duplicates already exist.
    // Report the situation up front so the NOTICE is not missed in the log.
    const dupes = await sql`
        SELECT lead_id, count(*)::int AS n
          FROM co_borrowers GROUP BY lead_id HAVING count(*) > 1 ORDER BY n DESC LIMIT 5`;
    if (dupes.length) {
        console.log(
            `\nNOTE — co_borrowers already has ${dupes.length}+ lead_id(s) with duplicate rows`,
            `(worst: ${dupes[0].lead_id} x${dupes[0].n}).`,
        );
        console.log("  The unique index will be SKIPPED and a non-unique one created instead.");
        console.log("  De-duplicate, then create co_borrowers_lead_unique by hand.\n");
    }

    if (DRY_RUN) {
        console.log("Dry run — file parsed and passed the additive guard. Nothing written.");
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
            SELECT data_type, column_default, is_nullable
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
            console.log(`FAILED — index ${name} is MISSING (${why}).`);
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

    // The whole point of the leads columns: prove the SELECT that was failing
    // now works, rather than trusting the catalogue.
    const [{ assigned }] = await sql`
        SELECT count(*)::int AS assigned FROM leads WHERE assignment_status = 'assigned'`;
    const [{ unassigned }] = await sql`
        SELECT count(*)::int AS unassigned FROM leads WHERE assignment_status = 'unassigned'`;
    console.log(`\nLeads: ${assigned} assigned, ${unassigned} unassigned.`);
    console.log("  Every pre-existing lead defaulted to 'assigned' — no behaviour changed.");

    if (failed) {
        console.log("\nE-264 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-264 applied and verified. Pure additive DDL — no row was read or written.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
