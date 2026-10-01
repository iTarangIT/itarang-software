/**
 * Runs docs/wa-assistant/review.sql — the WhatsApp Sales Assistant daily log
 * review (RUNBOOK §7). READ-ONLY: every block runs in a READ ONLY transaction.
 *
 *   node --import tsx --env-file=.env.production scripts/wa-assistant-daily-review.ts [--since '7 days']
 *
 * Exit code 1 when a MUST BE EMPTY block (a go/no-go incident) returns rows.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";

export type ReviewBlock = { name: string; mustBeEmpty: boolean; statement: string };

const WINDOW = "interval '24 hours'";

/** Split review.sql into its named blocks, with the window swapped for `since`. */
export function loadReview(since = "24 hours", file = "docs/wa-assistant/review.sql"): ReviewBlock[] {
    if (!/^\d+\s+(minutes?|hours?|days?)$/.test(since)) throw new Error(`--since must look like '24 hours' or '7 days', got "${since}"`);
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    return text
        .split(/^-- name: /m)
        .slice(1)
        .map((chunk) => {
            const name = chunk.slice(0, chunk.indexOf("\n")).trim();
            const body = chunk.slice(chunk.indexOf("\n") + 1);
            const statement = body
                .split("\n")
                .filter((l) => !l.trimStart().startsWith("--"))
                .join("\n")
                .trim()
                .replace(/;\s*$/, "")
                .replaceAll(WINDOW, `interval '${since}'`);
            return { name, mustBeEmpty: /MUST BE EMPTY/.test(body), statement };
        });
}

/** Run every block read-only. */
export async function runReview(since = "24 hours"): Promise<(ReviewBlock & { rows: Record<string, unknown>[] })[]> {
    const out = [];
    for (const b of loadReview(since)) {
        const rows = await db.transaction(async (tx) => {
            await tx.execute(sql`SET TRANSACTION READ ONLY`);
            return tx.execute<Record<string, unknown>>(sql.raw(b.statement));
        });
        out.push({ ...b, rows: [...rows] });
    }
    return out;
}

async function main() {
    const i = process.argv.indexOf("--since");
    const since = i >= 0 ? process.argv[i + 1]! : "24 hours";
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
    console.log(`WA Assistant daily review — ${host} — last ${since}\n`);
    const results = await runReview(since);
    let incidents = 0;
    for (const r of results) {
        const flag = r.mustBeEmpty ? (r.rows.length ? "❌ INCIDENT" : "✅ empty") : `${r.rows.length} row(s)`;
        if (r.mustBeEmpty && r.rows.length) incidents++;
        console.log(`── ${r.name}  ${flag}`);
        if (r.rows.length) console.table(r.rows.slice(0, 50));
    }
    console.log(incidents ? `\n${incidents} MUST-BE-EMPTY check(s) returned rows — see RUNBOOK §5 (pause) and §7.` : "\nNo go/no-go incidents.");
    process.exit(incidents ? 1 : 0);
}

if (process.argv[1]?.includes("wa-assistant-daily-review")) void main();
