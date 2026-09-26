// Applies drizzle/E-309_wa_assistant.sql (WhatsApp Sales Assistant, five NEW
// tables) and then PROVES it landed, on a FRESH connection.
//
//   node --env-file=.env.local      scripts/apply-e309.mjs --target sandbox --verify-only
//   node --env-file=.env.local      scripts/apply-e309.mjs --target sandbox
//   node --env-file=.env.production scripts/apply-e309.mjs --target prod --verify-only
//   node --env-file=.env.production scripts/apply-e309.mjs --target prod      # needs an explicit go-ahead
//
// --target is REQUIRED and must match the host (database-1 = sandbox,
// database-2 = prod), so the wrong .env file cannot apply to the wrong DB.
// The file is applied TWICE: the second pass must be a no-op (idempotency).
// There is no dry-run on purpose: DDL through postgres.js unsafe() escapes a
// BEGIN … ROLLBACK (see team memory), so a "dry run" would really apply.
// Additive only — nothing existing is touched. Runbook: docs/wa-assistant/RUNBOOK.md §2.

import { readFileSync } from "node:fs";
import postgres from "postgres";

const FILE = "drizzle/E-309_wa_assistant.sql";
const TABLES = ["assistant_wa_bindings", "assistant_conversations", "assistant_actions", "assistant_wa_messages", "assistant_tool_calls"];
/** index → a fragment its definition must contain (partial indexes carry their predicate). */
const INDEXES = {
    assistant_wa_bindings_active_user_uniq: "WHERE ((status)::text = 'active'",
    assistant_wa_bindings_active_phone_uniq: "WHERE ((status)::text = 'active'",
    assistant_wa_bindings_pending_user_uniq: "WHERE ((status)::text = 'pending'",
    assistant_wa_bindings_pending_code_uniq: "WHERE ((status)::text = 'pending'",
    assistant_conversations_user_channel_uniq: "UNIQUE",
    assistant_actions_user_status_idx: "(user_id, status)",
    assistant_actions_open_expiry_idx: "WHERE",
    assistant_wa_messages_provider_id_uniq: "UNIQUE",
    assistant_wa_messages_phone_created_idx: "(wa_phone, created_at)",
    assistant_wa_messages_user_created_idx: "(user_id, created_at)",
    assistant_wa_messages_unhandled_idx: "handled_at IS NULL",
    assistant_tool_calls_user_created_idx: "(user_id, created_at)",
};

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const connect = (url) => postgres(url, { ssl: { rejectUnauthorized: false }, max: 1, onnotice: () => {} });

async function verify(url) {
    const sql = connect(url);
    try {
        const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY(${TABLES})`;
        const have = new Set(t.map((r) => r.table_name));
        const idx = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY(${Object.keys(INDEXES)})`;
        const defs = new Map(idx.map((r) => [r.indexname, r.indexdef]));
        const problems = [
            ...TABLES.filter((x) => !have.has(x)).map((x) => `table ${x} missing`),
            ...Object.entries(INDEXES).flatMap(([name, frag]) =>
                !defs.has(name) ? [`index ${name} missing`] : defs.get(name).includes(frag) ? [] : [`index ${name} lacks "${frag}": ${defs.get(name)}`],
            ),
        ];
        console.log(`tables : ${have.size}/${TABLES.length}   indexes: ${defs.size}/${Object.keys(INDEXES).length}`);
        return problems;
    } finally {
        await sql.end();
    }
}

async function main() {
    const target = arg("--target");
    const verifyOnly = process.argv.includes("--verify-only");
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set — pass --env-file=.env.local or .env.production");
    if (target !== "sandbox" && target !== "prod") throw new Error("--target sandbox|prod is required");
    const host = new URL(url).host;
    const actual = host.startsWith("database-2.") ? "prod" : host.startsWith("database-1.") ? "sandbox" : "unknown";
    console.log(`host   : ${host}  (${actual})`);
    console.log(`mode   : ${verifyOnly ? "VERIFY ONLY (read-only)" : "APPLY ×2 + verify"}`);
    if (actual !== target) {
        console.error(`ABORT: --target ${target} but the host is ${actual}.`);
        process.exit(2);
    }

    if (!verifyOnly) {
        const ddl = readFileSync(FILE, "utf8");
        for (const pass of [1, 2]) {
            const sql = connect(url);
            try {
                await sql.unsafe(ddl);
                console.log(`pass ${pass}: applied`);
            } finally {
                await sql.end();
            }
        }
    }

    const problems = await verify(url); // a fresh connection
    if (problems.length) {
        console.error(`${verifyOnly ? "NOT APPLIED / INCOMPLETE" : "FAILED"}:\n  ${problems.join("\n  ")}`);
        process.exit(1);
    }
    console.log("OK — E-309 is fully present.");
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
