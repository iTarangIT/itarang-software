/**
 * ID 118 — the 30-day server log check (Kartik, 10 Oct: "check the last 30
 * days of server logs for outside use of the routes that were open").
 *
 * Read-only log analyser. Counts the API gate's "[api-gate] would refuse
 * unauthenticated <METHOD> <path>" lines (src/middleware.ts, written while
 * API_AUTH_GATE=report) — and "refused" once it is set to enforce — per route,
 * over the last N days of the given log file(s). Touches no database and no
 * network; nothing is written.
 *
 *   node --import tsx scripts/verify-id118-open-routes-30d.ts <log file> [more files…] [--days=30] [--until=2026-10-16] [--top=60]
 *
 * Copy the log off the server first (e.g. htdocs/crm.itarang.com/logs/web.err.log
 * and web.out.log — see the prod logs note) and run this on the copy; do not
 * run it on the live box.
 *
 * Dates: a line is dated by a leading timestamp (pm2 --time "2026-10-13T08:01:02",
 * ISO with zone, or "2026-10-13 08:01:02"). The window ends at --until, else at
 * the newest dated line in the files (never this machine's clock). Undated
 * lines cannot be placed in the window: they are counted separately.
 *
 * Paths are grouped with ids folded (UUIDs, LEAD-… ids, long numbers → :id), so
 * one route shows once however many leads were asked for.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DAYS = Number(opt("days") ?? "30") || 30;
const TOP = Number(opt("top") ?? "60") || 60;
const UNTIL = opt("until");

const GATE = /\[api-gate\] (would refuse|refused) unauthenticated ([A-Z]+) (\S+)/;
const STAMP = /^\s*\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/;

/** Fold ids so one route is one row. Exported shape kept simple for reading. */
function routeKey(path: string): string {
    return (
        path
            .split("?")[0]
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
            .replace(/\b[A-Z]{2,10}-\d{6,8}-[0-9a-f]{4,12}\b/gi, ":id")
            .replace(/\/\d{4,}(?=\/|$)/g, "/:id")
            // a file under the stored-file proxies: keep the folder, drop the file
            .replace(/^(\/api\/files\/[^/]+\/[^/]+)\/.*$/, "$1/…")
            .replace(/^(\/api\/nbfc-uploads\/[^/]+)\/.*$/, "$1/…")
    );
}

function stampOf(line: string): Date | null {
    const m = STAMP.exec(line);
    if (!m) return null;
    const zone = m[3] ? (m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")) : "+05:30";
    const d = new Date(`${m[1]}T${m[2]}${zone}`);
    return Number.isNaN(d.getTime()) ? null : d;
}

type Hit = { at: Date | null; verdict: string; method: string; route: string; raw: string };

async function readHits(file: string): Promise<Hit[]> {
    const hits: Hit[] = [];
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
        const m = GATE.exec(line);
        if (!m) continue;
        hits.push({ at: stampOf(line), verdict: m[1], method: m[2], route: routeKey(m[3]), raw: m[3] });
    }
    return hits;
}

async function main() {
    if (files.length === 0) {
        console.error("usage: node --import tsx scripts/verify-id118-open-routes-30d.ts <log file> [...] [--days=30] [--until=YYYY-MM-DD]");
        process.exit(2);
    }
    const hits = (await Promise.all(files.map(readHits))).flat();
    const dated = hits.filter((h) => h.at);
    const newest = dated.reduce<Date | null>((m, h) => (!m || h.at! > m ? h.at! : m), null);
    const end = UNTIL ? new Date(`${UNTIL}T23:59:59+05:30`) : newest;
    const start = end ? new Date(end.getTime() - DAYS * 24 * 60 * 60 * 1000) : null;
    const oldest = dated.reduce<Date | null>((m, h) => (!m || h.at! < m ? h.at! : m), null);

    const inWindow = dated.filter((h) => start && end && h.at! >= start && h.at! <= end);
    const undated = hits.filter((h) => !h.at);

    console.log(`files: ${files.join(", ")}`);
    console.log(`gate lines found: ${hits.length} (dated ${dated.length}, undated ${undated.length})`);
    console.log(`log covers: ${oldest?.toISOString() ?? "—"} … ${newest?.toISOString() ?? "—"}`);
    console.log(`window (${DAYS} days): ${start?.toISOString() ?? "—"} … ${end?.toISOString() ?? "—"}`);
    if (oldest && start && oldest > start) {
        console.log(`NOTE: the log starts after the window opens — it covers only ${Math.round((end!.getTime() - oldest.getTime()) / 86_400_000)} of the ${DAYS} days.`);
    }

    const table = (rows: Hit[], label: string) => {
        const by = new Map<string, { n: number; first: Date | null; last: Date | null; verdicts: Set<string>; sample: string }>();
        for (const h of rows) {
            const k = `${h.method} ${h.route}`;
            const e = by.get(k) ?? { n: 0, first: null, last: null, verdicts: new Set<string>(), sample: h.raw };
            e.n++;
            e.verdicts.add(h.verdict);
            if (h.at && (!e.first || h.at < e.first)) e.first = h.at;
            if (h.at && (!e.last || h.at > e.last)) e.last = h.at;
            by.set(k, e);
        }
        const sorted = [...by.entries()].sort((a, b) => b[1].n - a[1].n);
        console.log(`\n${label}: ${rows.length} lines, ${sorted.length} routes`);
        console.log("count  verdict        first seen        last seen         route");
        for (const [k, e] of sorted.slice(0, TOP)) {
            const d = (x: Date | null) => (x ? x.toISOString().slice(0, 16).replace("T", " ") : "—".padEnd(16));
            console.log(`${String(e.n).padStart(5)}  ${[...e.verdicts].join("/").padEnd(13)}  ${d(e.first)}  ${d(e.last)}  ${k}`);
        }
        if (sorted.length > TOP) console.log(`… ${sorted.length - TOP} more routes (--top=N to see them)`);
    };

    table(inWindow, `In the ${DAYS}-day window`);
    if (undated.length) table(undated, "Undated lines (outside the window check; add pm2 --time to date them)");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
