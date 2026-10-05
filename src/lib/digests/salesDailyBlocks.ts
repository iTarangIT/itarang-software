// Daily Sales email v1.1 — Blocks B, C and D (tracker ID 9, plan decided
// 1 Oct 2026: "build B–F from the Block A metric set"; the B–F mockup does
// not exist, only Block A's).
//
//   B · Field team (ASM)     per ASM: Dealers visited, New dealers visited,
//                            Hot received, Quotes created, Quotes delivered,
//                            Dealer approved, Marked Won, Converted, Revenue.
//   C · Inside sales (ISR)   per ISR / CC: Calls made, Dealers called, Engaged
//                            calls, Hot handed to field, Quotes created,
//                            Marked Won, Converted.
//   Each rep is a group header followed by one row per metric:
//   Yesterday · MTD · MTD target · % of target. Target and % only where the
//   rep has a pushed / accepted sales_targets row for that metric (the same
//   pro-rating as Block A).
//
//   D · Position             open Hot / Warm / Cold per owner, Hot rated 8+
//                            days ago, Awaiting field visit (lead_status
//                            Transferred_to_ASM, keyed on the ASM) and one
//                            "(no owner)" row carrying Sales-ready, no owner.
//
// SAME DEFINITIONS AS BLOCK A. Whatever Block A reads from the Sales dashboard
// builder is read here from that builder's per_spoc blocks; whatever Block A
// counts directly (engaged calls, hot handed to field, quotes delivered,
// dealer approved, Marked Won) is counted here with the SAME predicate
// (metricDefinitions.ts — humanCall / engagedCall / wasHotAt) split per person
// by GROUP BY. So the reps of one role add up to the company row wherever the
// company row has a person to credit.
//
// Who is credited (direct counts):
//   Hot received         the ASM a Hot lead was transferred TO (to_owner_id,
//                        else the lead's asm_id)
//   Hot handed to field  the ISR who performed the asm_transfer
//   Engaged calls        the caller (performed_by)
//   Quotes delivered     whoever dispatched the quote (performed_by)
//   Dealer approved      the quote's creator (dealer_lead_commercials.created_by)
//   Marked Won           whoever moved the lead to Won (changed_by)
//
// The row shaping is pure (unit tested in __tests__/salesDailyBlocks.test.ts);
// the queries take the db handle as a parameter, never import it.

import { sql } from "drizzle-orm";

import type { SalesDashboard, SalesSpocBlock } from "@/lib/admin/salesDashboardTypes";
import { engagedCall, wasHotAt } from "@/lib/reports/metricDefinitions";
import { fmtValue, pctOfTarget, type Period } from "./salesDailyBlockA";
import { istRangeTz } from "./window";

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };
type Rows = Array<Array<string | number>>;

/** Per-user MTD targets, already pro-rated: user id → metric → target. */
export type UserTargets = Map<string, Map<string, number>>;

/** Per-person counts from a direct query; null = the query failed (not measured). */
export type PerRep = Map<string, number> | null;

export type RepExtras = {
    hot_received: PerRep;
    hot_handed: PerRep;
    engaged: PerRep;
    quotes_delivered: PerRep;
    dealer_approved: PerRep;
    won: PerRep;
};

export type RepMetric = {
    label: string;
    kind: "count" | "money";
    y: number | null;
    mtd: number | null;
    /** Rep's MTD target, null when none is set. */
    target: number | null;
};

export type RepBlock = { id: string; name: string; metrics: RepMetric[] };

export const REP_BLOCK_COLUMNS = ["Metric", "Yesterday", "MTD", "MTD target", "% of target"];

/**
 * Index of "% of target" in REP_BLOCK_COLUMNS. Blocks B and C colour it with
 * the same red / amber / green thresholds as Block A (rag.ts, toneColumns).
 */
export const REP_BLOCK_PCT_COLUMN = REP_BLOCK_COLUMNS.indexOf("% of target");

export const NO_OWNER = "(no owner)";
/** Map key for counts that belong to nobody. */
export const NO_OWNER_KEY = "__no_owner__";

// ─────────────────────────────── pure shaping ───────────────────────────────

type MetricDef = {
    label: string;
    kind: "count" | "money";
    /** From the builder's per-rep block … */
    dash?: (b: SalesSpocBlock) => number;
    /** … or from a direct per-rep query. */
    extra?: keyof RepExtras;
    /** sales_targets metric key, when the register has one. */
    target?: string;
};

const ASM_METRICS: MetricDef[] = [
    { label: "Dealers visited", kind: "count", dash: (b) => b.totals.unique_visits, target: "dealer_visits" },
    { label: "New dealers visited", kind: "count", dash: (b) => b.totals.new_visits, target: "new_dealer_visits" },
    { label: "Hot received", kind: "count", extra: "hot_received" },
    { label: "Quotes created", kind: "count", dash: (b) => b.outcome.quotes_issued },
    { label: "Quotes delivered", kind: "count", extra: "quotes_delivered" },
    { label: "Dealer approved", kind: "count", extra: "dealer_approved" },
    { label: "Marked Won", kind: "count", extra: "won" },
    { label: "Converted", kind: "count", dash: (b) => b.totals.converted },
    { label: "Revenue", kind: "money", dash: (b) => b.outcome.revenue, target: "revenue" },
];

