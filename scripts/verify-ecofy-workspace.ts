// E-307 — read-only check of the Ecofy workspace against the DATABASE_URL DB
// and the configured Ecofy sandbox.
//
//   node --import tsx --env-file=.env.local scripts/verify-ecofy-workspace.ts
//
// Imports the real query builders and service (no restated SQL). Writes
// nothing: no assignment, no action, no notification.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { CATEGORY_BY_TYPE } from "@/lib/notifications/catalog";
import { TYPE_LABELS } from "@/lib/notifications/registry";
import { listEcofyAssignees } from "@/lib/ecofy/assignment";
import { ecofyCounts, ecofyLoadByAssignee, ecofyStageCounts, listEcofyLeads } from "@/lib/ecofy/queries";
import { readDashboards, readLeadData, readLookup, readQueue } from "@/lib/ecofy/service";

let failed = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => {
    failed++;
    console.log(`  ✗ ${msg}`);
};

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname.split(".")[0];
    console.log(`DB: ${host}`);

    console.log("Schema");
    const cols = await db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ecofy_leads' AND column_name IN
          ('assigned_to_user_id','assigned_role','assigned_by','assigned_at','next_follow_up_at',
           'next_appointment_at','follow_up_reminded_at','appointment_reminded_at')
    `);
    cols.length === 8 ? ok("ecofy_leads has the 8 E-307 columns") : bad(`ecofy_leads E-307 columns: ${cols.length}/8`);
    const t = await db.execute<{ t: string | null }>(sql`SELECT to_regclass('public.ecofy_lead_assignments')::text AS t`);
    t[0]?.t ? ok("ecofy_lead_assignments exists") : bad("ecofy_lead_assignments missing");

    console.log("Data integrity");
    const orphan = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ecofy_leads l
        LEFT JOIN users u ON u.id = l.assigned_to_user_id
        WHERE l.assigned_to_user_id IS NOT NULL
          AND (u.id IS NULL OR u.is_active IS NOT TRUE OR LOWER(u.role) NOT IN ('asm','inside_sales_rep'))
    `);
    orphan[0].n === 0 ? ok("no lead owned by a missing / inactive / non-ASM-ISR user") : bad(`${orphan[0].n} lead(s) with an invalid owner`);

    console.log("Queries");
    const [open, queue, all, stages, load] = await Promise.all([
        listEcofyLeads({ view: "open" }),
        listEcofyLeads({ view: "queue" }),
        listEcofyLeads({ view: "all" }),
        ecofyStageCounts(),
        ecofyLoadByAssignee(),
    ]);
    ok(`leads: ${all.length} total, ${open.length} open, ${queue.length} in pickup queue`);
    ok(`stages: ${stages.map((s) => `${s.stage}=${s.n}`).join(", ") || "none"}`);
    ok(`owners with open leads: ${load.length}`);
    const counts = await ecofyCounts({ id: "00000000-0000-0000-0000-000000000000", role: "sales_head" });
    counts.queue === queue.length ? ok(`counts.queue matches the queue list (${counts.queue})`) : bad(`counts.queue ${counts.queue} ≠ queue list ${queue.length}`);
    const assignees = await listEcofyAssignees();
    ok(`assignable ASM/ISR: ${assignees.length} (${assignees.filter((a) => a.role === "asm").length} ASM, ${assignees.filter((a) => a.role === "inside_sales_rep").length} ISR)`);

    console.log("Notifications");
    const types = Object.keys(CATEGORY_BY_TYPE).filter((k) => k.startsWith("ecofy."));
    const unlabelled = types.filter((k) => !TYPE_LABELS[k]);
    const tooLong = types.filter((k) => k.length > 50);
    unlabelled.length === 0 && tooLong.length === 0
        ? ok(`${types.length} ecofy.* types, all labelled, all ≤ 50 chars`)
        : bad(`unlabelled: ${unlabelled.join(", ")} too long: ${tooLong.join(", ")}`);

    console.log("Ecofy API (read-only, as the integration user)");
    if (!process.env.ECOFY_SYNC_SECRET || !process.env.ECOFY_API_BASE) {
        console.log("  – skipped: ECOFY_SYNC_SECRET / ECOFY_API_BASE not set");
    } else {
        const tries: Array<[string, () => Promise<unknown>]> = [
            ["dashboards", () => readDashboards()],
            ["closure_reason list", () => readLookup("closure_reason")],
            ["financiers", () => readLookup("financiers")],
            ["eligibility queue", () => readQueue("eligibility")],
            ["financing queue", () => readQueue("financing")],
            ["assets", () => readQueue("assets")],
        ];
        if (all[0]) tries.push([`case ${all[0].case_no}`, () => readLeadData(all[0].ecofy_case_id, "case")]);
        for (const [label, fn] of tries) {
            try {
                const r = await fn();
                ok(`${label}${Array.isArray(r) ? ` (${r.length})` : ""}`);
            } catch (err) {
                bad(`${label}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
