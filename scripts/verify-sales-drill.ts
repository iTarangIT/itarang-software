// Read-only check of the Sales dashboard drill-downs (src/lib/dashboard/salesDrill.ts):
// for every person and every clickable number, the list behind it must have
// exactly as many rows as the number the screen shows — computed by the real
// builders (buildSalesDashboard, salesHeadMeasures, runReport, stage-summary).
//
//   node --import tsx --env-file=.env.local scripts/verify-sales-drill.ts [from] [to]
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { buildSalesDashboard } from "@/lib/admin/salesDashboard";
import { salesHeadMeasures } from "@/lib/dashboard/salesHeadMeasures";
import { runReport } from "@/lib/admin/reports";
import { parseDashboardFilters } from "@/lib/admin/filters";
import { NO_PERSON, salesDrillRows, type DrillKind, type DrillFilters } from "@/lib/dashboard/salesDrill";

const from = process.argv[2] ?? "2026-10-01";
const to = process.argv[3] ?? new Date().toISOString().slice(0, 10);
let checks = 0;
const bad: string[] = [];

async function expect(label: string, kind: DrillKind, f: DrillFilters, want: number, persons: string[] | null, key: string | null = null) {
    const rows = await salesDrillRows(kind, f, { persons, key, limit: 20000 });
    checks++;
    if (rows.length !== want) bad.push(`${label} · ${kind}${key ? `(${key})` : ""}: count ${want} vs list ${rows.length}`);
}

async function main() {
    console.log(`DB ${new URL(process.env.DATABASE_URL!).hostname.split(".")[0]} | ${from} → ${to}`);
    const f: DrillFilters = { from, to };
    const dash = await buildSalesDashboard({ from, to, granularity: "month" });
    const m = await salesHeadMeasures({ from, to });

    for (const p of dash.per_spoc ?? []) {
        const who = [p.spoc_id];
        const label = String(p.name ?? p.spoc_id);
        await expect(label, "calls", f, p.totals.calls, who);
        await expect(label, "dealers_called", f, p.totals.dealers_called, who);
        await expect(label, "new_hot", f, p.totals.new_hot, who);
        await expect(label, "converted", f, p.totals.converted, who);
        await expect(label, "visits", f, p.totals.visits, who);
        await expect(label, "dealers_visited", f, p.totals.unique_visits, who);
        await expect(label, "new_dealers", f, p.totals.new_visits, who);
        await expect(label, "planned_today", f, p.snapshot.planned_visits_today, who);
        await expect(label, "kyc_submitted", f, p.outcome.kyc_submitted, who);
        const c = m.calling?.find((x) => x.user_id === p.spoc_id);
        await expect(label, "engaged", f, c?.engaged ?? 0, who);
        await expect(label, "whatsapp", f, c?.whatsapp ?? 0, who);
        const v = m.field?.find((x) => x.user_id === p.spoc_id);
        await expect(label, "verified", f, v?.verified ?? 0, who);
        await expect(label, "productive", f, v?.productive ?? 0, who);
    }

    // Quotes card — whole screen.
    await expect("team", "quotes_issued", f, dash.outcome.quotes_issued, null);
    await expect("team", "quote_revisions", f, dash.outcome.quote_revisions, null);
    if (m.quotes) {
        await expect("team", "waiting_approval", f, m.quotes.waiting_approval, null);
        await expect("team", "delivered_no_answer", f, m.quotes.delivered_no_answer, null);
        await expect("team", "dealer_yes", f, m.quotes.dealer_yes, null);
        await expect("team", "dealer_declined", f, m.quotes.dealer_declined, null);
    }

    // Reports: handoffs + lost reasons; measures: lost stage.
    const rf = parseDashboardFilters(new URL(`http://x/?date_from=${from}&date_to=${to}`));
    const handoff = await runReport("asm_handoff", rf);
    for (const r of handoff.rows) {
        const id = r.asm_id == null ? NO_PERSON : String(r.asm_id);
        await expect(String(r.asm_name ?? "Unassigned"), "handoffs", f, Number(r.handoffs ?? 0), [id]);
        await expect(String(r.asm_name ?? "Unassigned"), "handoff_converted", f, Number(r.converted ?? 0), [id]);
    }
    const lost = await runReport("lost_analysis", rf);
    for (const r of lost.rows.filter((x) => x.category === "Sales lost")) {
        await expect("team", "lost_reason", f, Number(r.count ?? 0), null, String(r.reason));
    }
    for (const s of m.lost_stage ?? []) await expect("team", "lost_stage", f, s.n, null, s.stage);

    // Ecofy.
    const eco = (await db.execute(sql`SELECT to_regclass('public.ecofy_leads') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (eco[0]?.ok) {
        const st = (await db.execute(sql`SELECT COALESCE(NULLIF(btrim(stage), ''), 'UNKNOWN') AS s, COUNT(*)::int n FROM ecofy_leads GROUP BY 1`)) as unknown as Array<{ s: string; n: number }>;
        const total = st.reduce((a, x) => a + x.n, 0);
        await expect("ecofy", "ecofy_all", f, total, null);
        await expect("ecofy", "ecofy_open", f, st.filter((x) => x.s !== "S0" && x.s !== "CLOSED").reduce((a, x) => a + x.n, 0), null);
        const [q] = (await db.execute(sql`SELECT COUNT(*)::int n FROM ecofy_leads WHERE stage = 'S1' AND assigned_to_user_id IS NULL`)) as unknown as Array<{ n: number }>;
        await expect("ecofy", "ecofy_queue", f, q.n, null);
        for (const x of st) await expect("ecofy", "ecofy_stage", f, x.n, null, x.s);
    }

    console.log(`checks ${checks} | mismatches ${bad.length}`);
    bad.slice(0, 40).forEach((b) => console.log("  FAIL", b));
    process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
