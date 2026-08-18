// Applies drizzle/E-249_auction_settlement_payment_refinance.sql and
// drizzle/E-250_remove_demo_auction_lots.sql, then PROVES both landed.
//
// Usage:  DATABASE_URL=postgresql://…database-1… node scripts/apply-e249-e250.mjs --dry-run
//         DATABASE_URL=postgresql://…database-1… node scripts/apply-e249-e250.mjs
//         DATABASE_URL=…                        node scripts/apply-e249-e250.mjs --only=249
//
// TARGET SELECTION — READ THIS BEFORE RUNNING.
// An explicit process.env.DATABASE_URL always wins. Falling back to .env.local
// is a coin flip: that file carries BOTH the database-1 (sandbox) and
// database-2 (PRODUCTION) URLs with one commented out, it is flipped by hand,
// and the two databases drift. At the time this script was written the ACTIVE
// line in .env.local was database-2 — production. The host is printed, together
// with which environment that host IS, before a single byte is written.
//
// WHY THE TWO FILES SHIP IN ONE SCRIPT
// They are one change: E-249 adds the money columns Phase 6 needs, E-250 clears
// the five E-129 demo lots out of the way of the same Phase 6 screens. They are
// still executed as two independent transactions, and --only=<n> runs just one.
//
// E-250 WAS REVERSED ON 2026-08-18 — IT NOW DELETES, IT NO LONGER BACKFILLS.
// The original file repaired the demo lots (seller + visibility + audience).
// Probing database-1 killed that plan: all five rows are status='ended' and
// expired between 23 and 30 May 2026, and hold ZERO auction_lot_items, so the
// window-repair statement (live rows only) was a no-op and the audience insert
// would have written 940 rows for lots nobody can bid on. The file now removes
// them and every child row, and E-129's seed is commented out so a replay
// cannot bring them back. The guard and the verification below were rewritten
// to match; the old ones asserted a backfill that no longer happens.
//
// THE TWO FILES ARE NOT THE SAME KIND OF FILE, AND THE GUARD KNOWS IT.
//   E-249 is pure additive DDL — five nullable columns, two plain indexes. It
//   is held to the strict repo rule: no DROP, no INSERT, no UPDATE, no
//   SET NOT NULL, no ALTER TYPE. Anything else and this refuses to run.
//
//   E-250 is DATA REMOVAL and says so in its own header. It legitimately runs
//   DELETE, so the strict guard would reject a correct file. It gets a narrower
//   guard instead: still no DROP/TRUNCATE/ALTER TYPE/RENAME, but every mutating
//   statement must be scoped to `lot_code LIKE 'DEMO-LOT-%'` — checked here,
//   statement by statement, rather than trusted. That scope is the whole safety
//   argument of the file: a DELETE that lost its fence would take the real lots
//   with it, so an unfenced statement is a hard refusal, not a warning.
//
// Verified rather than trusted: "no exception was thrown" is not evidence. Both
// files are read back out of information_schema / pg_indexes / the rows
// themselves. E-250's verification is the one that earns its keep — auction_lots
// has NO foreign keys pointing at it (verified against information_schema: the
// constraint list is empty), so nothing cascades and a forgotten child table
// leaves orphan rows that commit perfectly happily. Every table carrying a
// lot_id is checked for orphans afterwards, and the real lots are counted before
// and after to prove the fence held.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").split("=")[1] ?? null;

const F249 = "drizzle/E-249_auction_settlement_payment_refinance.sql";
const F250 = "drizzle/E-250_remove_demo_auction_lots.sql";

function resolveUrl() {
    if (process.env.DATABASE_URL) {
        return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
    }
    const env = readFileSync(".env.local", "utf8");
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
    return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local (NOT explicit — check the host below)" };
}

// Strips $c$…$c$ COMMENT payloads and `--` line comments. Both files are mostly
// prose and a naive scan reads an English "update"/"delete" in a comment as a
// statement. $do$…$do$ blocks are deliberately NOT stripped — that is where the
// real DDL lives and is exactly what needs scanning.
function stripProse(sqlText) {
    return sqlText.replace(/\$c\$[\s\S]*?\$c\$/g, "''").replace(/--[^\n]*/g, "");
}

