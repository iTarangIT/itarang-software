// Applies drizzle/E-243_consent_auto_verify_sla.sql and then PROVES it landed.
//
// Usage:  DATABASE_URL=postgresql://…database-1… node scripts/apply-e243.mjs
//         DATABASE_URL=postgresql://…database-1… node scripts/apply-e243.mjs --dry-run
//
// TARGET SELECTION — READ THIS BEFORE RUNNING.
// An explicit process.env.DATABASE_URL always wins. Falling back to .env.local
// is a coin flip: that file carries BOTH the database-1 (sandbox) and
// database-2 (PRODUCTION) URLs with one commented out, it is flipped by hand,
// and the two databases drift. The host is printed, together with which
// environment that host IS, before a single byte is written.
//
// WHAT E-243 DOES. One column — consent_records.auto_verify_due_at — plus one
// PARTIAL index over it. It is the consent half of the E-242 KYC auto-approval
// SLA: a consent is only ever swept once this deadline has been stamped at
// signing time and has passed. Consents that predate the file keep NULL and are
// structurally unreachable by the sweep, which is why there is NO BACKFILL.
//
// It is REQUIRED before the code deploys. consent_records is mirrored in
// schema.ts and read with a bare db.select() (the admin KYC case-review route
// among them), and Drizzle names every column of a mirrored table in its
// generated SQL — so without this file the consent panel fails on its first
// read with `column "auto_verify_due_at" does not exist`, and the 60s sweep
// throws every tick. The automation itself stays inert regardless:
// app_settings key 'kyc_auto_approval' ships enabled=false.
//
// Verified rather than trusted: "no exception was thrown" is not evidence, so
// the column is read back out of information_schema and the index predicate out
// of pg_indexes. That last check earns its keep — Drizzle's index builder
// cannot express a WHERE clause, so this migration is the ONLY source of the
// predicate, and an index created without it would still satisfy a name-only
// check while scanning every consent row on every 60s tick. Worse,
// `CREATE INDEX IF NOT EXISTS` could never repair it afterwards: the name
// already exists, so a re-run is a no-op and it would have to be dropped by hand.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-243_consent_auto_verify_sla.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** Tables E-243 alters. A missing one means an out-of-order or wrong database. */
const PREREQ_TABLES = ["consent_records"];

/** Every column this file must add. */
const EXPECTED_COLUMNS = [["consent_records", "auto_verify_due_at", "timestamp with time zone"]];

const INDEX_NAME = "consent_records_auto_verify_due_idx";

/**
 * Refuse to run a file that mutates data or narrows a type. Strips `--` line
 * comments and the $c$…$c$ COMMENT payloads first — this file is mostly prose
 * and a naive scan reads an English "update" or "insert" inside a COMMENT as a
 * data-mutating statement. The $do$…$do$ blocks are deliberately NOT stripped:
 * that is where the real DDL lives and is exactly what needs scanning.
 */
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

    // Fail with the real reason rather than a bare 42P01 from mid-file.
    for (const t of PREREQ_TABLES) {
        const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
        if (r === null) {
            console.log(`FAILED — ${t} does not exist on this DB. Wrong database, or the KYC schema is missing.`);
            process.exit(1);
        }
    }
    console.log(`OK — all ${PREREQ_TABLES.length} target table(s) present.`);

    // E-243 is the consent half of E-242's SLA and reads its settings key. If
    // E-242 never landed here, applying this alone leaves the code still broken
    // on the other four tables — say so rather than report a false success.
    const [e242] = await sql`
        SELECT 1 AS present FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'consent_records'
           AND column_name = 'verification_source'`;
    console.log(
        e242
            ? "OK — E-242 is already applied on this DB (consent_records.verification_source present)."
            : "WARNING — E-242 does NOT look applied here. Run scripts/apply-e242.mjs as well, or the KYC pages stay broken.",
    );

    // Snapshot before, so the run can report what it actually changed rather
    // than just what is present at the end (a re-run should add 0).
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
        // Nullable is not incidental here: NULL is the "never auto-verify"
        // marker every pre-E-243 consent relies on.
        const typeOk = row.data_type === expectedType;
        const nullableOk = row.is_nullable === "YES";
        console.log(
            typeOk && nullableOk
                ? `OK — ${table}.${column} (${row.data_type}, nullable)`
                : `FAILED — ${table}.${column} is ${row.data_type}/${row.is_nullable}, expected ${expectedType}/YES.`,
        );
        if (!(typeOk && nullableOk)) failed = true;
    }

    // The index must exist AND be genuinely partial — see the header.
    const [idx] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${INDEX_NAME}`;
    if (!idx) {
        console.log(`FAILED — index ${INDEX_NAME} is MISSING.`);
        failed = true;
    } else {
        const isPartial = /\bWHERE\b/i.test(idx.indexdef);
        const guardsSweep =
            /auto_verify_due_at IS NOT NULL/i.test(idx.indexdef) &&
            /esign_completed/i.test(idx.indexdef) &&
            /admin_review_pending/i.test(idx.indexdef) &&
            /manual_uploaded/i.test(idx.indexdef);
        console.log(
            isPartial && guardsSweep
                ? `OK — ${INDEX_NAME} exists and is genuinely PARTIAL.`
                : `FAILED — ${INDEX_NAME} exists but its predicate is wrong: ${idx.indexdef}`,
        );
        if (!(isPartial && guardsSweep)) failed = true;
    }

    // No backfill ships with this file, on purpose: auto_verify_due_at must stay
    // NULL on pre-existing rows so no consent signed before E-243 can be swept.
    // A non-zero `stamped` on a DB that has only just received the column would
    // mean someone backfilled it — that is the failure this reports.
    const [{ open_rows, stamped }] = await sql`
        SELECT count(*)::int AS open_rows,
               count(auto_verify_due_at)::int AS stamped
          FROM consent_records
         WHERE consent_status IN ('esign_completed', 'admin_review_pending', 'manual_uploaded')`;
    console.log(
        `\nSigned-but-unverified consents on this DB: ${open_rows}; carrying an auto-verify deadline: ${stamped}.`,
    );
    if (stamped > 0) {
        console.log(
            "  NOTE — a non-zero count here means consents were signed AFTER the app code shipped (or someone backfilled, which this file forbids).",
        );
    } else {
        console.log(
            "  Expected: 0. No pre-existing consent can auto-verify, which is the intended safe state.",
        );
    }

    if (failed) {
        console.log("\nE-243 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-243 applied and verified. Pure additive DDL — no row was read or written.");
    console.log("The automation remains OFF until an admin enables it in /admin/settings.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
