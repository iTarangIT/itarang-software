// Read-only check for Reports › Data downloads (tracker ID 13).
//
// Runs the REAL dataset builders (src/lib/exports/datasets/registry.ts) as an
// admin would, counts their rows, and builds the Excel file in memory — nothing
// is written and nothing is logged. A dataset whose migration is missing on
// this database is reported, not fatal.
//
//   node --import tsx --env-file=.env.local scripts/verify-data-downloads.ts [from=YYYY-MM-DD] [to=YYYY-MM-DD]

import { DATASETS, type RunContext } from "@/lib/exports/datasets/registry";
import { buildCsv, buildXlsx } from "@/lib/exports/datasets/workbook";

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);
    const params = new URLSearchParams(process.argv.slice(2).map((a) => a.split("=") as [string, string]));
    console.log(`filters: ${params.toString() || "(defaults)"}`);

    const user = { id: "00000000-0000-0000-0000-000000000000", role: "admin", name: "verify script", email: "verify@local" };
    for (const d of DATASETS) {
        const ctx = { params, user, ownOnly: false } as unknown as RunContext;
        try {
            const count = await d.count(ctx);
            const sheets = await d.build(ctx);
            const fileCtx = { datasetLabel: d.label, downloadedBy: "verify script", filters: Object.fromEntries(params), fullPhone: false, ownOnly: false };
            const xlsx = await buildXlsx(sheets, fileCtx);
            const csv = buildCsv(sheets[0], fileCtx);
            console.log(
                `- ${d.label}: count=${count}  ` +
                    sheets.map((s) => `${s.name}=${s.rows.length}`).join("  ") +
                    `  xlsx=${Math.round(xlsx.byteLength / 1024)} KB  csv=${Math.round(csv.length / 1024)} KB`,
            );
            const phoneCol = sheets[0].columns.find((c) => c.kind === "phone");
            if (phoneCol && sheets[0].rows[0]) {
                const line = csv.split("\r\n")[1] ?? "";
                console.log(`    first row (phone masked): ${line.slice(0, 140)}`);
            }
        } catch (e) {
            // Drizzle wraps the driver error; the cause says which column or table is missing.
            const cause = (e as { cause?: { message?: string } }).cause?.message;
            console.log(`- ${d.label}: FAILED — ${cause ?? (e as Error).message.split("\n")[0]}`);
        }
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
