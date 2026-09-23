/**
 * The CEO one-screen view (Reporting Review v1.0, sheet 6). Tiles in a FIXED
 * order — exceptions first — each compared with the previous period of the
 * same length:
 *
 *   1 Exceptions  needs your attention (quotes to approve, unassigned > 7d,
 *                 idle > 7d, Red / Dormant dealers with ₹ at risk, SPOCs below
 *                 80 % of target; "orders claimed, no invoice" is not tracked —
 *                 there is no order-placed record to compare invoices with)
 *   2 Money       revenue split by business type; revenue by SPOC and city
 *   3 Engine      leads in → converted → first order, the headline conversion
 *                 measure; AI calling
 *   4 Base        dealer account health; buyback kg / ₹ paid / ₹ per kg / margin
 *   5 People      SPOC league, top and bottom five
 *   6 Trust       data health (its own panel, src/lib/dashboard/dataHealth.ts)
 *
 * Every tile reuses the module that owns its definition — revenueSource for
 * money, the GSTIN matcher for attribution, needsAttention for idle, dealer
 * health for buckets, the Sales dashboard builder for per-SPOC outcome, the
 * targets service for % of target — so this screen can never disagree with the
 * report it drills into.
 *
 * Each tile is built on its own and becomes `null` if it fails (e.g. a table
 * absent on one environment); one broken tile must not blank the screen.
 *
 * Window: the CEO page's [startStr, endStr) — start inclusive, end exclusive;
 * a null start (inception) has no previous period.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { summarizeNeedsAttention } from "@/lib/leads/needsAttention";
import { listDealerHealth } from "@/lib/dealers/accountHealth";
import type { AccountBucket } from "@/lib/dealers/accountHealthRules";
import { businessTypeLabel } from "@/lib/leads/businessType";

export type Compare = { now: number; prev: number | null };

export type ControlTower = {
    window: { from: string; to: string; prev_from: string | null; prev_to: string | null };
    exceptions: null | {
        quotes_pending: number;
        unassigned_over_7d: number;
        idle_over_7d: number;
        red_dormant_dealers: number;
        at_risk_90d: number;
        spocs_below_80: number | null;
        orders_claimed_no_invoice: null;
    };
    money: null | {
        revenue: Compare;
        by_type: Array<{ type: string; revenue: number }>;
        by_spoc: Array<{ name: string; revenue: number }>;
        by_city: Array<{ city: string; revenue: number }>;
        unlinked_revenue: number;
    };
    engine: null | {
        leads_in: Compare;
        converted: Compare;
        first_orders: Compare;
        headline: { measure: "cohort_conversion_to_date" | "conversion_30d_rate"; label: string; value: number | null };
        ai: { leads_called: number; connect_pct: number | null; ai_qualified: number; ai_qualified_converted: number };
    };
    base: null | {
        dealers: Record<AccountBucket, number>;
        buyback: { kg: Compare; paid: number; per_kg: number | null; margin: number | null };
    };
    people: null | {
        basis: "target" | "converted";
        rows: Array<{
            spoc_id: string;
            name: string;
            pct_of_target: number | null;
            converted: number;
            revenue: number;
            idle_leads: number;
            engaged_pct: number | null;
        }>;
    };
};

const addDays = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
    Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);

async function safe<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch (e) {
        console.warn(`[ceoControlTower] ${name} failed`, e instanceof Error ? e.message : e);
        return null;
    }
}

/** Targets live in E-303; on a host without it, the target figures are simply absent. */
async function hasTargetsTable(): Promise<boolean> {
    const r = (await db.execute(sql`SELECT to_regclass('public.sales_targets') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    return Boolean(r[0]?.ok);
}

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];
const n = (v: unknown) => Number(v ?? 0);

/** [from, toExcl) as IST dates on a timestamptz column. */
const inWin = (col: ReturnType<typeof sql>, from: string, toExcl: string) =>
    sql`(${col} AT TIME ZONE 'Asia/Kolkata')::date >= ${from}::date AND (${col} AT TIME ZONE 'Asia/Kolkata')::date < ${toExcl}::date`;

export async function buildControlTower(w: { startStr: string | null; endStr: string | null }): Promise<ControlTower> {
    const [{ today }] = (await rows(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`)) as Array<{ today: string }>;
    const from = w.startStr ?? "2020-01-01";
    const toExcl = w.endStr ?? addDays(today, 1);
    const len = daysBetween(from, toExcl);
    const prevFrom = w.startStr ? addDays(from, -len) : null;
    const prevTo = w.startStr ? from : null;

    const [exceptions, money, engine, base, people] = await Promise.all([
        safe("exceptions", () => exceptionsTile()),
        safe("money", () => moneyTile(from, toExcl, prevFrom, prevTo)),
        safe("engine", () => engineTile(from, toExcl, prevFrom, prevTo)),
        safe("base", () => baseTile(from, toExcl, prevFrom, prevTo)),
        safe("people", () => peopleTile(from, addDays(toExcl, -1))),
    ]);
    return {
        window: { from, to: addDays(toExcl, -1), prev_from: prevFrom, prev_to: prevTo ? addDays(prevTo, -1) : null },
        exceptions,
        money,
        engine,
        base,
        people,
    };
}

