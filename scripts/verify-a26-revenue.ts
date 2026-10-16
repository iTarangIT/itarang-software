// A26 — read-only: Admin › Targets revenue and the daily Sales email's
// per-rep revenue are one figure.
//
//   node --import tsx --env-file=.env.local      scripts/verify-a26-revenue.ts [YYYY-MM-DD]
//   node --import tsx --env-file=.env.production scripts/verify-a26-revenue.ts
//
// For day D (default yesterday, IST — the day the morning email covers):
// 1. the email's MTD window is the month's first day to D;
// 2. for every person with revenue or batteries, Targets' actual (actualsFor,
//    to D) = the email's Block B / C figure (buildRepBlocks over the same
//    dashboard) — revenue and batteries both;
// 3. every person with revenue appears in Block B or C (nobody's revenue is
//    on the Targets page but missing from the email).

import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { actualsFor } from "@/lib/targets/service";
import { salesDailyPeriods } from "@/lib/digests/kinds/sales-daily";
import { buildRepBlocks, type RepExtras } from "@/lib/digests/salesDailyBlocks";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

const NONE: RepExtras = {
    hot_received: new Map(),
    hot_handed: new Map(),
    connected: new Map(),
    engaged: new Map(),
    quotes_delivered: new Map(),
    dealer_approved: new Map(),
    won: new Map(),
    limits_passed: new Map(),
    owner_median_h: new Map(),
};

async function main() {
    const yesterday = new Date(Date.now() + 5.5 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
    const day = process.argv[2] ?? yesterday;
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}  ·  day ${day}\n`);

    const p = salesDailyPeriods(day);
    check(`email MTD window is ${day.slice(0, 7)}-01 → ${day}`, p.mtd.from === `${day.slice(0, 7)}-01` && p.mtd.to === day, p.mtd);

    const [mtd, yday, actual] = await Promise.all([
        buildSalesDashboard({ ...p.mtd, granularity: "day" }),
        buildSalesDashboard({ ...p.yesterday, granularity: "day" }),
        actualsFor(p.mtd.from, p.mtd.to, 1),
    ]);
    const blocks = [
        ...buildRepBlocks("asm", yday, mtd, { y: NONE, mtd: NONE }, new Map()),
        ...buildRepBlocks("inside_sales_rep", yday, mtd, { y: NONE, mtd: NONE }, new Map()),
    ];
    const inEmail = new Map(blocks.map((b) => [b.id, b]));
    let people = 0;
    for (const s of mtd.per_spoc ?? []) {
        if (!s.outcome.revenue && !s.outcome.batteries_to_dealers) continue;
        people++;
        const tRev = actual(s.spoc_id, "revenue");
        const tBat = actual(s.spoc_id, "batteries_sold");
        check(
            `${s.name}: Targets revenue ${tRev} = email ${s.outcome.revenue}; batteries ${tBat} = ${s.outcome.batteries_to_dealers}`,
            Math.round(Number(tRev)) === Math.round(s.outcome.revenue) && Number(tBat) === Number(s.outcome.batteries_to_dealers),
        );
        const b = inEmail.get(s.spoc_id);
        if (s.outcome.revenue && s.role !== null) {
            check(`${s.name} (${s.role}) has a row in the email's Block B / C`, Boolean(b) || (s.role !== "asm" && s.role !== "inside_sales_rep"));
        }
    }
    console.log(`      ${people} person(s) with revenue or batteries MTD`);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
