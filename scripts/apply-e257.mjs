// Applies drizzle/E-257_nbfc_request_sla.sql and then PROVES it landed.
//
// Usage:  DATABASE_URL=postgresql://…database-2… node scripts/apply-e257.mjs
//         DATABASE_URL=postgresql://…database-2… node scripts/apply-e257.mjs --dry-run
//
// TARGET SELECTION — READ THIS BEFORE RUNNING.
// An explicit process.env.DATABASE_URL always wins. Falling back to .env.local
// is a coin flip: that file carries BOTH the database-1 (sandbox) and
// database-2 (PRODUCTION) URLs with one commented out, it is flipped by hand,
// and the two databases drift. The host is printed, together with which
// environment that host IS, before a single byte is written.
//
// WHAT E-257 DOES. Seven columns on nbfc_doc_requests (sla_due_at,
// forward_source, push_source, auto_forwarded_at, auto_pushed_at, sla_failure,
// requested_items), three on nbfc_document_verifications (sla_due_at,
// forward_source, sla_failure) and two PARTIAL indexes. It backs the NBFC
// request SLA sweep (auto-forward to dealer / auto-push to NBFC).
//
// It is REQUIRED before the code deploys — both tables are mirrored in
// schema.ts and read with a bare db.select(), and Drizzle names every column
// of a mirrored table in its generated SQL. Without this file the admin NBFC
// Actions card and the NBFC Acquire request thread fail with
// `column "sla_due_at" does not exist`. The automation itself stays inert:
// app_settings key 'nbfc_request_sla' ships enabled=false.
//
// Verified rather than trusted: every column is read back out of
// information_schema and each index predicate out of pg_indexes (Drizzle's
// index builder cannot express a WHERE clause, so this migration is the ONLY
// source of the predicate).
import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-257_nbfc_request_sla.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** Tables E-257 alters. A missing one means E-200/E-201 were never applied here. */
const PREREQ_TABLES = ["nbfc_doc_requests", "nbfc_document_verifications"];

/** Every column this file must add. */
const EXPECTED_COLUMNS = [
    ["nbfc_doc_requests", "sla_due_at", "timestamp with time zone"],
    ["nbfc_doc_requests", "forward_source", "character varying"],
    ["nbfc_doc_requests", "push_source", "character varying"],
    ["nbfc_doc_requests", "auto_forwarded_at", "timestamp with time zone"],
    ["nbfc_doc_requests", "auto_pushed_at", "timestamp with time zone"],
    ["nbfc_doc_requests", "sla_failure", "text"],
    ["nbfc_doc_requests", "requested_items", "jsonb"],
    ["nbfc_document_verifications", "sla_due_at", "timestamp with time zone"],
    ["nbfc_document_verifications", "forward_source", "character varying"],
    ["nbfc_document_verifications", "sla_failure", "text"],
];

const INDEXES = [
    "nbfc_doc_requests_sla_due_idx",
    "nbfc_document_verifications_sla_due_idx",
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
            console.log(`FAILED — ${t} does not exist on this DB. Apply E-200/E-201 first, or check the database.`);
            process.exit(1);
        }
    }
    console.log(`OK — all ${PREREQ_TABLES.length} target tables present.`);

    let beforeCount = 0;
    for (const [table, column] of EXPECTED_COLUMNS) {
        const [row] = await sql`
            SELECT 1 AS present FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
        if (row) beforeCount++;
    }
    console.log(`Columns already present before this run: ${beforeCount}/${EXPECTED_COLUMNS.length}`);

    if (DRY_RUN) {
        console.log("\nDry run — file parsed and passed the additive guard. Nothing written.");
        await sql.end({ timeout: 5 });
        process.exit(0);
    }

    await sql.unsafe(ddl);
    console.log("Migration executed. Verifying...\n");

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

    for (const name of INDEXES) {
        const [idx] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${name}`;
        if (!idx) {
            console.log(`FAILED — index ${name} is MISSING.`);
            failed = true;
            continue;
        }
        const ok = /\bWHERE\b/i.test(idx.indexdef) && /sla_due_at IS NOT NULL/i.test(idx.indexdef);
        console.log(
            ok
                ? `OK — ${name} exists and is genuinely PARTIAL.`
                : `FAILED — ${name} exists but its predicate is wrong: ${idx.indexdef}`,
        );
        if (!ok) failed = true;
    }

    // No backfill ships with this file, on purpose.
    const [{ open_rows, stamped }] = await sql`
        SELECT count(*)::int AS open_rows,
               count(sla_due_at)::int AS stamped
          FROM nbfc_doc_requests
         WHERE status IN ('nbfc_raised', 'admin_review', 'admin_review_upload')`;
    console.log(
        `\nOpen NBFC requests waiting on the admin on this DB: ${open_rows}; carrying an SLA deadline: ${stamped}.`,
    );
    console.log(
        stamped > 0
            ? "  NOTE — a non-zero count means requests were raised AFTER the app code shipped."
            : "  Expected: 0. No pre-existing request can auto-route, which is the intended safe state.",
    );

    if (failed) {
        console.log("\nE-257 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-257 applied and verified. Pure additive DDL — no row was read or written.");
    console.log("The automation remains OFF until an admin enables it at /admin/settings/nbfc-request-sla.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
