// Applies drizzle/E-244_kyc_card_sla_windows.sql and then PROVES it landed.
//
// Usage:  DATABASE_URL=postgresql://…database-1… node scripts/apply-e244.mjs
//         DATABASE_URL=postgresql://…database-1… node scripts/apply-e244.mjs --dry-run
//
// TARGET SELECTION — READ THIS BEFORE RUNNING.
// An explicit process.env.DATABASE_URL always wins. Falling back to .env.local
// is a coin flip: that file carries BOTH the database-1 (sandbox) and
// database-2 (PRODUCTION) URLs with one commented out, it is flipped by hand,
// and the two databases drift. The host is printed, together with which
// environment that host IS, before a single byte is written.
//
// WHAT E-244 DOES. Two columns on admin_verification_queue —
// `sla_card_due_at jsonb` (the per-card deadline snapshot taken at dealer
// submit) and `sla_next_due_at timestamptz` (the sweep's pointer at the
// earliest deadline still to act on) — plus one PARTIAL index. It backs
// per-card SLA windows: Aadhaar can clear in 20 minutes while the Equifax card
// waits an hour, and the case is only approved once the last window closes.
//
// It is REQUIRED before the code deploys. admin_verification_queue is mirrored
// in schema.ts and read with a bare db.select(), and Drizzle names every column
// of a mirrored table in its generated SQL, so without this file the KYC review
// page fails on its first read with `column "sla_card_due_at" does not exist`.
// The automation itself stays inert regardless: app_settings key
// 'kyc_auto_approval' ships enabled=false.
//
// Verified rather than trusted: "no exception was thrown" is not evidence, so
// both columns are read back out of information_schema and the index predicate
// out of pg_indexes. That last check earns its keep — Drizzle's index builder
// cannot express a WHERE clause, so this migration is the ONLY source of the
// predicate, and an index created without it would still satisfy a name-only
// check while scanning every open queue row on every 60s tick. Worse,
// `CREATE INDEX IF NOT EXISTS` could never repair it afterwards: the name
// already exists, so a re-run is a no-op and it would have to be dropped by hand.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-244_kyc_card_sla_windows.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

const PREREQ_TABLES = ["admin_verification_queue"];

const EXPECTED_COLUMNS = [
    ["admin_verification_queue", "sla_card_due_at", "jsonb"],
    ["admin_verification_queue", "sla_next_due_at", "timestamp with time zone"],
];

const INDEX_NAME = "admin_verification_queue_sla_next_due_idx";

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

    for (const t of PREREQ_TABLES) {
        const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
        if (r === null) {
            console.log(`FAILED — ${t} does not exist on this DB. Wrong database, or the KYC schema is missing.`);
            process.exit(1);
        }
    }
    console.log(`OK — all ${PREREQ_TABLES.length} target table(s) present.`);

    // E-244 extends E-242's clock. Without E-242 the sweep has no sla_due_at to
    // fall back to and the code stays broken on the other tables — say so.
    const [e242] = await sql`
        SELECT 1 AS present FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'admin_verification_queue'
           AND column_name = 'sla_due_at'`;
    console.log(
        e242
            ? "OK — E-242 is already applied on this DB (admin_verification_queue.sla_due_at present)."
            : "WARNING — E-242 does NOT look applied here. Run scripts/apply-e242.mjs first, or this half has nothing to extend.",
    );

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
            SELECT data_type, is_nullable FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
        if (!row) {
            console.log(`FAILED — ${table}.${column} is MISSING.`);
            failed = true;
            continue;
        }
        // Nullable is not incidental: NULL is the "pre-E-244 case, fall back to
        // sla_due_at" marker every existing row relies on.
        const ok = row.data_type === expectedType && row.is_nullable === "YES";
        console.log(
            ok
                ? `OK — ${table}.${column} (${row.data_type}, nullable)`
                : `FAILED — ${table}.${column} is ${row.data_type}/${row.is_nullable}, expected ${expectedType}/YES.`,
        );
        if (!ok) failed = true;
    }

    const [idx] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${INDEX_NAME}`;
    if (!idx) {
        console.log(`FAILED — index ${INDEX_NAME} is MISSING.`);
        failed = true;
    } else {
        const isPartial = /\bWHERE\b/i.test(idx.indexdef);
        const guardsSweep =
            /sla_next_due_at IS NOT NULL/i.test(idx.indexdef) &&
            /auto_approved_at IS NULL/i.test(idx.indexdef) &&
            /pending_itarang_verification/i.test(idx.indexdef);
        console.log(
            isPartial && guardsSweep
                ? `OK — ${INDEX_NAME} exists and is genuinely PARTIAL.`
                : `FAILED — ${INDEX_NAME} exists but its predicate is wrong: ${idx.indexdef}`,
        );
        if (!(isPartial && guardsSweep)) failed = true;
    }

    // No backfill ships with this file, on purpose: both columns must stay NULL
    // on existing rows, which makes them fall back to the single deadline they
    // were admitted under rather than acquiring per-card ones retroactively.
    const [{ open_rows, carded, pointed }] = await sql`
        SELECT count(*)::int AS open_rows,
               count(sla_card_due_at)::int AS carded,
               count(sla_next_due_at)::int AS pointed
          FROM admin_verification_queue
         WHERE status = 'pending_itarang_verification'`;
    console.log(
        `\nOpen KYC queue rows on this DB: ${open_rows}; carrying per-card deadlines: ${carded}; carrying a pointer: ${pointed}.`,
    );
    console.log(
        carded === 0 && pointed === 0
            ? "  Expected: 0 and 0. Existing cases keep the single deadline they were admitted under."
            : "  NOTE — non-zero means cases were submitted AFTER the app code shipped (or someone backfilled, which this file forbids).",
    );

    if (failed) {
        console.log("\nE-244 FAILED verification. Investigate before deploying the code.");
        process.exit(1);
    }
    console.log("\nE-244 applied and verified. Pure additive DDL — no row was read or written.");
    console.log("Per-card windows stay unused until an admin sets one in /admin/settings/kyc-automation.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
