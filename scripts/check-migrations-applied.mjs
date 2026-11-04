// Read-only: which drizzle/E-*.sql migrations are not fully on a database.
//
//   node scripts/check-migrations-applied.mjs database-1          # sandbox
//   node scripts/check-migrations-applied.mjs database-2          # prod
//   node scripts/check-migrations-applied.mjs database-2 E-300    # only E-300 and later
//   ENV_FILE=../.env.local node scripts/check-migrations-applied.mjs database-1   (from a worktree)
//
// Reads every migration file, pulls out the tables (CREATE TABLE IF NOT EXISTS),
// columns (ADD COLUMN IF NOT EXISTS) and indexes (CREATE INDEX IF NOT EXISTS) it
// creates, and looks each one up in the catalog. Not reported as gaps:
//   - a column whose table does not exist at all (the migration's skip block);
//   - an index or table a LATER migration drops or renames on purpose;
//   - the other branch of an either/or inside one migration (ALTERNATIVES).
// Only SELECTs on the catalog; the URL is never printed.
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";

const target = process.argv[2];
const from = Number((process.argv[3] ?? "E-0").replace(/^E-/i, "")) || 0;
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2 [E-NNN]");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
    .split(/\r?\n/)
    .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);

const name = (s) => s.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const all = readdirSync("drizzle")
    .filter((f) => /^E-\d+.*\.sql$/i.test(f))
    .map((f) => ({
        f,
        n: Number(f.match(/^E-(\d+)/i)[1]),
        text: readFileSync(`drizzle/${f}`, "utf8").replace(/--[^\n]*/g, ""),
    }))
    .sort((a, b) => a.n - b.n || a.f.localeCompare(b.f));

const laterMatches = (n, re) => all.some((x) => x.n > n && re.test(x.text));
const indexSuperseded = (n, i) =>
    laterMatches(n, new RegExp(`DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?"?(?:public\\.)?${esc(i)}"?\\b`, "i"));
const tableSuperseded = (n, t) =>
    laterMatches(n, new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${esc(t)}"?\\s+RENAME\\s+TO\\b`, "i")) ||
    laterMatches(n, new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${esc(t)}"?\\b`, "i"));
// Either/or branches inside one migration: index created only when the other could not be.
const ALTERNATIVES = { co_borrowers_lead_idx_nonunique: "co_borrowers_lead_unique" };

const wants = all
    .filter((x) => x.n >= from)
    .map(({ f, n, text }) => {
        const tables = [...text.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+("?[\w.]+"?)/gi)].map((m) => name(m[1]));
        const indexes = [...text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+("?\w+"?)/gi)].map((m) => name(m[1]));
        const columns = [];
        for (const m of text.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?[\w.]+"?)([\s\S]*?)(?:;|'\s*\)|\$\w*\$)/gi)) {
            for (const c of m[2].matchAll(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+("?\w+"?)/gi)) columns.push([name(m[1]), name(c[1])]);
        }
        return { f, n, tables, indexes, columns };
    });

const sql = postgres(url, { max: 1, prepare: false, ssl: { rejectUnauthorized: false } });
try {
    const [tabs, cols, idxs] = await sql.begin("read only", async (tx) => [
        await tx`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`,
        await tx`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`,
        await tx`SELECT indexname AS i FROM pg_indexes WHERE schemaname = 'public'`,
    ]);
    const T = new Set(tabs.map((r) => r.t));
    const C = new Set(cols.map((r) => `${r.t}.${r.c}`));
    const I = new Set(idxs.map((r) => r.i));

    console.log(`DB: ${host.split(".")[0]}  checked ${wants.length} files from E-${from}\n`);
    let gaps = 0;
    for (const w of wants) {
        const goneTables = w.tables.filter((t) => tableSuperseded(w.n, t));
        const missing = [
            ...w.tables.filter((t) => !T.has(t) && !goneTables.includes(t)).map((t) => `table ${t}`),
            ...w.columns.filter(([t, c]) => T.has(t) && !C.has(`${t}.${c}`)).map(([t, c]) => `column ${t}.${c}`),
            ...w.indexes
                .filter((i) => !I.has(i) && !indexSuperseded(w.n, i))
                .filter((i) => !(ALTERNATIVES[i] && I.has(ALTERNATIVES[i])))
                .filter((i) => !goneTables.some((t) => i.startsWith(t)))
                .map((i) => `index ${i}`),
        ];
        if (!missing.length) continue;
        const absent = [...new Set(w.columns.filter(([t]) => !T.has(t) && !w.tables.includes(t)).map(([t]) => t))];
        gaps++;
        console.log(`${w.f}\n    MISSING ${missing.join(", ")}${absent.length ? `\n    (table absent, skipped: ${absent.join(", ")})` : ""}`);
    }
    console.log(gaps ? `\n${gaps} migration file(s) not fully applied.` : "All checked migrations are present.");
} finally {
    await sql.end();
}
