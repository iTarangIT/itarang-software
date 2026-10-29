// Read-only check of ID 184 — "Ready leads with no owner".
//
//   node --import tsx --env-file=.env.local      scripts/verify-id184-ready-no-owner.ts
//   node --import tsx --env-file=.env.production scripts/verify-id184-ready-no-owner.ts
//
// 1. Hot + AI qualified + other = the total (one bucket per lead, Hot wins).
// 2. Sales dashboard card = CEO card = Ready to Assign = daily email "Right now".
// 3. Leads list ?ready_no_owner=1 (and its export, which shares the WHERE) = the
//    card, in total and per split.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { countAwaitingAssignment, READY_SPLITS } from "@/lib/leads/salesReady";
import { parseLeadListFilters } from "@/lib/leads/leadListParams";
import { fetchLeadListStats } from "@/lib/leads/leadListQuery";
import { salesHeadActionSummary } from "@/lib/dashboard/salesHeadActions";
import { buildControlTower } from "@/lib/dashboard/ceoControlTower";
import { capabilitiesFor } from "@/lib/leads/access";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function listCount(q: string): Promise<number> {
    const caps = capabilitiesFor("admin");
    const f = await parseLeadListFilters(new URLSearchParams(q), caps, { id: "verify", role: "admin" });
    return Number((await fetchLeadListStats(f)).total);
}

async function main() {
    await db.execute(sql`SET default_transaction_read_only = on`);
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);

    const c = await countAwaitingAssignment();
    console.log(`      ready, no owner: ${c.total} — ${c.split.hot} Hot · ${c.split.ai} AI qualified · ${c.split.other} other`);
    check("split sums to the total, no part negative", c.split.hot + c.split.ai + c.split.other === c.total && c.split.other >= 0, c.split);

    const tile = (await salesHeadActionSummary({ viewerRole: "admin" })).sales_ready;
    check(`Sales dashboard card (${tile?.count}) = rule (${c.total})`, tile?.count === c.total);
    check("card line reads Hot · AI-qualified · Other (Hot first)", (tile?.sub ?? "").startsWith(`Hot ${c.split.hot} · AI-qualified ${c.split.ai} · Other ${c.split.other}`), tile?.sub);

    const tower = await buildControlTower({ startStr: new Date().toISOString().slice(0, 8) + "01", endStr: null });
    const x = tower.exceptions;
    check(`CEO card (${x?.awaiting_assignment_total}) = rule (${c.total})`, x?.awaiting_assignment_total === c.total);
    check("CEO split = rule split", JSON.stringify(x?.awaiting_assignment_split) === JSON.stringify(c.split), x?.awaiting_assignment_split);

    check(`Leads list ready_no_owner=1 (${await listCount("ready_no_owner=1")}) = card (${c.total})`, (await listCount("ready_no_owner=1")) === c.total);
    for (const k of READY_SPLITS) {
        const n = await listCount(`ready_no_owner=1&ready_split=${k}`);
        check(`Leads list split ${k} (${n}) = card (${c.split[k]})`, n === c.split[k]);
    }
    const hideOff = await listCount("ready_no_owner=1&hide_dead=0");
    check("hide-dead toggle does not change the ready count", hideOff === c.total, hideOff);

    const { salesDailyDigest } = await import("@/lib/digests/kinds/sales-daily");
    const day = new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
    const mail = await salesDailyDigest.collect(day as never);
    const item = JSON.stringify(mail).match(/"label":"Ready leads with no owner","value":"(\d+) lead/);
    check(`daily email Right now (${item?.[1]}) = card (${c.total})`, Number(item?.[1]) === c.total);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
