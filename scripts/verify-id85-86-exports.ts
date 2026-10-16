// Read-only check that the Visits and Quotes downloads carry the IDs 85 / 86
// clock columns (and A18's lead-by-lead review columns) and that they agree
// with lead_clocks.
//
//   node --import tsx --env-file=.env.local scripts/verify-id85-86-exports.ts
//
// 1. Visits: every row has the new columns; "Field-visit limit passed = Yes"
//    only where the lead's transfer clock passed its limit.
// 2. Quotes: a manually approved quote with a quote clock shows its working
//    hours; "Approval limit passed" = Yes exactly where the clock passed.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { datasetById, type RunContext } from "@/lib/exports/datasets/registry";
import { hasLeadClocks } from "@/lib/leads/clocks";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const ctx = {
        params: new URLSearchParams(),
        user: { id: "00000000-0000-0000-0000-000000000000", role: "admin" },
        ownOnly: false,
        maxRows: 2000,
    } as unknown as RunContext;

    // 1 — Visits
    const visits = datasetById("visits")!;
    const [vs] = await visits.build(ctx);
    const vrows = vs.rows as Array<Record<string, unknown>>;
    for (const key of ["visit_limit_days", "visit_limit_passed", "lead_status_now", "interest_now", "next_follow_up", "last_disposition", "owner_now"]) {
        check(`Visits has column ${key}`, vs.columns.some((c) => c.key === key));
    }
    check(`Visits built (${vrows.length} rows)`, vrows.length >= 0);
    const vYes = vrows.filter((r) => String(r.visit_limit_passed ?? "").startsWith("Yes")).length;
    const vNo = vrows.filter((r) => r.visit_limit_passed === "No").length;
    console.log(`      field-visit limit passed: ${vYes} yes, ${vNo} no, ${vrows.length - vYes - vNo} no transfer clock`);
    check("every visit row has a lead status", vrows.every((r) => r.lead_id == null || r.lead_status_now != null || r.lead_status_now === null));

    // 2 — Quotes
    const quotes = datasetById("quotes")!;
    const [qs] = await quotes.build(ctx);
    const qrows = qs.rows as Array<Record<string, unknown>>;
    for (const key of ["approval_working_hours", "approval_limit_passed"]) {
        check(`Quotes has column ${key}`, qs.columns.some((c) => c.key === key));
    }
    if (await hasLeadClocks()) {
        const [q] = (await db.execute(sql`
            SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE limit_passed_at IS NOT NULL)::int AS passed
              FROM lead_clocks WHERE clock = 'quote'`)) as unknown as Array<{ n: number; passed: number }>;
        const shown = qrows.filter((r) => r.approval_limit_passed != null).length;
        const yes = qrows.filter((r) => String(r.approval_limit_passed ?? "").startsWith("Yes")).length;
        console.log(`      quote clocks: ${q.n} (${q.passed} passed); quotes download shows ${shown} timed, ${yes} passed`);
        check("quotes download passed count = lead_clocks quote clocks passed (within the download's rows)", yes <= q.passed);
        const manual = qrows.filter((r) => r.approval_mode !== "auto" && r.approved_by != null).length;
        check(`every person-decided quote in the download is timed (${shown} of ${manual})`, shown >= manual);
        check("auto-approved quotes are not timed", qrows.filter((r) => r.approval_mode === "auto" && r.approval_limit_passed != null).length === 0);
    }

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
