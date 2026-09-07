// Applies drizzle/E-280_drive_sales_invoices.sql and then PROVES it landed.
//
// WHAT E-280 DOES. The company has moved off Zoho Invoice onto Vyapar, which has
// no API, and now files sales invoices as PDFs in a shared Google Drive folder.
// zoho_invoices therefore stops growing and every CEO revenue figure flatlines
// (verified: August 2026 revenue reads 0). This adds four tables so a Drive
// scanner can read the SALE side of that folder — the mirror of what E-216 did
// for the purchase side.
//
// SAFE TO SKIP AT DEPLOY TIME, BY DESIGN. Nothing here is a column on an
// existing table, so no bare db.select() anywhere in the app grows a column it
// cannot find. An unapplied E-280 costs exactly the feature that needs it:
// src/lib/dashboard/revenueSource.ts probes for sales_invoices with
// to_regclass and falls back to Zoho-only revenue, which is what the dashboard
// showed before this change. That was the deciding reason for four new tables
// rather than a `kind` column on drive_scan_runs / drive_expense_files and a
// `sales_enabled` flag on drive_expense_folders — the E-267/E-250/E-242/E-236
// rule. Mirroring those three columns would have made this REQUIRED and an
// unapplied environment would fail every EXPENSE scan to add a feature beside it.
//
// The probe is cached for 5 minutes, so a running app picks this up on its own
// within that window — no pm2 restart needed.
//
// No DML, no backfill. Nothing here reads or writes a single row of data.
//
//   node scripts/apply-e280.mjs --dry-run
//   node scripts/apply-e280.mjs
//   DATABASE_URL=... node scripts/apply-e280.mjs      # to target the OTHER db
//
// This repo drifts between two RDS instances, so the host is printed and
// labelled before anything is written. Read it.

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-280_drive_sales_invoices.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** zoho_invoices is the union partner — without it this DB is not the CRM. */
const PREREQ_TABLES = ["zoho_invoices", "drive_expense_folders"];

const EXPECTED_TABLES = [
    "sales_invoices",
    "sales_invoice_folders",
    "sales_scan_runs",
    "sales_scan_files",
];

const EXPECTED_COLUMNS = [
    ["sales_invoices", "source", "character varying"],
    ["sales_invoices", "invoice_number", "text"],
    ["sales_invoices", "invoice_number_key", "text"],
    ["sales_invoices", "invoice_date", "date"],
    ["sales_invoices", "customer_name", "text"],
    ["sales_invoices", "customer_gstin", "character varying"],
    ["sales_invoices", "organization_id", "character varying"],
    ["sales_invoices", "seller_gstin", "character varying"],
    ["sales_invoices", "sub_total", "numeric"],
    ["sales_invoices", "tax_total", "numeric"],
    ["sales_invoices", "total", "numeric"],
    ["sales_invoices", "amount_paid", "numeric"],
    ["sales_invoices", "status", "character varying"],
    ["sales_invoices", "payment_reference", "text"],
    ["sales_invoices", "last_payment_date", "date"],
    ["sales_invoices", "payment_marked_by", "uuid"],
    ["sales_invoices", "drive_file_id", "character varying"],
    ["sales_invoices", "folder_path", "text"],
    ["sales_invoices", "document_url", "text"],
    ["sales_invoices", "ai_raw", "jsonb"],
    ["sales_invoices", "needs_attention", "boolean"],
    ["sales_invoices", "attention_reason", "text"],
    ["sales_invoice_folders", "drive_folder_id", "character varying"],
    ["sales_invoice_folders", "include_names", "text"],
    ["sales_invoice_folders", "exclude_names", "text"],
    ["sales_invoice_folders", "is_active", "boolean"],
    ["sales_scan_runs", "status", "text"],
    ["sales_scan_runs", "files_seen", "integer"],
    ["sales_scan_runs", "imported", "integer"],
    ["sales_scan_runs", "skipped_duplicate", "integer"],
    ["sales_scan_files", "drive_file_id", "character varying"],
    ["sales_scan_files", "md5_checksum", "character varying"],
    ["sales_scan_files", "status", "text"],
    ["sales_scan_files", "invoice_ids", "jsonb"],
];

