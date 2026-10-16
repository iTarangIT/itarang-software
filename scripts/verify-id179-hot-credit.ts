// Read-only check of ID 179: "Hot to field" is credited to the lead's owner at
// the moment of transfer (from_owner_id), not the manager who pressed.
//
//   node --import tsx --env-file=.env.local scripts/verify-id179-hot-credit.ts [from] [to]
//
// from / to are IST days, inclusive (default: this month to today). Changes
// nothing. For the window it checks that the three readers agree per person:
//   Sales dashboard scorecard   buildIsrScorecard().hot_to_field
//   Daily Sales email Block C   loadRepExtras().hot_handed
//   one plain count             DISTINCT Hot-at-transfer leads per
//                               COALESCE(from_owner_id, performed_by)
// and lists the transfers whose credit moved from the presser to the owner
// (a manager's transfer of a rep's lead) — those are the ID 179 change.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { buildIsrScorecard } from "@/lib/admin/isrScorecard";
import { loadRepExtras } from "@/lib/digests/salesDailyBlocks";
import { transferCredit, wasHotAt } from "@/lib/reports/metricDefinitions";
import { istRangeTz } from "@/lib/digests/window";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const from = process.argv[2] ?? `${today.slice(0, 7)}-01`;
    const to = process.argv[3] ?? today;
    console.log(`ID 179 — Hot to field credit, ${from} to ${to}`);

    const plain = (await db.execute(sql`
        SELECT ${transferCredit()} AS u, COUNT(DISTINCT t.dealer_lead_id)::int AS n
          FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
         WHERE t.touchpoint_type = 'asm_transfer' AND ${istRangeTz(sql`t.performed_at`, from, to)}
           AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
           AND ${transferCredit()} IS NOT NULL
         GROUP BY 1
    `)) as unknown as Array<{ u: string; n: number }>;
    const expected = new Map(plain.map((r) => [r.u, Number(r.n)]));

    const score = await buildIsrScorecard({ from, to });
    const extras = await loadRepExtras(db, { from, to });

    const diffScore = [...expected].filter(([u, n]) => (score[u]?.hot_to_field ?? 0) !== n);
    check(`scorecard hot_to_field = owner-at-transfer count (${expected.size} people)`, diffScore.length === 0, diffScore.slice(0, 5));
    const handed = extras.hot_handed;
    if (handed) {
        const diffMail = [...expected].filter(([u, n]) => (handed.get(u) ?? 0) !== n);
        check("daily email Block C hot_handed = the same count", diffMail.length === 0, diffMail.slice(0, 5));
    } else {
        console.log("SKIP  Block C hot_handed not measurable on this database");
    }

    const moved = (await db.execute(sql`
        SELECT t.dealer_lead_id, t.performed_at::text AS at,
               COALESCE(p.name, t.performed_by) AS pressed_by, COALESCE(o.name, t.from_owner_id) AS credited_to
          FROM lead_touchpoints t
          JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
          LEFT JOIN users p ON p.id::text = t.performed_by
          LEFT JOIN users o ON o.id::text = t.from_owner_id
         WHERE t.touchpoint_type = 'asm_transfer' AND ${istRangeTz(sql`t.performed_at`, from, to)}
           AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
           AND t.from_owner_id IS NOT NULL AND t.from_owner_id IS DISTINCT FROM t.performed_by
         ORDER BY t.performed_at DESC
         LIMIT 20
    `)) as unknown as Array<Record<string, unknown>>;
    console.log(`INFO  Hot transfers now credited to the owner instead of the presser: ${moved.length}${moved.length === 20 ? "+" : ""}`);
    for (const m of moved) console.log(`      ${m.at}  lead ${m.dealer_lead_id}: pressed by ${m.pressed_by} → credited to ${m.credited_to}`);

    console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
