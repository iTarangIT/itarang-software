// Read-only check of ID 153: "Leads in" is every new lead, the same everywhere.
//
//   node --import tsx --env-file=.env.local scripts/verify-id153-leads-in.ts [from] [to]
//
// from / to are IST days, inclusive (default: last calendar month). For that
// window these must all equal one plain count of active leads created in it,
// whatever brought them in (rep, inbound, bulk upload, scraper, AI-dialer list,
// NeoDove — Kartik 10 Oct):
//   CEO overview › Sales funnel        buildControlTower().engine.leads_in
//   Lead Funnel report                 "All leads created"
//   Reports › Analyses › Lead sources  "All sources" (and its own download check)
//   Sales Daily email                  Block A "Leads in"
//   Leads download                     countLeadsForExport for the same dates

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildControlTower } from "@/lib/dashboard/ceoControlTower";
import { runReport } from "@/lib/admin/reports";
import { leadSources } from "@/lib/reports/analyses";
import { buildBlockA } from "@/lib/digests/salesDailyBlockA";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { countLeadsForExport } from "@/lib/admin/leadsExport";
import { parseLeadListFilters } from "@/lib/leads/leadListParams";
import { capabilitiesFor } from "@/lib/leads/access";

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
        SELECT COUNT(*)::int AS leads_in
          FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE
           AND ((dl.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
    `)) as unknown as Array<{ leads_in: number }>;
    console.log("plain count:", plain.leads_in);

    const viewer = { id: "verify-id153", role: "ceo" } as never;
    const tower = await buildControlTower({ startStr: from, endStr: addDays(to, 1) });
    const funnel = await runReport("lead_funnel", { date_from: from, date_to: to });
    const created = funnel.rows.find((r) => r.stage === "All leads created");
    const sources = await leadSources({ from, to }, viewer);

    const win = { from, to };
    const dash = await buildSalesDashboard({ ...win, city: null, state: null, spoc_id: null, business_type: null, granularity: "day" });
    const blockA = await buildBlockA(db, { yesterday: win, last7: win, mtd: win, lastMonth: win }, { yesterday: dash, last7: dash, mtd: dash, lastMonth: dash });
    const email = blockA.rows.find((r) => r.label === "Leads in")?.values.y;

    const p = new URLSearchParams({ from, to, contactability: "include" });
    const download = await countLeadsForExport(await parseLeadListFilters(p, capabilitiesFor("ceo"), viewer));

    check("CEO Sales funnel Leads in = plain", tower.engine?.leads_in.now === plain.leads_in, tower.engine?.leads_in);
    check("Lead Funnel 'All leads created' = plain", Number(created?.count) === plain.leads_in, created?.count);
    check("Lead sources 'All sources' = plain", sources.total.leads_in === plain.leads_in, sources.total.leads_in);
    check("Sales Daily 'Leads in' = plain", email === plain.leads_in, email);
    check("Leads download = plain", download === plain.leads_in, download);
    check("no 'Imported in bulk' row left in the Lead Funnel", !funnel.rows.some((r) => /bulk/i.test(String(r.stage))));
    for (const c of sources.checks) check(`Lead sources check: ${c.label}`, c.holds, c.detail || undefined);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
