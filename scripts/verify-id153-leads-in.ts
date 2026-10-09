// Read-only check of ID 153: one "Leads in" everywhere.
//
//   node --import tsx --env-file=.env.local scripts/verify-id153-leads-in.ts [from] [to]
//
// from / to are IST days, inclusive (default: last calendar month). For that
// window, three screens must agree with each other and with a plain count:
//   CEO overview › Sales engine   buildControlTower().engine.leads_in / imported_bulk
//   Lead Funnel report            "All leads created" / "Imported in bulk" rows
//   Reports › Analyses › Lead sources   total.leads_in / bulk.leads_in
//   plain count                   active leads created in the window, split by
//                                 metricDefinitions.bulkImportedLead
// Leads in + Imported in bulk must also equal every active lead in the window.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildControlTower } from "@/lib/dashboard/ceoControlTower";
import { runReport } from "@/lib/admin/reports";
import { leadSources } from "@/lib/reports/analyses";
import { bulkImportedLead } from "@/lib/reports/metricDefinitions";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

const addDays = (d: string, n: number) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
};

async function main() {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;
    const [from = addDays(monthStart, -1).slice(0, 7) + "-01", to = addDays(monthStart, -1)] = process.argv.slice(2);
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  window ${from} → ${to} (IST)\n`);

    const [plain] = (await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE NOT ${bulkImportedLead(sql`dl`)})::int AS leads_in,
               COUNT(*) FILTER (WHERE ${bulkImportedLead(sql`dl`)})::int     AS bulk,
               COUNT(*)::int                                                AS all_leads
          FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE
           AND ((dl.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
    `)) as unknown as Array<{ leads_in: number; bulk: number; all_leads: number }>;
    console.log("plain count:", plain);

    const tower = await buildControlTower({ startStr: from, endStr: addDays(to, 1) });
    const engine = tower.engine;
    const funnel = await runReport("lead_funnel", { date_from: from, date_to: to });
    const created = funnel.rows.find((r) => r.stage === "All leads created");
    const bulkRow = funnel.rows.find((r) => r.stage === "Imported in bulk (not in the funnel)");
    const sources = await leadSources({ from, to }, { id: "verify-id153", role: "ceo" } as never);

    check("plain: Leads in + Imported in bulk = every active lead", plain.leads_in + plain.bulk === plain.all_leads);
    check("CEO Sales engine Leads in = plain", engine?.leads_in.now === plain.leads_in, engine?.leads_in);
    check("CEO Sales engine Imported in bulk = plain", engine?.imported_bulk.now === plain.bulk, engine?.imported_bulk);
    check("Lead Funnel 'All leads created' = plain Leads in", Number(created?.count) === plain.leads_in, created);
    check("Lead Funnel 'Imported in bulk' = plain", Number(bulkRow?.count) === plain.bulk, bulkRow);
    check("Lead sources 'All sources' = plain Leads in", sources.total.leads_in === plain.leads_in, sources.total.leads_in);
    check("Lead sources 'Imported in bulk' = plain", (sources.bulk?.leads_in ?? 0) === plain.bulk, sources.bulk?.leads_in ?? 0);
    for (const c of sources.checks) check(`Lead sources check: ${c.label}`, c.holds, c.detail || undefined);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
