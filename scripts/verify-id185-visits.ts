// ID 185 — read-only: Visits = Fresh + Repeat on each person's basis, plus
// "of which new to iTarang", and every number opens to the dealers behind it.
//
//   node --import tsx --env-file=.env.local      scripts/verify-id185-visits.ts [from] [to]
//   node --import tsx --env-file=.env.production scripts/verify-id185-visits.ts
//
// For every field person in the range (default: this month so far):
// 1. fresh + repeat = visits, fresh ≥ 0, repeat ≥ 0;
// 2. the drill lists (fresh_visits, repeat_visits, visits, new_dealers) have
//    exactly the row counts the card shows;
// 3. a "new to iTarang" dealer is always a fresh visit for that person.

import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { salesDrillRows } from "@/lib/dashboard/salesDrill";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const from = process.argv[2] ?? `${today.slice(0, 7)}-01`;
    const to = process.argv[3] ?? today;
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  ·  ${from} → ${to}\n`);

    const dash = await buildSalesDashboard({ from, to, granularity: "month" });
    const f = { from, to };
    let people = 0;
    for (const p of dash.per_spoc ?? []) {
        if (!p.totals.visits) continue;
        people++;
        const fresh = p.totals.fresh_visits ?? -1;
        const repeat = p.totals.visits - fresh;
        check(`${p.name}: visits ${p.totals.visits} = fresh ${fresh} + repeat ${repeat}`, fresh >= 0 && repeat >= 0);
        const [dv, df, dr, dn] = await Promise.all([
            salesDrillRows("visits", f, { persons: [p.spoc_id], limit: 20000 }),
            salesDrillRows("fresh_visits", f, { persons: [p.spoc_id], limit: 20000 }),
            salesDrillRows("repeat_visits", f, { persons: [p.spoc_id], limit: 20000 }),
            salesDrillRows("new_dealers", f, { persons: [p.spoc_id], limit: 20000 }),
        ]);
        check(
            `${p.name}: drill lists match the card (visits ${dv.length}, fresh ${df.length}, repeat ${dr.length})`,
            dv.length === p.totals.visits && df.length === fresh && dr.length === repeat,
        );
        const freshLeads = new Set(df.map((r) => r.id));
        check(`${p.name}: every new-to-iTarang dealer (${dn.length}) is a fresh visit`, dn.every((r) => freshLeads.has(r.id)));
    }
    console.log(`      ${people} field person(s) with visits in the range`);
    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
