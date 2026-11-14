// Read-only (ID 226): every E- number used by more than one drizzle/E-*.sql file, and,
// when a database is named, whether each file's objects are on that database.
//
//   node scripts/list-duplicate-migration-numbers.mjs                 # files only, no DB
//   node scripts/list-duplicate-migration-numbers.mjs database-1      # + sandbox state
//   node scripts/list-duplicate-migration-numbers.mjs database-2      # + live state
//   ENV_FILE=../.env.local node scripts/list-duplicate-migration-numbers.mjs database-1
//
// "on DB" = every table / column / index the file creates exists (all), some do
// (partly), none do (no), or the file creates nothing the catalog can show (n/a:
// data-only or COMMENT/ALTER TYPE files). Renames nothing: renaming an applied file
// needs Kartik's OK. Only SELECTs on the catalog; the URL is never printed.
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";

const target = process.argv[2];
const files = readdirSync("drizzle")
    .filter((f) => /^E-\d+.*\.sql$/i.test(f))
    .map((f) => ({ f, n: Number(f.match(/^E-(\d+)/i)[1]) }));
const byNumber = new Map();
for (const x of files) byNumber.set(x.n, [...(byNumber.get(x.n) ?? []), x.f]);
const dupes = [...byNumber.entries()].filter(([, fs]) => fs.length > 1).sort((a, b) => a[0] - b[0]);

const name = (s) => s.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();
function objectsOf(f) {
    const text = readFileSync(`drizzle/${f}`, "utf8").replace(/--[^\n]*/g, "");
    const tables = [...text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi)].map((m) => name(m[1]));
    const indexes = [...text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)\s+ON/gi)].map((m) => name(m[1]));
    const columns = [];
    for (const m of text.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?[\w.]+"?)([\s\S]*?)(?:;|'\s*\)|\$\w*\$)/gi)) {
        for (const c of m[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)/gi)) columns.push(`${name(m[1])}.${name(c[1])}`);
    }
    return { tables, indexes, columns };
}

let state = null;
if (target) {
    if (!["database-1", "database-2"].includes(target)) throw new Error("usage: [database-1 | database-2]");
    const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
        .split(/\r?\n/)
        .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
    if (!line) throw new Error(`no DATABASE_URL for ${target} in the env file`);
    const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
    if (!new URL(url).host.startsWith(`${target}.`)) throw new Error("host mismatch");
    const sql = postgres(url, { max: 1, prepare: false, ssl: { rejectUnauthorized: false } });
    try {
        const [t, c, i] = await sql.begin("read only", async (tx) => [
            await tx`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`,
            await tx`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`,
            await tx`SELECT indexname AS i FROM pg_indexes WHERE schemaname = 'public'`,
        ]);
        state = {
            T: new Set(t.map((r) => r.t)),
            C: new Set(c.map((r) => `${r.t}.${r.c}`)),
            I: new Set(i.map((r) => r.i)),
        };
    } finally {
        await sql.end();
    }
}

function onDb(f) {
    const o = objectsOf(f);
    const checks = [...o.tables.map((x) => state.T.has(x)), ...o.indexes.map((x) => state.I.has(x)), ...o.columns.map((x) => state.C.has(x))];
    if (!checks.length) return "n/a";
    const yes = checks.filter(Boolean).length;
    return yes === checks.length ? "all" : yes === 0 ? "no" : `partly (${yes}/${checks.length})`;
}

console.log(`${dupes.length} E- numbers are used by more than one file${target ? ` · state on ${target}` : ""}\n`);
for (const [n, fs] of dupes) {
    console.log(`E-${String(n).padStart(3, "0")}`);
    for (const f of fs.sort()) console.log(`    ${f}${state ? `   on DB: ${onDb(f)}` : ""}`);
}
console.log("\nNext new file: npm run migration:next. No applied file is renamed without Kartik's OK.");