// ── 1 Exceptions ─────────────────────────────────────────────────────────────
async function exceptionsTile(): Promise<NonNullable<ControlTower["exceptions"]>> {
    const [q] = await rows(sql`
        SELECT
          (SELECT COUNT(*) FROM dealer_lead_commercials WHERE approval_status = 'pending') AS quotes_pending,
          (SELECT COUNT(*) FROM dealer_leads
            WHERE current_owner_id IS NULL AND is_active IS NOT FALSE
              AND lead_status IS NOT NULL
              AND lead_status NOT IN ('Converted', 'Lost')
              AND created_at < now() - INTERVAL '7 days') AS unassigned
    `);
    const [idle, dealers, below] = await Promise.all([
        summarizeNeedsAttention({ minDays: 7 }),
        listDealerHealth(),
        safe("targets", async () => {
            if (!(await hasTargetsTable())) return null;
            const { listTargets } = await import("@/lib/targets/service");
            const t = await listTargets({ month: new Date().toISOString().slice(0, 7) });
            const byUser = new Map<string, number[]>();
            for (const r of t) {
                if (r.status !== "accepted" && r.status !== "pushed") continue;
                if (r.progress.pct_of_mtd == null) continue;
                byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.progress.pct_of_mtd]);
            }
            return [...byUser.values()].filter((p) => p.reduce((a, b) => a + b, 0) / p.length < 80).length;
        }),
    ]);
    const risky = dealers.filter((d) => d.bucket === "red" || d.bucket === "dormant");
    return {
        quotes_pending: n(q.quotes_pending),
        unassigned_over_7d: n(q.unassigned),
        idle_over_7d: idle.reduce((a, h) => a + h.idle, 0),
        red_dormant_dealers: risky.length,
        at_risk_90d: risky.reduce((a, d) => a + d.revenue_90d, 0),
        spocs_below_80: below,
        orders_claimed_no_invoice: null,
    };
}

// ── 2 Money ──────────────────────────────────────────────────────────────────
async function moneyTile(from: string, toExcl: string, prevFrom: string | null, prevTo: string | null) {
    const inv = await matchedUnion();
    const win = (a: string, b: string) => sql`r.invoice_date >= ${a}::date AND r.invoice_date < ${b}::date`;
    const [typeRows, spocRows, cityRows, prev] = await Promise.all([
        rows(sql`
            SELECT CASE WHEN r.dealer_lead_id IS NULL THEN '__unlinked'
                        ELSE COALESCE(to_jsonb(dl) ->> 'business_type', '__unset') END AS t,
                   COALESCE(SUM(r.total), 0) AS v
              FROM ${inv} r LEFT JOIN dealer_leads dl ON dl.id = r.dealer_lead_id
             WHERE ${REVENUE_NOT_VOID} AND ${win(from, toExcl)}
             GROUP BY 1`),
        rows(sql`
            SELECT COALESCE(u.name, '(no owner)') AS name, COALESCE(SUM(r.total), 0) AS v
              FROM ${inv} r JOIN dealer_leads dl ON dl.id = r.dealer_lead_id
              LEFT JOIN users u ON u.id::text = dl.current_owner_id
             WHERE ${REVENUE_NOT_VOID} AND ${win(from, toExcl)}
             GROUP BY 1 ORDER BY v DESC LIMIT 10`),
        rows(sql`
            SELECT COALESCE(NULLIF(btrim(dl.city), ''), 'Unknown city') AS city, COALESCE(SUM(r.total), 0) AS v
              FROM ${inv} r JOIN dealer_leads dl ON dl.id = r.dealer_lead_id
             WHERE ${REVENUE_NOT_VOID} AND ${win(from, toExcl)}
             GROUP BY 1 ORDER BY v DESC LIMIT 10`),
        prevFrom && prevTo
            ? rows(sql`SELECT COALESCE(SUM(r.total), 0) AS v FROM ${inv} r WHERE ${REVENUE_NOT_VOID} AND ${win(prevFrom, prevTo)}`)
            : Promise.resolve(null),
    ]);
    const total = typeRows.reduce((a, r) => a + n(r.v), 0);
    const unlinked = n(typeRows.find((r) => r.t === "__unlinked")?.v);
    return {
        revenue: { now: total, prev: prev ? n(prev[0]?.v) : null },
        by_type: typeRows
            .filter((r) => r.t !== "__unlinked")
            .map((r) => ({ type: r.t === "__unset" ? "Not set" : businessTypeLabel(String(r.t)), revenue: n(r.v) }))
            .sort((a, b) => b.revenue - a.revenue),
        by_spoc: spocRows.map((r) => ({ name: String(r.name), revenue: n(r.v) })),
        by_city: cityRows.map((r) => ({ city: String(r.city), revenue: n(r.v) })),
        unlinked_revenue: unlinked,
    };
}

