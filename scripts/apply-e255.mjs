// Applies drizzle/E-255_storage_drive_mirror.sql and then PROVES it landed.
//
// Usage:  DATABASE_URL=postgresql://…database-2… node scripts/apply-e255.mjs
//         DATABASE_URL=postgresql://…database-2… node scripts/apply-e255.mjs --dry-run
//
// TARGET SELECTION — READ THIS BEFORE RUNNING.
// An explicit process.env.DATABASE_URL always wins. Falling back to .env.local
// is a coin flip: that file carries BOTH the database-1 (sandbox) and
// database-2 (PRODUCTION) URLs with one commented out, it is flipped by hand,
// and the two databases drift. The host is printed, together with which
// environment that host IS, before a single byte is written.
//
// WHAT E-255 DOES. One new table, storage_drive_mirror — the ledger/queue for
// the Google Drive backup of every S3 object — plus two indexes. Purely
// additive; touches no existing table. Without it the S3 write path logs
// "[gdrive-mirror] could not enqueue … relation does not exist" on every
// upload (uploads themselves succeed) and the admin Drive Backup page shows
// a ledger error.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-255_storage_drive_mirror.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

const TABLE = "storage_drive_mirror";
const EXPECTED_COLUMNS = [
    ["id", "bigint"],
    ["bucket", "character varying"],
    ["object_key", "text"],
    ["content_type", "character varying"],
    ["size_bytes", "bigint"],
    ["status", "character varying"],
    ["attempts", "integer"],
    ["next_attempt_at", "timestamp with time zone"],
    ["drive_file_id", "text"],
    ["drive_folder_id", "text"],
    ["drive_web_view_link", "text"],
    ["drive_md5", "text"],
    ["last_error", "text"],
    ["mirrored_at", "timestamp with time zone"],
    ["created_at", "timestamp with time zone"],
    ["updated_at", "timestamp with time zone"],
];
const INDEXES = [
    "storage_drive_mirror_bucket_key_uq",
    "storage_drive_mirror_due_idx",
    "storage_drive_mirror_status_idx",
];

/** Refuse to run a file that mutates data or narrows a type. */
function assertAdditive(sqlText) {
    const stripped = sqlText.replace(/--[^\n]*/g, "");
    const forbidden = [
        /\bDROP\s+COLUMN\b/i, /\bDROP\s+TABLE\b/i, /\bDROP\s+INDEX\b/i, /\bTRUNCATE\b/i,
        /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i,
        /\bALTER\s+TYPE\b/i, /\bSET\s+NOT\s+NULL\b/i, /\bRENAME\b/i,
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

    const [{ r: before }] = await sql`SELECT to_regclass(${TABLE}) AS r`;
    console.log(`Table ${TABLE} before this run: ${before ? "PRESENT" : "absent"}`);

    if (DRY_RUN) {
        console.log("\nDry run — file parsed and passed the additive guard. Nothing written.");
        await sql.end({ timeout: 5 });
        process.exit(0);
    }

    await sql.unsafe(ddl);
    console.log("Migration executed. Verifying...\n");

    for (const [column, expectedType] of EXPECTED_COLUMNS) {
        const [row] = await sql`
            SELECT data_type FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ${TABLE} AND column_name = ${column}`;
        if (!row) { console.log(`  MISSING  ${TABLE}.${column}`); failed = true; continue; }
        const ok = row.data_type === expectedType;
        if (!ok) failed = true;
        console.log(`  ${ok ? "ok      " : "MISMATCH"} ${TABLE}.${column} ${row.data_type}`);
    }
    for (const idx of INDEXES) {
        const [row] = await sql`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname = ${idx}`;
        if (!row) { console.log(`  MISSING  index ${idx}`); failed = true; continue; }
        console.log(`  ok       index ${idx}`);
    }
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM storage_drive_mirror`;
    console.log(`\nRows in ${TABLE}: ${n}`);
    console.log(failed ? "\nFAILED — see above." : "\nE-255 verified on this database.");
} catch (err) {
    failed = true;
    console.error("ERROR:", err instanceof Error ? err.message : err);
} finally {
    await sql.end({ timeout: 5 });
    process.exit(failed ? 1 : 0);
}
