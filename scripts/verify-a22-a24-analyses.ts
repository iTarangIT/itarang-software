// A22 / A23 / A24 — read-only: build the Cohorts, Turnaround and AI score
// outcomes analyses and require every check each one carries to hold.
//
//   node --import tsx --env-file=.env.local      scripts/verify-a22-a24-analyses.ts
//   node --import tsx --env-file=.env.production scripts/verify-a22-a24-analyses.ts

import { aiOutcomes, cohorts, turnaround } from "@/lib/reports/analysesGrid";
import { gridCell } from "@/lib/reports/analysesShared";

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    let failed = 0;
    for (const [name, build] of [
        ["Cohorts (A22)", cohorts],
        ["Turnaround (A23)", turnaround],
        ["AI score outcomes (A24)", aiOutcomes],
    ] as const) {
        const t0 = Date.now();
        const r = await build({});
        console.log(`== ${name} · ${r.period.from} → ${r.period.to} · ${r.rows.length} rows · ${Date.now() - t0} ms`);
        for (const row of [...r.rows, ...(r.total ? [r.total] : [])]) {
            console.log("   " + r.columns.map((c) => `${gridCell(row[c.key], c.kind)}`.padStart(c.kind === "text" ? 0 : 7)).join("  "));
        }
        for (const c of r.checks) {
            if (!c.holds) failed++;
            console.log(`${c.holds ? "PASS" : "FAIL"}  ${c.label}${c.detail ? `  ${c.detail}` : ""}`);
        }
        console.log("");
    }
    console.log(failed === 0 ? "All checks passed." : `${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
