// ID 223 — how long a data download takes to build on this database, and how
// big it is. Read-only: builds the file in memory, writes nothing, sends nothing.
//
//   node --import tsx --env-file=.env.local scripts/time-data-download.ts [dataset] [xlsx|csv|both] [k=v ...]
//   e.g. scripts/time-data-download.ts leads both            (all leads, all columns)
//        scripts/time-data-download.ts calls csv from=2026-10-01
//
// Builds as an Admin (every row). Used to set AT_ONCE_ROWS in
// src/lib/exports/datasets/types.ts: above that size a download is emailed.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { datasetById } from "@/lib/exports/datasets/registry";
import { buildCsv, buildXlsx } from "@/lib/exports/datasets/workbook";

async function main() {
    const [id = "leads", format = "both", ...kv] = process.argv.slice(2);
    const dataset = datasetById(id);
    if (!dataset) throw new Error(`no dataset ${id}`);
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host}`);
    const [admin] = (await db.execute(sql`
        SELECT id::text AS id, name, email, role FROM users WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1
    `)) as unknown as Array<{ id: string; name: string; email: string; role: string }>;
    const params = new URLSearchParams(kv.map((p) => p.split("=") as [string, string]));
    const run = { params, user: admin as never, ownOnly: false, teamIds: [] as string[] };

    let t = Date.now();
    const count = await dataset.count(run);
    console.log(`count: ${count.toLocaleString("en-IN")} rows in ${((Date.now() - t) / 1000).toFixed(1)} s`);

    t = Date.now();
    const sheets = await dataset.build(run);
    const buildS = (Date.now() - t) / 1000;
    console.log(`build: ${sheets.map((s) => `${s.name} ${s.rows.length}`).join(", ")} in ${buildS.toFixed(1)} s`);
    const ctx = { datasetLabel: dataset.label, downloadedBy: "timing", filters: {}, fullPhone: false, ownOnly: false };
    if (format === "csv" || format === "both") {
        t = Date.now();
        const csv = buildCsv(sheets[0], ctx);
        console.log(`csv: ${(csv.length / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s → total ${(buildS + (Date.now() - t) / 1000).toFixed(1)} s`);
    }
    if (format === "xlsx" || format === "both") {
        t = Date.now();
        const buf = await buildXlsx(sheets, ctx);
        console.log(`xlsx: ${(buf.byteLength / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s → total ${(buildS + (Date.now() - t) / 1000).toFixed(1)} s`);
    }
    console.log(`heap used: ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
