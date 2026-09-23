/**
 * Verifier for the Reporting Review v1.0 fixes (R-01 … R-24, 2026-09-21).
 *
 *   node --import tsx --env-file=.env.local scripts/verify-reporting-review.ts
 *
 * Runs the REAL builders and queries against whatever DATABASE_URL points at
 * and checks that the numbers agree with each other — not just that the code
 * runs. Read-only: the two checks that must write (the idle clock and the
 * interest trigger) do so inside a transaction that is always rolled back.
 *
 * A check that needs a migration the host lacks reports SKIP, not FAIL, and
 * names the migration. Exit code 1 if anything FAILs.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { runReport } from "../src/lib/admin/reports";
import { fetchKpis, fetchAlertCounts } from "../src/lib/admin/dashboard";
import { buildSalesDashboard } from "../src/lib/admin/salesDashboard";
import { revenueSummary, revenueTotal } from "../src/lib/dashboard/revenueSource";
import { listNeodoveAgents } from "../src/lib/neodove/agentMap";
import { writeTouchpoint } from "../src/lib/touchpoints/write";
import { isNonResponsive } from "../src/lib/leads/nonResponsive";
import { listNeedsAttention, summarizeNeedsAttention } from "../src/lib/leads/needsAttention";
import { listDealerHealth, summarizeDealerHealth } from "../src/lib/dealers/accountHealth";
import { countEvents, fetchEvents, summarizeEvents } from "../src/lib/leads/eventLog";
import { dataHealth } from "../src/lib/dashboard/dataHealth";
import { listTargets } from "../src/lib/targets/service";
import { salesDailyDigest } from "../src/lib/digests/kinds/sales-daily";
import { buybackDailyDigest } from "../src/lib/digests/kinds/buyback-daily";
import { idleWeeklyDigest } from "../src/lib/digests/kinds/idle-weekly";
import { targetsPendingDigest } from "../src/lib/digests/kinds/targets-pending";
import { buildControlTower } from "../src/lib/dashboard/ceoControlTower";

type Outcome = "PASS" | "FAIL" | "SKIP";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];

class Skip extends Error {}
class Rollback extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

async function check(id: string, fn: () => Promise<string | void>) {
    const t = Date.now();
    try {
        const note = (await fn()) ?? "";
        results.push({ id, outcome: "PASS", note: `${note} (${Date.now() - t} ms)` });
    } catch (e) {
        const err = e as Error & { cause?: { message?: string } };
        if (e instanceof Skip) results.push({ id, outcome: "SKIP", note: err.message });
        else results.push({ id, outcome: "FAIL", note: err.cause?.message ?? err.message });
    }
}

async function hasColumn(table: string, column: string): Promise<boolean> {
    const r = (await db.execute(sql`
        SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}
    `)) as unknown[];
    return r.length > 0;
}
async function hasTable(table: string): Promise<boolean> {
    const r = (await db.execute(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    return Boolean(r[0]?.ok);
}

const TODAY = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const YESTERDAY = addDays(TODAY, -1);

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").host.split(".")[0];
    console.log(`Reporting Review verifier — host ${host}, IST today ${TODAY}\n`);

    const e300 = await hasColumn("dealer_leads", "last_worked_at");
    const e301 = await hasColumn("dealer_leads", "interest_changed_at");
    const e302 = await hasColumn("buyback_requests", "owner_id");
    const e303 = await hasTable("sales_targets");
    const needCore = () => {
        if (!e300 || !e301 || !e302) throw new Skip("needs E-300/E-301/E-302");
    };

    await check("R-01/R-02 Funnel by Owner — converted = lead_status, H/W/C = interest, AI band separate", async () => {
        const r = await runReport("funnel_by_owner", {} as never);
        const keys = r.columns.map((c) => c.key);
        for (const k of ["hot", "warm", "cold", "ai_qualified", "ai_warm", "ai_cold", "converted", "conversion_rate"]) {
            assert(keys.includes(k), `column ${k} missing`);
        }
        for (const row of r.rows) {
            const conv = Number(row.converted), touched = Number(row.touched);
            assert(conv <= touched, `${row.person}: converted ${conv} > touched ${touched}`);
        }
        return `${r.rows.length} people`;
    });

    await check("R-03 NeoDove agents — every agent's calls add up", async () => {
        const s = await listNeodoveAgents();
        const sum = s.agents.reduce((a, g) => a + g.calls, 0);
        assert(sum + s.calls_without_agent === s.total_calls, `agents ${sum} + no-agent ${s.calls_without_agent} ≠ total ${s.total_calls}`);
        const un = s.agents.reduce((a, g) => a + g.unattributed, 0);
        assert(un <= s.unattributed_calls, "per-agent unattributed exceeds total");
        return `${s.total_calls} calls, ${s.unattributed_calls} uncredited, ${s.agents.length} agents`;
    });

    await check("R-04 idle clock — assignment leaves it, a call moves it (rolled back)", async () => {
        if (!e300) throw new Skip("needs E-300");
        const out: Record<string, boolean> = {};
        try {
            await db.transaction(async (tx) => {
                const [lead] = (await tx.execute(sql`SELECT id, last_worked_at, last_touchpoint_at FROM dealer_leads WHERE is_active IS NOT FALSE LIMIT 1`)) as unknown as Array<{ id: string; last_worked_at: unknown; last_touchpoint_at: unknown }>;
                await writeTouchpoint({ dealerLeadId: lead.id, touchpointType: "lead_assigned", performedBy: null, remarks: "verify" }, { tx });
                const [a] = (await tx.execute(sql`SELECT last_worked_at, last_touchpoint_at FROM dealer_leads WHERE id = ${lead.id}`)) as unknown as Array<Record<string, unknown>>;
                await writeTouchpoint({ dealerLeadId: lead.id, touchpointType: "inside_sales_call", performedBy: null, callStatus: "not_reachable", remarks: "verify" }, { tx });
                const [b] = (await tx.execute(sql`SELECT last_worked_at FROM dealer_leads WHERE id = ${lead.id}`)) as unknown as Array<Record<string, unknown>>;
                out.assignLeaves = String(a.last_worked_at) === String(lead.last_worked_at);
                out.assignMovesTouch = String(a.last_touchpoint_at) !== String(lead.last_touchpoint_at);
                out.callMoves = b.last_worked_at != null && String(b.last_worked_at) !== String(lead.last_worked_at);
                throw new Rollback();
            });
        } catch (e) {
            if (!(e instanceof Rollback)) throw e;
        }
        assert(out.assignLeaves && out.assignMovesTouch && out.callMoves, JSON.stringify(out));
    });

    await check("R-05 interest trigger — edit/case-only keep stamp, real change stamps now (rolled back)", async () => {
        if (!e301) throw new Skip("needs E-301");
        const out: Record<string, boolean> = {};
        try {
            await db.transaction(async (tx) => {
                const [l] = (await tx.execute(sql`SELECT id, interest_level, interest_changed_at FROM dealer_leads WHERE interest_level IN ('hot','warm','cold') LIMIT 1`)) as unknown as Array<{ id: string; interest_level: string; interest_changed_at: Date }>;
                if (!l) throw new Skip("no rated lead");
                const at = async () => ((await tx.execute(sql`SELECT interest_changed_at, now() AS now FROM dealer_leads WHERE id = ${l.id}`)) as unknown as Array<{ interest_changed_at: Date; now: Date }>)[0];
                await tx.execute(sql`UPDATE dealer_leads SET city = city WHERE id = ${l.id}`);
                // The driver returns timestamps as text; compare as instants.
                const ms = (v: unknown) => new Date(String(v)).getTime();
                out.editKeeps = ms((await at()).interest_changed_at) === ms(l.interest_changed_at);
                await tx.execute(sql`UPDATE dealer_leads SET interest_level = upper(interest_level) WHERE id = ${l.id}`);
                out.caseKeeps = ms((await at()).interest_changed_at) === ms(l.interest_changed_at);
                await tx.execute(sql`UPDATE dealer_leads SET interest_level = ${l.interest_level === "hot" ? "warm" : "hot"} WHERE id = ${l.id}`);
                const x = await at();
                out.changeStamps = ms(x.interest_changed_at) === ms(x.now);
                throw new Rollback();
            });
        } catch (e) {
            if (!(e instanceof Rollback)) throw e;
        }
        assert(out.editKeeps && out.caseKeeps && out.changeStamps, JSON.stringify(out));
        const [u] = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM dealer_leads WHERE interest_level IS NOT NULL AND interest_changed_at IS NULL`)) as unknown as Array<{ n: number }>;
        assert(u.n === 0, `${u.n} rated leads have no interest_changed_at`);
    });

    await check("R-06/R-07 Lead Funnel — AI pool row, ever-reached ≥ currently-at", async () => {
        const r = await runReport("lead_funnel", { date_from: addDays(TODAY, -90), date_to: TODAY } as never);
        const rows = r.rows as Array<Record<string, unknown>>;
        assert(rows.some((x) => String(x.stage).includes("AI pool")), "AI pool row missing");
        const total = Number(rows.find((x) => x.stage === "All leads created")?.count);
        const sumCurrent = rows
            .filter((x) => x.stage !== "All leads created" && x.stage !== "Never Assigned")
            .reduce((a, x) => a + Number(x.count), 0);
        assert(sumCurrent === total, `stages sum ${sumCurrent} ≠ all leads ${total} — a bucket is missing`);
        for (const x of rows) {
            if (x.ever_reached != null) assert(Number(x.ever_reached) >= Number(x.count), `${x.stage}: ever ${x.ever_reached} < now ${x.count}`);
        }
        return `${total} leads in 90 d, every one in a bucket`;
    });

    await check("R-08 KPI conversion measures are rates in [0,1]", async () => {
        const k = await fetchKpis({} as never);
        for (const key of ["cohort_conversion_to_date", "conversion_30d_rate", "engaged_to_conversion_rate", "closed_win_rate_7d", "closed_win_rate_30d"] as const) {
            const v = k[key];
            assert(v == null || (v >= 0 && v <= 1), `${key} = ${v}`);
        }
        assert(!("conversion_rate_7d" in k), "old ambiguous conversion_rate_7d still returned");
    });

    await check("R-09/R-10/R-23 Sales Daily mail — movement columns, outcome, no repeated 'tomorrow'", async () => {
        needCore();
        const d = await salesDailyDigest.collect(YESTERDAY);
        assert(d.ok, d.error ?? "collect failed");
        const t = d.figures.tables ?? [];
        const y = t.find((x) => x.key === "yesterday")!;
        assert(y.columns.includes("New Hot") && y.columns.includes("Hot → Converted"), "movement columns missing");
        assert(!y.columns.includes("Hot") && !y.columns.includes("Warm"), "snapshot H/W/C still in period rows");
        assert(!y.columns.some((c) => /tomorrow/i.test(c)), "'tomorrow' column still in period rows");
        assert(y.columns.includes("Revenue ₹"), "outcome columns missing");
        assert(t.some((x) => x.key === "pipeline"), "pipeline table missing");
        for (const row of y.rows) assert(row.length === y.columns.length, "row width ≠ columns");
        return `${t.length} tables`;
    });

    await check("R-10 Sales dashboard — team outcome = sum of reps (quotes)", async () => {
        needCore();
        const d = await buildSalesDashboard({ from: addDays(TODAY, -60), to: TODAY, granularity: "month" });
        const sum = (d.per_spoc ?? []).reduce((a, b) => a + b.outcome.quotes_issued, 0);
        assert(sum <= d.outcome.quotes_issued, `reps ${sum} > team ${d.outcome.quotes_issued}`);
        for (const b of d.per_spoc ?? []) assert(b.totals.hot_converted <= b.totals.converted, `${b.name}: hot→converted > converted`);
        return `team quotes ${d.outcome.quotes_issued}, reps ${sum}; revenue ₹${d.outcome.revenue}`;
    });

    await check("R-11 invoice matching does not change company revenue", async () => {
        const s = await revenueSummary({ from: "2000-01-01", to: "2999-12-31" });
        const total = await revenueTotal("2000-01-01", "3000-01-01");
        assert(Math.abs(s.total - total) < 1, `matched union ₹${s.total} ≠ company revenue ₹${total} (duplicated rows?)`);
        assert(s.unlinked_count <= s.count, "unlinked > all");
        return `${s.count} invoices, ${s.unlinked_count} unlinked, ₹${Math.round(total)}`;
    });

    await check("R-12/R-13 Buyback Daily mail — owner-based, pipeline, missing-weight column", async () => {
        needCore();
        const d = await buybackDailyDigest.collect(YESTERDAY);
        assert(d.ok, d.error ?? "collect failed");
        const y = (d.figures.tables ?? []).find((x) => x.key === "yesterday")!;
        assert(y.columns.includes("Lines missing weight"), "missing-weight column absent");
        assert(!y.columns.includes("Hot"), "Hot column still present");
        assert(!y.columns.some((c) => /tomorrow/i.test(c)), "'tomorrow' column still present");
        assert((d.figures.tables ?? []).some((x) => x.key === "pipeline"), "pipeline table missing");
    });

    await check("R-15 needs attention — list sorted oldest first, weekly mail = summary", async () => {
        needCore();
        const rows = await listNeedsAttention({ limit: 500 });
        const idle = rows.filter((r) => !r.non_responsive);
        for (let i = 1; i < idle.length; i++) assert(idle[i - 1].days_idle >= idle[i].days_idle, "not oldest-first");
        const s7 = await summarizeNeedsAttention({ minDays: 7 });
        const d = await idleWeeklyDigest.collect("");
        const mail = d.figures.backlog.find((b) => b.label.includes("over 7"))?.value;
        const expect = s7.reduce((a, h) => a + h.idle, 0);
        assert(mail === expect, `mail ${mail} ≠ summary ${expect}`);
        return `${expect} idle > 7 working days`;
    });

    await check("R-16 non-responsive — SQL rule agrees with its TS twin on real leads", async () => {
        const leads = (await db.execute(sql`
            SELECT dealer_lead_id AS id FROM lead_touchpoints
             WHERE touchpoint_type IN ('inside_sales_call','ai_call') AND performed_at >= now() - INTERVAL '45 days'
             GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 40
        `)) as unknown as Array<{ id: string }>;
        const { nonResponsiveSql } = await import("../src/lib/leads/nonResponsive");
        let agree = 0;
        for (const l of leads) {
            const calls = (await db.execute(sql`
                SELECT performed_at, call_status FROM lead_touchpoints
                 WHERE dealer_lead_id = ${l.id} AND touchpoint_type IN ('inside_sales_call','ai_call')
            `)) as unknown as Array<{ performed_at: string; call_status: string | null }>;
            const [r] = (await db.execute(sql`SELECT ${nonResponsiveSql(sql`${l.id}`)} AS nr, now() AS now`)) as unknown as Array<{ nr: boolean; now: string }>;
            const ts = isNonResponsive(calls.map((c) => ({ performed_at: new Date(c.performed_at), call_status: c.call_status })), new Date(r.now));
            assert(ts === Boolean(r.nr), `lead ${l.id}: SQL ${r.nr} vs TS ${ts}`);
            agree++;
        }
        const c = await fetchAlertCounts({} as never);
        return `${agree} busiest leads agree; ${c.non_responsive} non-responsive now`;
    });

    await check("R-17 targets register reads", async () => {
        if (!e303) throw new Skip("needs E-303");
        const rows = await listTargets({ month: TODAY.slice(0, 7) });
        for (const r of rows) assert(r.final_target === r.ceo_target + r.admin_addon && r.admin_addon >= 0, `bad row ${r.id}`);
        const d = await targetsPendingDigest.collect("");
        assert(d.ok, d.error ?? "targets_pending collect failed");
        return `${rows.length} targets this month`;
    });

    await check("R-18 dealer health — buckets add up", async () => {
        const rows = await listDealerHealth();
        const g = await summarizeDealerHealth("owner");
        const dealers = g.reduce((a, x) => a + x.dealers, 0);
        assert(dealers === rows.length, `summary ${dealers} ≠ list ${rows.length}`);
        for (const x of g) assert(Object.values(x.by_bucket).reduce((a, n) => a + n, 0) === x.dealers, `${x.group} buckets ≠ dealers`);
        return `${rows.length} converted dealers`;
    });

    await check("R-21 event log — count = rows, summary calls = call events", async () => {
        const f = { from: addDays(TODAY, -7), to: TODAY };
        const n = await countEvents(f);
        const rows = await fetchEvents(f);
        assert(rows.length === n, `fetch ${rows.length} ≠ count ${n}`);
        const s = await summarizeEvents(f);
        const calls = rows.filter((r) => r.event_type.startsWith("Call")).length;
        assert(s.reduce((a, x) => a + x.calls, 0) === calls, "summary calls ≠ call events");
        return `${n} events last 7 days`;
    });

    await check("R-24 data health — every check ran, percentages 0–100", async () => {
        const c = await dataHealth();
        for (const x of c) {
            assert(x.pct != null, `${x.key} could not run`);
            assert(x.pct >= 0 && x.pct <= 100, `${x.key} = ${x.pct}`);
        }
        return c.map((x) => `${x.key.split("_")[0]}:${x.pct}%`).join(" ");
    });

    await check("Sheet 9 E-304 audit trigger — field edit + interest change recorded with actor (rolled back)", async () => {
        if (!(await hasTable("dealer_lead_field_changes"))) throw new Skip("needs E-304");
        const out: Record<string, boolean> = {};
        try {
            await db.transaction(async (tx) => {
                const [u] = (await tx.execute(sql`SELECT id::text AS id FROM users WHERE is_active LIMIT 1`)) as unknown as Array<{ id: string }>;
                const [l] = (await tx.execute(sql`SELECT id, interest_level FROM dealer_leads WHERE interest_level IN ('hot','warm','cold') LIMIT 1`)) as unknown as Array<{ id: string; interest_level: string }>;
                if (!l) throw new Skip("no rated lead");
                await tx.execute(sql`SELECT set_config('app.actor_id', ${u.id}, true)`);
                await tx.execute(sql`UPDATE dealer_leads SET city = 'VERIFY', updated_at = now() WHERE id = ${l.id}`);
                await tx.execute(sql`UPDATE dealer_leads SET interest_level = ${l.interest_level === "hot" ? "warm" : "hot"} WHERE id = ${l.id}`);
                const fc = (await tx.execute(sql`SELECT field, changed_by FROM dealer_lead_field_changes WHERE dealer_lead_id = ${l.id} AND changed_at >= now()`)) as unknown as Array<{ field: string; changed_by: string }>;
                const ih = (await tx.execute(sql`SELECT changed_by FROM dealer_lead_interest_history WHERE dealer_lead_id = ${l.id} AND changed_at >= now()`)) as unknown as Array<{ changed_by: string }>;
                out.onlyCity = fc.length === 1 && fc[0].field === "city";
                out.actor = fc[0]?.changed_by === u.id && ih[0]?.changed_by === u.id;
                out.oneInterest = ih.length === 1;
                throw new Rollback();
            });
        } catch (e) {
            if (!(e instanceof Rollback)) throw e;
        }
        assert(out.onlyCity && out.actor && out.oneInterest, JSON.stringify(out));
    });

    await check("Sheet 6 CEO control tower — every tile builds, money = company revenue", async () => {
        needCore();
        const from = `${TODAY.slice(0, 7)}-01`;
        const toExcl = addDays(TODAY, 1);
        const c = await buildControlTower({ startStr: from, endStr: toExcl });
        for (const k of ["exceptions", "money", "engine", "base", "people"] as const) assert(c[k] !== null, `${k} tile failed`);
        const rev = await revenueTotal(from, toExcl);
        assert(Math.abs(c.money!.revenue.now - rev) < 1, `money tile ₹${c.money!.revenue.now} ≠ company ₹${rev}`);
        const typed = c.money!.by_type.reduce((a, t) => a + t.revenue, 0) + c.money!.unlinked_revenue;
        assert(Math.abs(typed - rev) < 1, `type split ₹${typed} ≠ revenue ₹${rev}`);
        return `MTD revenue ₹${Math.round(rev)}, idle>7d ${c.exceptions!.idle_over_7d}, league ${c.people!.rows.length} SPOCs`;
    });

    const w = Math.max(...results.map((r) => r.id.length));
    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id.padEnd(w)}  ${r.note}`);
    const fails = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length - fails} ok / ${fails} failed (${results.filter((r) => r.outcome === "SKIP").length} skipped)`);
    process.exit(fails ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
