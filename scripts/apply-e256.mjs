// Applies drizzle/E-256_product_master_gst_defaults.sql and PROVES it landed.
//
// Usage:  DATABASE_URL=postgresql://…database-2… node scripts/apply-e256.mjs
//         DATABASE_URL=postgresql://…database-2… node scripts/apply-e256.mjs --dry-run
//
// TARGET SELECTION — READ THIS BEFORE RUNNING.
// An explicit process.env.DATABASE_URL always wins. Falling back to .env.local
// is a coin flip: that file carries BOTH the database-1 (sandbox) and
// database-2 (PRODUCTION) URLs with one commented out, it is flipped by hand,
// and the two databases drift. The host is printed, together with which
// environment that host IS, before a single byte is written.
//
// WHAT E-256 DOES. Backfills gst_rate_pct / hsn_code on the three product
// masters where NULL (battery 18/85076000, charger 5/85044030, paraphernalia
// 18/85079090 — business policy, 2026-08-20) and sets those values as column
// DEFAULTs. Rates or HSNs already set by hand are never touched. This is the
// data half of the quotation-GST fix; the code half is the
// DEFAULT_TAX_BY_ASSET_TYPE fallback in src/lib/leads/quote-pdf/view.ts, so
// the app works before OR after this file — the file makes the catalogue
// canonical and per-product overridable.
//
// UNLIKE most E- apply scripts this one INTENTIONALLY contains UPDATEs — a
// NULL-only backfill. The guard below therefore allows UPDATE statements that
// target ONLY the three product_master tables and refuses everything else
// destructive.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "drizzle/E-256_product_master_gst_defaults.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

/** The policy this file encodes; verification reads it back. */
const POLICY = [
    ["product_master_batteries", "18", "85076000"],
    ["product_master_chargers", "5", "85044030"],
    ["product_master_paraphernalia", "18", "85079090"],
];

/** Refuse anything destructive; allow the NULL-only backfill on the masters. */
function assertSafe(sqlText) {
    const stripped = sqlText
        .replace(/\$c\$[\s\S]*?\$c\$/g, "''")
        .replace(/--[^\n]*/g, "");
    const forbidden = [
        /\bDROP\s+(COLUMN|TABLE|INDEX)\b/i,
        /\bTRUNCATE\b/i,
        /\bDELETE\s+FROM\b/i,
        /\bINSERT\s+INTO\b/i,
        /\bALTER\s+TYPE\b/i,
        /\bSET\s+NOT\s+NULL\b/i,
        /\bRENAME\b/i,
    ];
    const hits = forbidden.filter((re) => re.test(stripped)).map((re) => String(re));
    // Every UPDATE must target a product_master table and be NULL-guarded.
    for (const m of stripped.matchAll(/\bUPDATE\s+(\S+)[\s\S]*?;/gi)) {
        if (!/^product_master_(batteries|chargers|paraphernalia)$/.test(m[1]) || !/IS\s+NULL/i.test(m[0])) {
            hits.push(`unexpected UPDATE on ${m[1]}`);
        }
    }
    if (hits.length) {
        console.log("REFUSING TO RUN — unsafe statement(s) found:", hits.join(", "));
        process.exit(1);
    }
}

const { url, from } = resolveUrl();
const ddl = readFileSync(FILE, "utf8");
assertSafe(ddl);

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

    for (const [table] of POLICY) {
        const [{ r }] = await sql`SELECT to_regclass(${table}) AS r`;
        if (r === null) {
            console.log(`FAILED — ${table} does not exist on this DB. Check the database.`);
            process.exit(1);
        }
        const [col] = await sql`
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'gst_rate_pct'`;
        if (!col) {
            console.log(`FAILED — ${table}.gst_rate_pct missing. Apply E-242 first.`);
            process.exit(1);
        }
    }
    console.log("OK — all three product-master tables present with gst_rate_pct (E-242).");

    for (const [table] of POLICY) {
        const [{ total, unrated }] = await sql.unsafe(
            `SELECT count(*)::int AS total, count(*) FILTER (WHERE gst_rate_pct IS NULL)::int AS unrated FROM ${table}`,
        );
        console.log(`Before: ${table} — ${total} rows, ${unrated} without a GST rate.`);
    }

    if (DRY_RUN) {
        console.log("\nDry run — file parsed and passed the safety guard. Nothing written.");
        await sql.end({ timeout: 5 });
        process.exit(0);
    }

    await sql.unsafe(ddl);
    console.log("\nMigration executed. Verifying...\n");

    for (const [table, rate, hsn] of POLICY) {
        const [{ total, unrated, no_hsn }] = await sql.unsafe(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE gst_rate_pct IS NULL)::int AS unrated,
                    count(*) FILTER (WHERE hsn_code IS NULL)::int AS no_hsn
               FROM ${table}`,
        );
        const ok = unrated === 0 && no_hsn === 0;
        console.log(
            ok
                ? `OK — ${table}: all ${total} rows carry a rate and an HSN.`
                : `FAILED — ${table}: ${unrated} rows still without a rate, ${no_hsn} without an HSN.`,
        );
        if (!ok) failed = true;

        const [def] = await sql`
            SELECT column_default FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'gst_rate_pct'`;
        const defOk = def?.column_default != null && def.column_default.includes(rate);
        console.log(
            defOk
                ? `OK — ${table}.gst_rate_pct defaults to ${rate}.`
                : `FAILED — ${table}.gst_rate_pct default is ${def?.column_default ?? "NULL"}, expected ${rate}.`,
        );
        if (!defOk) failed = true;

        const [{ n }] = await sql.unsafe(
            `SELECT count(*)::int AS n FROM ${table} WHERE hsn_code = '${hsn}'`,
        );
        console.log(`     ${n} rows on the policy HSN ${hsn} (hand-set values were preserved).`);
    }

    if (failed) {
        console.log("\nE-256 FAILED verification. Investigate before relying on the catalogue.");
        process.exit(1);
    }
    console.log("\nE-256 applied and verified. New quotations will price GST from the catalogue;");
    console.log("per-product overrides are editable in /admin/product-master.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
