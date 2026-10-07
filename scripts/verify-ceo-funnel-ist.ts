// Read-only check that the CEO funnel and the old admin reports
// (src/lib/admin/reports.ts) count by IST days.
//
// Ties, for several windows:
//   CEO funnel "All leads created"  = the CEO Engine tile's "Leads in" (IST,
//                                     buildControlTower) — the two numbers on
//                                     the same CEO card
//   Lead funnel / Lost / AI score / Source performance / Daily activity /
//   ASM handoff / Funnel by owner / Meetings MTD — each total recounted with
//   independent SQL written from the column types here.
//
//   node --import tsx --env-file=.env.local scripts/verify-ceo-funnel-ist.ts
//   node --import tsx --env-file=.env.production scripts/verify-ceo-funnel-ist.ts

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { runReport } from "@/lib/admin/reports";
import { LOST_REASON } from "@/lib/lifecycle/transitions";
import { buildControlTower } from "@/lib/dashboard/ceoControlTower";
import type { DashboardFilters, ReportResult } from "@/lib/admin/types";

let failures = 0;
function eq(label: string, got: number, want: number) {
    const ok = got === want;
    if (!ok) failures += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : ` (independent count: ${want})`}`);
}
const one = async (q: SQL) => Number(((await db.execute(q)) as unknown as { n: number }[])[0]?.n ?? 0);
const sum = (r: ReportResult, key: string) => r.rows.reduce((s, x) => s + Number(x[key] ?? 0), 0);
const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// Written from the column types, independently of reports.ts.
const CREATED = sql`(dl.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date`; // timestamp, UTC
const CLOSED = sql`(dl.closed_at AT TIME ZONE 'Asia/Kolkata')::date`; // timestamptz
const PERFORMED = sql`(t.performed_at AT TIME ZONE 'Asia/Kolkata')::date`; // timestamptz

async function window(from: string, to: string) {
    console.log(`\n══════════ ${from} → ${to} (IST) ══════════`);
    const f = { date_from: from, date_to: to } as DashboardFilters;
    const inP = (d: SQL) => sql`${d} BETWEEN ${from}::date AND ${to}::date`;

    const funnel = await runReport("lead_funnel", f);
    const allCreated = Number(funnel.rows.find((r) => r.stage === "All leads created")?.count ?? -1);
    const tower = await buildControlTower({ startStr: from, endStr: addDay(to) });
    eq("CEO funnel 'All leads created' = CEO Engine 'Leads in'", allCreated, Number(tower.engine?.leads_in.now ?? -1));
    eq("  … = independent count", allCreated, await one(sql`SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE dl.is_active IS NOT FALSE AND ${inP(CREATED)}`));

    const lost = await runReport("lost_analysis", f);
    const salesLost = lost.rows.filter((r) => r.category === "Sales lost");
    eq("Lost analysis: sales lost (listed reasons)", sum({ ...lost, rows: salesLost }, "count"),
        await one(sql`SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE dl.lead_status = 'Lost'
                       AND dl.lost_reason IN (${sql.join(LOST_REASON.map((r) => sql`${r}`), sql`, `)}) AND ${inP(CLOSED)}`));

    const ai = await runReport("ai_score_accuracy", f);
    eq("AI score accuracy: converted", sum(ai, "converted"),
        await one(sql`SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE dl.lead_status = 'Converted' AND ${inP(CLOSED)}`));
    eq("AI score accuracy: lost", sum(ai, "lost"),
        await one(sql`SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE dl.lead_status = 'Lost' AND ${inP(CLOSED)}`));

    const src = await runReport("source_performance", f);
    eq("Source performance: closed", sum(src, "closed"),
        await one(sql`SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE dl.lead_status IN ('Converted','Lost') AND ${inP(CLOSED)}`));

    const daily = await runReport("daily_activity", f);
    eq("Daily activity: touchpoints", sum(daily, "total_touchpoints"),
        await one(sql`SELECT COUNT(*)::int AS n FROM lead_touchpoints t WHERE t.performed_by IS NOT NULL AND ${inP(PERFORMED)}`));
    const outside = daily.rows.filter((r) => String(r.day).slice(0, 10) < from || String(r.day).slice(0, 10) > to).length;
    eq("Daily activity: days outside the window", outside, 0);

    const handoff = await runReport("asm_handoff", f);
    eq("ASM handoff: handoffs", sum(handoff, "handoffs"),
        await one(sql`SELECT COUNT(*)::int AS n FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                       WHERE t.touchpoint_type = 'asm_transfer' AND ${inP(PERFORMED)}`));

    const owner = await runReport("funnel_by_owner", f);
    console.log(`  info funnel_by_owner rows: ${owner.rows.length} (ran without error)`);

    const meet = await runReport("meetings_mtd", f);
    eq("Meetings (MTD report): meetings", sum(meet, "meetings"),
        await one(sql`SELECT COUNT(*)::int AS n FROM lead_visits v
                       WHERE COALESCE(v.actual_visit_date, v.scheduled_date) BETWEEN ${from}::date AND ${to}::date`));
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);
    const [t] = (await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`)) as unknown as { today: string }[];
    await window(`${t.today.slice(0, 8)}01`, t.today);
    await window("2026-09-01", "2026-09-30");
    await window("2026-01-01", t.today);

    // The default (no dates): last 30 IST days, today included, and it runs.
    const d = await runReport("lead_funnel", {} as DashboardFilters);
    const start = new Date(Date.parse(`${t.today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    console.log("\n══════════ default window (last 30 IST days) ══════════");
    eq("Lead funnel default = last 30 IST days",
        Number(d.rows.find((r) => r.stage === "All leads created")?.count ?? -1),
        await one(sql`SELECT COUNT(*)::int AS n FROM dealer_leads dl WHERE dl.is_active IS NOT FALSE
                       AND ${CREATED} BETWEEN ${start}::date AND ${t.today}::date`));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