// ── 3 Engine ─────────────────────────────────────────────────────────────────
async function engineTile(from: string, toExcl: string, prevFrom: string | null, prevTo: string | null) {
    const inv = await matchedUnion();
    const counts = async (a: string, b: string) => {
        const [r] = await rows(sql`
            SELECT
              (SELECT COUNT(*) FROM dealer_leads dl WHERE dl.is_active IS NOT FALSE AND ${inWin(sql`dl.created_at`, a, b)}) AS leads_in,
              (SELECT COUNT(*) FROM dealer_leads dl WHERE dl.lead_status = 'Converted' AND ${inWin(sql`dl.closed_at`, a, b)}) AS converted,
              (SELECT COUNT(*) FROM (
                  SELECT r.dealer_lead_id, MIN(r.invoice_date) AS first_d
                    FROM ${inv} r WHERE r.dealer_lead_id IS NOT NULL AND ${REVENUE_NOT_VOID}
                   GROUP BY 1) f
                WHERE f.first_d >= ${a}::date AND f.first_d < ${b}::date) AS first_orders`);
        return r;
    };
    const [now, prev, hist, ai] = await Promise.all([
        counts(from, toExcl),
        prevFrom && prevTo ? counts(prevFrom, prevTo) : Promise.resolve(null),
        rows(sql`
            SELECT MIN(created_at) < now() - INTERVAL '120 days' AS has_history,
                   COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '60 days' AND created_at < now() - INTERVAL '30 days') AS c30,
                   COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '60 days' AND created_at < now() - INTERVAL '30 days'
                                      AND lead_status = 'Converted' AND closed_at <= created_at + INTERVAL '30 days') AS c30_conv,
                   COUNT(*) FILTER (WHERE ${inWin(sql`created_at`, from, toExcl)}) AS coh,
                   COUNT(*) FILTER (WHERE ${inWin(sql`created_at`, from, toExcl)} AND lead_status = 'Converted') AS coh_conv
              FROM dealer_leads WHERE is_active IS NOT FALSE`),
        rows(sql`
            WITH called AS (
                SELECT t.dealer_lead_id,
                       bool_or(t.call_status = 'connected') AS connected
                  FROM lead_touchpoints t
                 WHERE t.touchpoint_type = 'ai_call' AND ${inWin(sql`t.performed_at`, from, toExcl)}
                 GROUP BY 1)
            SELECT COUNT(*) AS leads_called,
                   COUNT(*) FILTER (WHERE c.connected) AS connected,
                   COUNT(*) FILTER (WHERE lower(dl.current_status) IN ('qualified', 'ai_qualified')) AS ai_qualified,
                   COUNT(*) FILTER (WHERE lower(dl.current_status) IN ('qualified', 'ai_qualified')
                                      AND dl.lead_status = 'Converted') AS ai_qualified_converted
              FROM called c JOIN dealer_leads dl ON dl.id = c.dealer_lead_id`),
    ]);
    // Change Spec §5.6: headline = cohort conversion "to date" until three
    // months of 30-day cohort history exist, then the 30-day rate.
    const h = hist[0];
    const mature = Boolean(h.has_history);
    const headline = mature
        ? {
              measure: "conversion_30d_rate" as const,
              label: "30-day lead conversion (leads created 31–60 days ago)",
              value: n(h.c30) > 0 ? n(h.c30_conv) / n(h.c30) : null,
          }
        : {
              measure: "cohort_conversion_to_date" as const,
              label: "Lead conversion to date (leads created in this period)",
              value: n(h.coh) > 0 ? n(h.coh_conv) / n(h.coh) : null,
          };
    const a = ai[0];
    return {
        leads_in: { now: n(now.leads_in), prev: prev ? n(prev.leads_in) : null },
        converted: { now: n(now.converted), prev: prev ? n(prev.converted) : null },
        first_orders: { now: n(now.first_orders), prev: prev ? n(prev.first_orders) : null },
        headline,
        ai: {
            leads_called: n(a.leads_called),
            connect_pct: n(a.leads_called) > 0 ? Math.round((n(a.connected) / n(a.leads_called)) * 100) : null,
            ai_qualified: n(a.ai_qualified),
            ai_qualified_converted: n(a.ai_qualified_converted),
        },
    };
}