function assertAdditive(sqlText, label) {
    const stripped = stripProse(sqlText);
    const forbidden = [
        /\bDROP\s+COLUMN\b/i, /\bDROP\s+TABLE\b/i, /\bDROP\s+INDEX\b/i,
        /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i,
        /\bUPDATE\s+\w+\s+SET\b/i, /\bALTER\s+TYPE\b/i,
        /\bSET\s+NOT\s+NULL\b/i, /\bRENAME\b/i,
    ];
    const hits = forbidden.filter((re) => re.test(stripped)).map(String);
    if (hits.length) {
        console.log(`REFUSING TO RUN ${label} — non-additive statement(s) found:`, hits.join(", "));
        process.exit(1);
    }
}

// The data-removal guard. Schema-destructive verbs stay banned; DELETE/UPDATE
// are allowed ONLY while every one of them is fenced to the demo lots.
//
// This is a stricter job than the backfill guard it replaces. An INSERT that
// lost its WHERE clause adds junk; a DELETE that loses its WHERE clause empties
// the auction. The fence is not a stylistic check — it is the only thing
// standing between this file and every real lot on the database.
function assertDemoScopedRemoval(sqlText, label) {
    const stripped = stripProse(sqlText);
    const forbidden = [
        /\bDROP\s+COLUMN\b/i, /\bDROP\s+TABLE\b/i, /\bDROP\s+INDEX\b/i,
        /\bTRUNCATE\b/i, /\bALTER\s+TYPE\b/i, /\bRENAME\b/i,
    ];
    const hits = forbidden.filter((re) => re.test(stripped)).map(String);
    if (hits.length) {
        console.log(`REFUSING TO RUN ${label} — destructive statement(s) found:`, hits.join(", "));
        process.exit(1);
    }
    const mutations = stripped
        .split(";")
        .filter((s) => /\b(DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+INTO)\b/i.test(s));
    if (mutations.length === 0) {
        console.log(`REFUSING TO RUN ${label} — no mutating statement found at all. Wrong file?`);
        process.exit(1);
    }
    const unscoped = mutations.filter((s) => !/lot_code\s+LIKE\s+'DEMO-LOT-%'/i.test(s));
    if (unscoped.length) {
        console.log(
            `REFUSING TO RUN ${label} — ${unscoped.length} mutating statement(s) are NOT fenced to ` +
                `lot_code LIKE 'DEMO-LOT-%'. That fence is the file's entire safety argument.`,
        );
        for (const s of unscoped) console.log("  >>", s.trim().replace(/\s+/g, " ").slice(0, 160));
        process.exit(1);
    }
    console.log(`OK — ${label}: ${mutations.length} mutating statement(s), all fenced to DEMO-LOT-%.`);
}

// Every table in the public schema carrying a lot reference. The first delete
// draft hand-listed four of these and missed nbfc_auction_lot_actions, which
// held 5 demo rows — hence a catalogue-derived list, checked for orphans after.
const LOT_CHILD_TABLES = [
    "auction_auto_bids", "auction_bids", "auction_lot_audience", "auction_lot_items",
    "auction_lot_visibility", "auction_settlements", "nbfc_auction_cancel_requests",
    "nbfc_auction_lot_actions",
];

const E249_COLUMNS = [
    ["auction_settlements", "payment_ref", "character varying"],
    ["auction_settlements", "payment_provider", "character varying"],
    ["auction_settlements", "paid_at", "timestamp with time zone"],
    ["auction_settlements", "refinance_loan_id", "character varying"],
    ["auction_settlements", "failure_reason", "text"],
];
const E249_INDEXES = ["auction_settlements_payment_ref_idx", "auction_settlements_refinance_loan_idx"];

const { url, from } = resolveUrl();
const ddl249 = readFileSync(F249, "utf8");
const ddl250 = readFileSync(F250, "utf8");

const run249 = ONLY === null || ONLY === "249";
const run250 = ONLY === null || ONLY === "250";
if (ONLY !== null && !run249 && !run250) {
    console.log(`--only=${ONLY} is not one of 249, 250.`);
    process.exit(1);
}