const ISR_METRICS: MetricDef[] = [
    { label: "Calls made", kind: "count", dash: (b) => b.totals.calls, target: "calls_per_day" },
    { label: "Dealers called", kind: "count", dash: (b) => b.totals.dealers_called },
    { label: "Engaged calls", kind: "count", extra: "engaged" },
    { label: "Hot handed to field", kind: "count", extra: "hot_handed", target: "hot_to_ground" },
    { label: "Quotes created", kind: "count", dash: (b) => b.outcome.quotes_issued },
    { label: "Marked Won", kind: "count", extra: "won" },
    { label: "Converted", kind: "count", dash: (b) => b.totals.converted },
];

/**
 * One block per rep of `role`, in name order. Reps come from the builder's
 * per_spoc lists (yesterday ∪ MTD) — the same people Block A sums.
 */
export function buildRepBlocks(
    role: "asm" | "inside_sales_rep",
    y: Pick<SalesDashboard, "per_spoc">,
    mtd: Pick<SalesDashboard, "per_spoc">,
    extras: { y: RepExtras; mtd: RepExtras },
    targets: UserTargets,
): RepBlock[] {
    const defs = role === "asm" ? ASM_METRICS : ISR_METRICS;
    const yBy = new Map((y.per_spoc ?? []).map((b) => [b.spoc_id, b]));
    const mBy = new Map((mtd.per_spoc ?? []).map((b) => [b.spoc_id, b]));
    const ids = new Set<string>();
    for (const b of [...(mtd.per_spoc ?? []), ...(y.per_spoc ?? [])]) if (b.role === role) ids.add(b.spoc_id);

    const pick = (def: MetricDef, b: SalesSpocBlock | undefined, ex: RepExtras, id: string): number | null => {
        if (def.dash) return b ? def.dash(b) : 0;
        const m = ex[def.extra!];
        return m == null ? null : (m.get(id) ?? 0);
    };

    return [...ids]
        .map((id) => {
            const yb = yBy.get(id);
            const mb = mBy.get(id);
            const t = targets.get(id);
            return {
                id,
                name: mb?.name ?? yb?.name ?? "(unknown user)",
                metrics: defs.map((d) => ({
                    label: d.label,
                    kind: d.kind,
                    y: pick(d, yb, extras.y, id),
                    mtd: pick(d, mb, extras.mtd, id),
                    target: d.target && t?.has(d.target) ? Math.round(t.get(d.target)!) : null,
                })),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Email rows: the rep's name as a group header, then one row per metric. */
export function repBlockTableRows(blocks: RepBlock[]): Rows {
    const out: Rows = [];
    for (const b of blocks) {
        out.push([b.name, "", "", "", ""]);
        for (const m of b.metrics) {
            const p = pctOfTarget(m.mtd, m.target);
            out.push([
                m.label,
                fmtValue(m.y, m.kind),
                fmtValue(m.mtd, m.kind),
                m.target == null ? "—" : fmtValue(m.target, m.kind),
                p == null ? "—" : `${p}%`,
            ]);
        }
    }
    return out;
}

function level(b: SalesSpocBlock, l: "hot" | "warm" | "cold"): number {
    return b.interest.rows.find((r) => r.interest_level === l)?.total ?? 0;
}

/** Hot leads whose rating is more than 7 days old (interest_changed_at, E-301). */
function hotOverAWeek(b: SalesSpocBlock): number {
    const r = b.interest.rows.find((x) => x.interest_level === "hot");
    return r ? r.age_8_14 + r.age_15_30 + r.age_30_plus : 0;
}

export const BLOCK_D_COLUMNS = [
    "Owner",
    "Hot",
    "Warm",
    "Cold",
    "Hot, rated 8+ days ago",
    "Awaiting field visit",
    "Sales-ready, no owner",
];

/**
 * The as-of-now position, one row per owner holding any open rated lead or a
 * lead awaiting a field visit, then a "(no owner)" row when sales-ready leads
 * (or transferred leads) have nobody. Hot / Warm / Cold come from ONE builder
 * run: the interest section ignores the date range.
 */
export function blockDRows(
    d: Pick<SalesDashboard, "per_spoc">,
    awaiting: Map<string, number>,
    names: Map<string, string>,
    salesReadyNoOwner: number,
): Rows {
    const spocs = new Map((d.per_spoc ?? []).map((b) => [b.spoc_id, b]));
    const ids = new Set<string>();
    for (const b of spocs.values()) if (level(b, "hot") + level(b, "warm") + level(b, "cold") > 0) ids.add(b.spoc_id);
    for (const [id, n] of awaiting) if (id !== NO_OWNER_KEY && n > 0) ids.add(id);

    const rows: Rows = [...ids]
        .map((id) => {
            const b = spocs.get(id);
            return [
                b?.name ?? names.get(id) ?? id,
                b ? level(b, "hot") : 0,
                b ? level(b, "warm") : 0,
                b ? level(b, "cold") : 0,
                b ? hotOverAWeek(b) : 0,
                awaiting.get(id) ?? 0,
                "—",
            ] as Array<string | number>;
        })
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    const unownedAwaiting = awaiting.get(NO_OWNER_KEY) ?? 0;
    if (salesReadyNoOwner > 0 || unownedAwaiting > 0) {
        rows.push([NO_OWNER, "—", "—", "—", "—", unownedAwaiting, salesReadyNoOwner]);
    }
    return rows;
}

// ─────────────────────────────── queries ────────────────────────────────────

/** One per-person count; fail-tolerant like Block A (null = not measured). */
async function perRep(db: Exec, q: ReturnType<typeof sql>): Promise<PerRep> {
    try {
        const rows = (await db.execute(q)) as Array<{ u: string | null; n: string | number | null }>;
        const m = new Map<string, number>();
        for (const r of rows) if (r.u != null) m.set(String(r.u), Number(r.n ?? 0));
        return m;
    } catch (e) {
        console.warn("[salesDailyBlocks] per-rep metric not measured:", e instanceof Error ? e.message : e);
        return null;
    }
}

/** The direct per-rep counts for one period — Block A's predicates, grouped by person. */
export async function loadRepExtras(db: Exec, p: Period): Promise<RepExtras> {
    const win = (col: ReturnType<typeof sql>) => istRangeTz(col, p.from, p.to);
    const [hot_received, hot_handed, engaged, quotes_delivered, dealer_approved, won] = await Promise.all([
        perRep(
            db,
            sql`SELECT COALESCE(t.to_owner_id, dl.asm_id) AS u, COUNT(*) AS n
                  FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                 WHERE t.touchpoint_type = 'asm_transfer' AND ${win(sql`t.performed_at`)}
                   AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
                 GROUP BY 1`,
        ),
        perRep(
            db,
            sql`SELECT t.performed_by AS u, COUNT(*) AS n
                  FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                 WHERE t.touchpoint_type = 'asm_transfer' AND ${win(sql`t.performed_at`)}
                   AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
                 GROUP BY 1`,
        ),
        perRep(
            db,
            sql`SELECT t.performed_by AS u, COUNT(*) AS n FROM lead_touchpoints t
                 WHERE ${engagedCall()} AND ${win(sql`t.performed_at`)}
                 GROUP BY 1`,
        ),
        perRep(
            db,
            sql`SELECT t.performed_by AS u, COUNT(*) AS n FROM lead_touchpoints t
                 WHERE t.touchpoint_type = 'quote_dispatched' AND ${win(sql`t.performed_at`)}
                 GROUP BY 1`,
        ),
        perRep(
            db,
            sql`SELECT c.created_by AS u, COUNT(*) AS n FROM dealer_lead_commercials c
                 WHERE c.dealer_decision = 'approved' AND ${win(sql`c.dealer_decision_at`)}
                 GROUP BY 1`,
        ),
        perRep(
            db,
            sql`SELECT h.changed_by AS u, COUNT(DISTINCT h.dealer_lead_id) AS n FROM dealer_lead_status_history h
                 WHERE h.to_status = 'Won' AND ${win(sql`h.changed_at`)}
                 GROUP BY 1`,
        ),
    ]);
    return { hot_received, hot_handed, engaged, quotes_delivered, dealer_approved, won };
}

/**
 * Leads transferred to the field and not yet visited (lead_status
 * Transferred_to_ASM), per ASM; a lead with no ASM and no owner counts under
 * NO_OWNER_KEY. Null when the query fails.
 */
export async function loadAwaitingFieldVisit(db: Exec): Promise<Map<string, number> | null> {
    try {
        const rows = (await db.execute(sql`
            SELECT COALESCE(dl.asm_id, dl.current_owner_id) AS u, COUNT(*)::int AS n
              FROM dealer_leads dl
             WHERE dl.lead_status = 'Transferred_to_ASM' AND dl.is_active IS NOT FALSE
             GROUP BY 1
        `)) as Array<{ u: string | null; n: number }>;
        const m = new Map<string, number>();
        for (const r of rows) {
            const k = r.u == null ? NO_OWNER_KEY : String(r.u);
            m.set(k, (m.get(k) ?? 0) + Number(r.n));
        }
        return m;
    } catch (e) {
        console.warn("[salesDailyBlocks] awaiting field visit not measured:", e instanceof Error ? e.message : e);
        return null;
    }
}