// ── 4 Base ───────────────────────────────────────────────────────────────────
async function baseTile(from: string, toExcl: string, prevFrom: string | null, prevTo: string | null) {
    const dealers = await listDealerHealth();
    const by = {} as Record<AccountBucket, number>;
    for (const d of dealers) by[d.bucket] = (by[d.bucket] ?? 0) + 1;

    const kg = async (a: string, b: string) => {
        const [r] = await rows(sql`
            SELECT COALESCE(SUM(l.quantity * l.unit_weight_kg), 0) AS kg
              FROM (SELECT DISTINCT al.request_id FROM buyback_activity_log al
                     WHERE al.action = 'complete_pickup' AND ${inWin(sql`al.created_at`, a, b)}) p
              JOIN buyback_batches bt ON bt.request_id = p.request_id
              JOIN buyback_lines l ON l.batch_id = bt.id`);
        return n(r.kg);
    };
    const [kgNow, kgPrev, money] = await Promise.all([
        kg(from, toExcl),
        prevFrom && prevTo ? kg(prevFrom, prevTo) : Promise.resolve(null),
        rows(sql`
            SELECT COALESCE(SUM(amount) FILTER (WHERE leg = 'DEALER'), 0) AS paid,
                   COALESCE(SUM(amount) FILTER (WHERE leg = 'VENDOR'), 0) AS received,
                   COUNT(*) FILTER (WHERE leg = 'VENDOR') AS vendor_rows
              FROM settlement_transactions
             WHERE txn_date >= ${from}::date AND txn_date < ${toExcl}::date`),
    ]);
    const paid = n(money[0]?.paid);
    return {
        dealers: by,
        buyback: {
            kg: { now: kgNow, prev: kgPrev },
            paid,
            per_kg: kgNow > 0 ? Math.round((paid / kgNow) * 100) / 100 : null,
            // Margin only where the recycler sale is booked in the same period.
            margin: n(money[0]?.vendor_rows) > 0 ? n(money[0]?.received) - paid : null,
        },
    };
}

// ── 5 People ─────────────────────────────────────────────────────────────────
async function peopleTile(from: string, toIncl: string) {
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const [dash, idle, engaged, pct] = await Promise.all([
        buildSalesDashboard({ from, to: toIncl, granularity: "month" }),
        summarizeNeedsAttention({ minDays: 7 }),
        rows(sql`
            SELECT t.performed_by AS u,
                   COUNT(*) AS calls,
                   COUNT(*) FILTER (WHERE t.is_engaged IS TRUE) AS engaged
              FROM lead_touchpoints t
             WHERE t.touchpoint_type = 'inside_sales_call' AND t.performed_by IS NOT NULL
               AND (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${toIncl}::date
             GROUP BY 1`),
        safe("targets", async () => {
            if (!(await hasTargetsTable())) return null;
            const { listTargets } = await import("@/lib/targets/service");
            const t = await listTargets({ month: toIncl.slice(0, 7) });
            const m = new Map<string, number[]>();
            for (const r of t) {
                if ((r.status === "accepted" || r.status === "pushed") && r.progress.pct_of_mtd != null) {
                    m.set(r.user_id, [...(m.get(r.user_id) ?? []), r.progress.pct_of_mtd]);
                }
            }
            return new Map([...m.entries()].map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]));
        }),
    ]);
    const idleBy = new Map(idle.map((h) => [h.holder_id, h.idle]));
    const engBy = new Map(engaged.map((e) => [String(e.u), n(e.calls) > 0 ? Math.round((n(e.engaged) / n(e.calls)) * 100) : null]));
    const list = (dash.per_spoc ?? [])
        .filter((b) => b.role !== null)
        .map((b) => ({
            spoc_id: b.spoc_id,
            name: b.name ?? b.spoc_id,
            pct_of_target: pct?.get(b.spoc_id) ?? null,
            converted: b.totals.converted,
            revenue: b.outcome.revenue,
            idle_leads: idleBy.get(b.spoc_id) ?? 0,
            engaged_pct: engBy.get(b.spoc_id) ?? null,
        }));
    const hasTargets = list.some((r) => r.pct_of_target != null);
    list.sort((a, b) =>
        hasTargets
            ? (b.pct_of_target ?? -1) - (a.pct_of_target ?? -1)
            : b.converted - a.converted || b.revenue - a.revenue,
    );
    return { basis: hasTargets ? ("target" as const) : ("converted" as const), rows: list };
}