const PLAIN_INDEXES = [
    "sales_invoices_invoice_date_idx",
    "sales_invoices_status_idx",
    "sales_invoices_organization_id_idx",
    "sales_invoice_folders_folder_id_unique",
    "sales_scan_runs_started_at_idx",
    "sales_scan_files_file_version_unique",
    "sales_scan_files_run_id_idx",
    "sales_scan_files_status_idx",
];

/**
 * Verified by predicate, not by name. Each of these WITHOUT its WHERE clause is
 * a different index enforcing a different rule — and would still pass a check
 * that only looked for the name.
 */
const PARTIAL_INDEXES = [
    {
        name: "sales_invoices_number_key_unique",
        mustMatch: /UNIQUE.*WHERE.*invoice_number_key IS NOT NULL/is,
        why: "the guard against importing an invoice zoho_invoices already has — without the WHERE, a second unreadable invoice number would collide on NULL and be rejected",
    },
    {
        name: "sales_invoices_attention_idx",
        mustMatch: /WHERE.*needs_attention/is,
        why: "the Needs Attention panel",
    },
    {
        name: "sales_invoice_folders_active_idx",
        mustMatch: /WHERE.*is_active/is,
        why: "loading only the folders a scan should walk",
    },
    {
        name: "sales_scan_runs_running_idx",
        mustMatch: /WHERE.*status.*=.*'running'/is,
        why: "the concurrency guard that stops the button, the ticker and the cron route overlapping",
    },
];

const EXPECTED_CHECKS = ["sales_scan_runs_status_check", "sales_scan_files_status_check"];

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

    // Report the pre-state so "0 new rows" after a scan is readable later.
    const [{ n: zohoRows }] = await sql`SELECT count(*)::int AS n FROM zoho_invoices`;
    console.log(`Pre-state: zoho_invoices holds ${zohoRows} row(s) — the historical side of the union.`);

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
                ? `OK — partial index ${name} carries its predicate`
                : `FAILED — ${name} exists but WITHOUT its predicate, so it does not enforce ${why}.\n        ${idx.indexdef}`,
        );
        if (!ok) failed = true;
    }

    for (const name of EXPECTED_CHECKS) {
        const [row] = await sql`
            SELECT conname FROM pg_constraint WHERE conname = ${name}`;
        console.log(row ? `OK — check constraint ${name}` : `FAILED — check ${name} is MISSING.`);
        if (!row) failed = true;
    }

    // The whole point of the design: prove nothing was added to the E-216
    // tables, so an environment without E-280 still runs expense scans.
    const drifted = await sql`
        SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('drive_expense_folders', 'drive_scan_runs', 'drive_expense_files')
           AND column_name IN ('kind', 'sales_enabled', 'sales_include_names', 'sales_exclude_names')`;
    console.log(
        drifted.length === 0
            ? "OK — the E-216 expense tables were not touched (this is why E-280 is skippable)."
            : `FAILED — E-280 modified the expense tables: ${drifted.map((d) => `${d.table_name}.${d.column_name}`).join(", ")}`,
    );
    if (drifted.length !== 0) failed = true;

    const [{ n: seeded }] = await sql`SELECT count(*)::int AS n FROM sales_invoices`;
    console.log(`\nsales_invoices holds ${seeded} row(s) — expected 0; this migration writes no data.`);

    console.log(
        failed
            ? "\nRESULT: FAILED — see the lines above."
            : "\nRESULT: E-280 applied and verified. Re-running this file is a no-op.",
    );
} catch (err) {
    failed = true;
    console.error("\nFAILED:", err?.message ?? err);
} finally {
    await sql.end({ timeout: 5 });
}

process.exit(failed ? 1 : 0);