console.log("GUARDS");
if (run249) { assertAdditive(ddl249, "E-249"); console.log("OK — E-249: pure additive DDL, no forbidden statement."); }
if (run250) assertDemoScopedRemoval(ddl250, "E-250");
console.log();

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
    console.log(DRY_RUN ? "MODE: dry run (nothing will be written)" : "MODE: APPLY");
    console.log(`FILES: ${[run249 && "E-249", run250 && "E-250"].filter(Boolean).join(" + ")}\n`);

    // ---- prerequisites -----------------------------------------------------
    // E-249 needs E-232's auction_settlements; E-250 additionally needs E-234's
    // visibility/audience tables. Naming the missing one beats a bare 42P01
    // thrown from the middle of a file.
    const prereq = run250
        ? ["auction_settlements", "auction_lots"]
        : ["auction_settlements"];
    for (const t of prereq) {
        const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
        if (r === null) {
            console.log(
                `FAILED — ${t} does not exist on this DB. ` +
                    (t.startsWith("auction_lot_") ? "Run scripts/apply-e234.mjs first." : "Run scripts/apply-e232.mjs first."),
            );
            process.exit(1);
        }
    }
    console.log(`OK — all ${prereq.length} prerequisite table(s) present.`);

    // E-250 no longer has an ON CONFLICT of any kind — it deletes. What it does
    // need is for every child table it names to exist, because a missing one
    // aborts the transaction halfway and leaves the parent rows behind.
    if (run250) {
        const missing = [];
        for (const t of LOT_CHILD_TABLES) {
            const [{ r }] = await sql`SELECT to_regclass(${t}) AS r`;
            if (r === null) missing.push(t);
        }
        console.log(
            missing.length === 0
                ? `OK — all ${LOT_CHILD_TABLES.length} lot child table(s) present.`
                : `FAILED — missing child table(s): ${missing.join(", ")}. E-250 would abort mid-transaction.`,
        );
        if (missing.length) process.exit(1);
    }

    // ---- before-state ------------------------------------------------------
    let before249 = 0;
    if (run249) {
        for (const [table, column] of E249_COLUMNS) {
            const [row] = await sql`
                SELECT 1 AS present FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
            if (row) before249++;
        }
        console.log(`E-249 columns already present before this run: ${before249}/${E249_COLUMNS.length}`);
    }

    let realLotsBefore = 0;
    if (run250) {
        const [{ n: demoLots }] = await sql`SELECT count(*)::int AS n FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%'`;
        const [{ n: realLots }] = await sql`SELECT count(*)::int AS n FROM auction_lots WHERE lot_code NOT LIKE 'DEMO-LOT-%'`;
        realLotsBefore = realLots;
        console.log(`E-250 target rows: ${demoLots} demo lot(s). Real lots on this DB (must be untouched): ${realLots}`);
        if (demoLots === 0) console.log("  NOTE — no DEMO-LOT-% rows here. E-250 will be a legitimate no-op.");
        for (const t of LOT_CHILD_TABLES) {
            const [{ n }] = await sql.unsafe(
                `SELECT count(*)::int AS n FROM ${t} t JOIN auction_lots l ON l.id = t.lot_id WHERE l.lot_code LIKE 'DEMO-LOT-%'`,
            );
            if (n > 0) console.log(`  ${t}: ${n} row(s) will go with them.`);
        }
    }

    if (DRY_RUN) {
        console.log("\nDry run — files parsed, guards passed, prerequisites verified. Nothing written.");
        await sql.end({ timeout: 5 });
        process.exit(0);
    }

    // ---- apply -------------------------------------------------------------
    if (run249) {
        await sql.unsafe(ddl249);
        console.log("\nE-249 executed. Verifying...");
        for (const [table, column, expectedType] of E249_COLUMNS) {
            const [row] = await sql`
                SELECT data_type, is_nullable FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
            if (!row) { console.log(`  FAILED — ${table}.${column} is MISSING.`); failed = true; continue; }
            // Nullable is not incidental: NULL is "no money has moved yet", the
            // state every existing settlement is legitimately in.
            const ok = row.data_type === expectedType && row.is_nullable === "YES";
            console.log(ok
                ? `  OK — ${table}.${column} (${row.data_type}, nullable)`
                : `  FAILED — ${table}.${column} is ${row.data_type}/${row.is_nullable}, expected ${expectedType}/YES.`);
            if (!ok) failed = true;
        }
        for (const idx of E249_INDEXES) {
            const [row] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${idx}`;
            console.log(row ? `  OK — index ${idx} present.` : `  FAILED — index ${idx} is MISSING.`);
            if (!row) failed = true;
        }
        // No backfill ships with E-249, on purpose: every existing settlement
        // must stay NULL, which is the honest record that nothing proved payment.
        const [{ total, paid }] = await sql`
            SELECT count(*)::int AS total, count(paid_at)::int AS paid FROM auction_settlements`;
        console.log(`  Settlements on this DB: ${total}; carrying a paid_at: ${paid} (expected 0 immediately after apply).`);
    }

    if (run250) {
        await sql.unsafe(ddl250);
        console.log("\nE-250 executed. Verifying...");

        const [{ n: leftover }] = await sql`
            SELECT count(*)::int AS n FROM auction_lots WHERE lot_code LIKE 'DEMO-LOT-%'`;
        console.log(leftover === 0
            ? "  OK — no DEMO-LOT-% rows remain."
            : `  FAILED — ${leftover} demo lot(s) survived the delete.`);
        if (leftover !== 0) failed = true;

        // The check that earns its keep. auction_lots has NO foreign keys
        // pointing at it, so a child table the file forgot to name does not
        // raise anything — it commits, and the orphans sit there for ever
        // pointing at a lot id that no longer resolves.
        for (const t of LOT_CHILD_TABLES) {
            const [{ n }] = await sql.unsafe(
                `SELECT count(*)::int AS n FROM ${t} t
                  WHERE t.lot_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM auction_lots l WHERE l.id = t.lot_id)`,
            );
            if (n === 0) {
                console.log(`  OK — ${t}: no orphan rows.`);
            } else {
                console.log(`  FAILED — ${t}: ${n} orphan row(s) pointing at a deleted lot.`);
                failed = true;
            }
        }

        // Proof the fence held: the delete must not have cost a single real lot.
        const [{ n: realLotsAfter }] = await sql`
            SELECT count(*)::int AS n FROM auction_lots WHERE lot_code NOT LIKE 'DEMO-LOT-%'`;
        console.log(realLotsAfter === realLotsBefore
            ? `  OK — real lots untouched: ${realLotsAfter} before and after.`
            : `  FAILED — real lots went from ${realLotsBefore} to ${realLotsAfter}. THE FENCE LEAKED.`);
        if (realLotsAfter !== realLotsBefore) failed = true;

        // A demo lot with items would have stranded its batteries in 'lotted',
        // where nothing can sell them. There are none today; the file releases
        // them anyway, and this proves it.
        const [{ n: stuck }] = await sql`
            SELECT count(*)::int AS n FROM recovery_batteries b
             WHERE b.state_code = 'lotted'
               AND NOT EXISTS (
                     SELECT 1 FROM auction_lot_items i
                      JOIN auction_lots l ON l.id = i.lot_id
                     WHERE i.battery_id = b.id)`;
        console.log(stuck === 0
            ? "  OK — no battery left stranded in state_code='lotted'."
            : `  FAILED — ${stuck} batter(y/ies) sit in 'lotted' with no lot item to sell them.`);
        if (stuck !== 0) failed = true;
    }

    if (failed) {
        console.log("\nFAILED verification. Do not tick the checklist. Investigate before testing Phase 6.");
        process.exit(1);
    }
    console.log("\nApplied and verified. Tick this DB's box in drizzle/MIGRATION_CHECKLIST.md.");
    if (run249) console.log("  E-249 unblocks: settlement payment capture + the refinance link (Step 8 of the test plan).");
    if (run250) console.log("  E-250 removed the five DEMO-LOT-* rows and every child row hanging off them.");
} catch (err) {
    console.error("\nERROR:", err?.message ?? err);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 5 });
}
