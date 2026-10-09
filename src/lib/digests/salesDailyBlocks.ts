// Daily Sales email v1.1 — Blocks B, C and D (tracker ID 9, plan decided
// 1 Oct 2026: "build B–F from the Block A metric set"; the B–F mockup does
// not exist, only Block A's).
//
//   B · Field team (ASM)     ONE ROW PER ASM: Dealers visited (Yesterday, MTD),
//                            New dealers visited (Y, MTD), Hot received (Y,
//                            MTD), Quotes created (Y, MTD), Quotes delivered,
//                            Dealer approved, Marked Won, Converted, Revenue
//                            (MTD), % of target.
//   C · Inside sales (ISR)   ONE ROW PER ISR / CC: Calls (Y, MTD), Dealers
//                            called (Y, MTD), Connected, Connect %, Engaged,
//                            Hot to field, Quotes created, Marked Won,
//                            Converted (MTD), % of target.
//   Decided 29 Sep 2026: Blocks B and C show Yesterday + MTD only (Last 7 days
//   lives on the Sales Head dashboard). Layout follows the earlier per-rep
//   table (commit 37a6318b) and docs/neodove-contract.md (Block C call
//   quality). "% of target" is ONE column on the rep's primary target — ASM:
//   Dealers visited MTD vs dealer_visits; ISR: Calls MTD vs calls_per_day —
//   only where the rep has a pushed / accepted sales_targets row (the same
//   pro-rating as Block A), else "—". A Total row closes each table.
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
//   Hot handed to field  the ISR who performed the asm_transfer (distinct leads:
//                        a lead handed over twice in a window counts once)
//   Connected / Engaged  the caller (performed_by); connectedCall() and
//                        engagedCall() — since ID 59 an engaged call is a
//                        connected one, so the two match
//   Quotes delivered     whoever dispatched the quote (performed_by)
//   Dealer approved      the quote's creator (dealer_lead_commercials.created_by)
//   Marked Won           whoever moved the lead to Won (changed_by)
//
// The row shaping is pure (unit tested in __tests__/salesDailyBlocks.test.ts);
// the queries take the db handle as a parameter, never import it.

import { sql } from "drizzle-orm";

import type { SalesDashboard, SalesSpocBlock } from "@/lib/admin/salesDashboardTypes";
import { connectedCall, engagedCall, wasHotAt } from "@/lib/reports/metricDefinitions";
import { fmtValue, pctOfTarget, type Period } from "./salesDailyBlockA";
import { istRangeTz } from "./window";

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };
type Rows = Array<Array<string | number>>;

/** Per-user MTD targets, already pro-rated: user id → metric → target. */
export type UserTargets = Map<string, Map<string, number>>;

/**
 * Per-person counts from a direct query; null = the query failed (not
 * measured). A per-person null (Engaged only) = nothing of theirs measurable.
 */
export type PerRep = Map<string, number | null> | null;

export type RepExtras = {
    hot_received: PerRep;
    hot_handed: PerRep;
    connected: PerRep;
    engaged: PerRep;
    quotes_delivered: PerRep;
    dealer_approved: PerRep;
    won: PerRep;
};

export type RepMetricKey =
    | "visited"
    | "new_visited"
    | "hot_received"
    | "quotes"
    | "quotes_delivered"
    | "dealer_approved"
    | "won"
    | "converted"
    | "revenue"
    | "calls"
    | "dealers_called"
    | "connected"
    | "engaged"
    | "hot_handed";

/** One metric for one rep; null = not measured. */
export type RepValue = { y: number | null; mtd: number | null };

export type RepBlock = {
    id: string;
    name: string;
    values: Partial<Record<RepMetricKey, RepValue>>;
    /** MTD target of the rep's primary metric (see PRIMARY_TARGET), null when none is set. */
    target: number | null;
};

export const NO_OWNER = "(no owner)";
/** Map key for counts that belong to nobody. */
export const NO_OWNER_KEY = "__no_owner__";
/** Shown for a figure that cannot be measured (a failed query, no measured calls). */
export const REP_NOT_MEASURED = "—";

// ─────────────────────────────── pure shaping ───────────────────────────────

type MetricDef = {
    kind: "count" | "money";
    /** From the builder's per-rep block … */
    dash?: (b: SalesSpocBlock) => number;
    /** … or from a direct per-rep query. */
    extra?: keyof RepExtras;
};

const METRICS: Record<RepMetricKey, MetricDef> = {
    visited: { kind: "count", dash: (b) => b.totals.unique_visits },
    new_visited: { kind: "count", dash: (b) => b.totals.new_visits },
    hot_received: { kind: "count", extra: "hot_received" },
    quotes: { kind: "count", dash: (b) => b.outcome.quotes_issued },
    quotes_delivered: { kind: "count", extra: "quotes_delivered" },
    dealer_approved: { kind: "count", extra: "dealer_approved" },
    won: { kind: "count", extra: "won" },
    converted: { kind: "count", dash: (b) => b.totals.converted },
    revenue: { kind: "money", dash: (b) => b.outcome.revenue },
    calls: { kind: "count", dash: (b) => b.totals.calls },
    dealers_called: { kind: "count", dash: (b) => b.totals.dealers_called },
    connected: { kind: "count", extra: "connected" },
    engaged: { kind: "count", extra: "engaged" },
    hot_handed: { kind: "count", extra: "hot_handed" },
};

/** The one target "% of target" is read against: metric shown vs sales_targets key. */
const PRIMARY_TARGET: Record<"asm" | "inside_sales_rep", { metric: RepMetricKey; target: string }> = {
    asm: { metric: "visited", target: "dealer_visits" },
    inside_sales_rep: { metric: "calls", target: "calls_per_day" },
};

type ColSpec =
    | { header: string; name: true }
    | { header: string; metric: RepMetricKey; period: "y" | "mtd" }
    /** numerator MTD / denominator MTD, as a % ("—" when the denominator is 0). */
    | { header: string; ratio: [RepMetricKey, RepMetricKey] }
    | { header: string; pctTarget: true };

const ASM_COLS: ColSpec[] = [
    { header: "ASM", name: true },
    { header: "Dealers visited · Yesterday", metric: "visited", period: "y" },
    { header: "MTD", metric: "visited", period: "mtd" },
    { header: "New dealers visited · Yesterday", metric: "new_visited", period: "y" },
    { header: "MTD", metric: "new_visited", period: "mtd" },
    { header: "Hot received · Yesterday", metric: "hot_received", period: "y" },
    { header: "MTD", metric: "hot_received", period: "mtd" },
    { header: "Quotes created · Yesterday", metric: "quotes", period: "y" },
    { header: "MTD", metric: "quotes", period: "mtd" },
    { header: "Quotes delivered MTD", metric: "quotes_delivered", period: "mtd" },
    { header: "Dealer approved MTD", metric: "dealer_approved", period: "mtd" },
    { header: "Marked Won MTD", metric: "won", period: "mtd" },
    { header: "Converted MTD", metric: "converted", period: "mtd" },
    { header: "Revenue ₹ MTD", metric: "revenue", period: "mtd" },
    { header: "% of target", pctTarget: true },
];

const ISR_COLS: ColSpec[] = [
    { header: "ISR", name: true },
    { header: "Calls · Yesterday", metric: "calls", period: "y" },
    { header: "MTD", metric: "calls", period: "mtd" },
    { header: "Dealers called · Yesterday", metric: "dealers_called", period: "y" },
    { header: "MTD", metric: "dealers_called", period: "mtd" },
    { header: "Connected MTD", metric: "connected", period: "mtd" },
    { header: "Connect % MTD", ratio: ["connected", "calls"] },
    { header: "Engaged MTD", metric: "engaged", period: "mtd" },
    { header: "Hot to field MTD", metric: "hot_handed", period: "mtd" },
    { header: "Quotes created MTD", metric: "quotes", period: "mtd" },
    { header: "Marked Won MTD", metric: "won", period: "mtd" },
    { header: "Converted MTD", metric: "converted", period: "mtd" },
    { header: "% of target", pctTarget: true },
];

const COLS = { asm: ASM_COLS, inside_sales_rep: ISR_COLS } as const;

export const BLOCK_B_COLUMNS = ASM_COLS.map((c) => c.header);
export const BLOCK_C_COLUMNS = ISR_COLS.map((c) => c.header);
/**
 * Index of "% of target" in each block. Coloured with the same red / amber /
 * green thresholds as Block A (rag.ts, toneColumns).
 */
export const BLOCK_B_PCT_COLUMN = BLOCK_B_COLUMNS.indexOf("% of target");
export const BLOCK_C_PCT_COLUMN = BLOCK_C_COLUMNS.indexOf("% of target");

const TOTAL = "Total";

/** "Partner", "Sales Head" — shown after the name of a caller who is not an ISR. */
function roleLabel(role: string): string {
    return role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Every per-rep value is zero or unmeasured. */
function allZero(values: Partial<Record<RepMetricKey, RepValue>>): boolean {
    return Object.values(values).every((v) => !v || ((v.y ?? 0) === 0 && (v.mtd ?? 0) === 0));
}

/**
 * One block per rep of `role`, in name order. Reps come from the builder's
 * per_spoc lists (yesterday ∪ MTD) — the same people Block A sums.
 *
 * Two corrections (7 Oct 2026, reconciled on db-2 by verify-sales-daily.ts):
 *   - Block C also lists anyone else who CALLED (a partner, a sales head…),
 *     named with their role. Block A's "Calls made" counts every human call,
 *     so 10 calls by a partner were in the company total and on no rep's row.
 *   - A deactivated rep with nothing in either window is left out — a row of
 *     zeros for someone who has left reads as a rep doing nothing. One who
 *     still did something stays, marked "(inactive)".
 */
export function buildRepBlocks(
    role: "asm" | "inside_sales_rep",
    y: Pick<SalesDashboard, "per_spoc">,
    mtd: Pick<SalesDashboard, "per_spoc">,
    extras: { y: RepExtras; mtd: RepExtras },
    targets: UserTargets,
): RepBlock[] {
    const keys = [
        ...new Set(COLS[role].flatMap((c) => ("metric" in c ? [c.metric] : "ratio" in c ? c.ratio : []))),
    ];
    const primary = PRIMARY_TARGET[role];
    const yBy = new Map((y.per_spoc ?? []).map((b) => [b.spoc_id, b]));
    const mBy = new Map((mtd.per_spoc ?? []).map((b) => [b.spoc_id, b]));
    const ids = new Set<string>();
    const info = new Map<string, SalesSpocBlock>();
    for (const b of [...(mtd.per_spoc ?? []), ...(y.per_spoc ?? [])]) {
        if (!info.has(b.spoc_id)) info.set(b.spoc_id, b);
        if (b.role === role) ids.add(b.spoc_id);
        else if (role === "inside_sales_rep" && b.role !== "asm" && b.totals.calls > 0) ids.add(b.spoc_id);
    }

    const pick = (def: MetricDef, b: SalesSpocBlock | undefined, ex: RepExtras, id: string): number | null => {
        if (def.dash) return b ? def.dash(b) : 0;
        const m = ex[def.extra!];
        if (m == null) return null;
        return m.has(id) ? m.get(id)! : 0;
    };

    return [...ids]
        .flatMap((id): RepBlock[] => {
            const yb = yBy.get(id);
            const mb = mBy.get(id);
            const t = targets.get(id);
            const values: Partial<Record<RepMetricKey, RepValue>> = {};
            for (const k of keys) {
                values[k] = { y: pick(METRICS[k], yb, extras.y, id), mtd: pick(METRICS[k], mb, extras.mtd, id) };
            }
            const who = info.get(id);
            if (who?.is_active === false && allZero(values)) return [];
            const base = mb?.name ?? yb?.name ?? "(unknown user)";
            const name =
                base +
                (who?.role && who.role !== role ? ` · ${roleLabel(who.role)}` : "") +
                (who?.is_active === false ? " (inactive)" : "");
            return [
                {
                    id,
                    name,
                    values,
                    target: t?.has(primary.target) ? Math.round(t.get(primary.target)!) : null,
                },
            ];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

function sumOf(vals: Array<number | null>): number | null {
    const known = vals.filter((v): v is number => v != null);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/**
 * Email rows for Block B (`asm`) or C (`inside_sales_rep`): one row per rep in
 * the block's column order, then a Total row (sum of the reps listed; "% of
 * target" on the reps that have a target) when there is more than one rep.
 */
export function repBlockTableRows(role: "asm" | "inside_sales_rep", blocks: RepBlock[]): Rows {
    const cols = COLS[role];
    const primary = PRIMARY_TARGET[role].metric;
    const cell = (r: RepBlock, c: ColSpec): string | number => {
        if ("name" in c) return r.name;
        if ("metric" in c) {
            const v = r.values[c.metric]?.[c.period] ?? null;
            if (v == null) return REP_NOT_MEASURED;
            return METRICS[c.metric].kind === "money" ? fmtValue(v, "money") : v;
        }
        if ("ratio" in c) {
            const n = r.values[c.ratio[0]]?.mtd ?? null;
            const d = r.values[c.ratio[1]]?.mtd ?? null;
            return n == null || d == null || d <= 0 ? REP_NOT_MEASURED : `${Math.round((n / d) * 100)}%`;
        }
        const p = pctOfTarget(r.values[primary]?.mtd ?? null, r.target);
        return p == null ? REP_NOT_MEASURED : `${p}%`;
    };

    const rows: Rows = blocks.map((b) => cols.map((c) => cell(b, c)));
    if (blocks.length > 1) {
        const values: Partial<Record<RepMetricKey, RepValue>> = {};
        for (const k of Object.keys(blocks[0].values) as RepMetricKey[]) {
            values[k] = {
                y: sumOf(blocks.map((b) => b.values[k]?.y ?? null)),
                mtd: sumOf(blocks.map((b) => b.values[k]?.mtd ?? null)),
            };
        }
        // % of target on the reps that HAVE a target: their MTD against their targets.
        const withTarget = blocks.filter((b) => b.target != null);
        const total: RepBlock = { id: TOTAL, name: TOTAL, values, target: null };
        const totalRow = cols.map((c) => {
            if (!("pctTarget" in c)) return cell(total, c);
            const p = pctOfTarget(
                sumOf(withTarget.map((b) => b.values[primary]?.mtd ?? null)),
                withTarget.length ? withTarget.reduce((a, b) => a + b.target!, 0) : null,
            );
            return p == null ? REP_NOT_MEASURED : `${p}%`;
        });
        rows.push(totalRow);
    }
    return rows;
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
            // A deactivated owner still holding leads is exactly what this
            // block should surface: those leads have nobody working them.
            return [
                (b?.name ?? names.get(id) ?? id) + (b?.is_active === false ? " (inactive)" : ""),
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
        const m = new Map<string, number | null>();
        for (const r of rows) if (r.u != null) m.set(String(r.u), r.n == null ? null : Number(r.n));
        return m;
    } catch (e) {
        console.warn("[salesDailyBlocks] per-rep metric not measured:", e instanceof Error ? e.message : e);
        return null;
    }
}

/** The direct per-rep counts for one period — Block A's predicates, grouped by person. */
export async function loadRepExtras(db: Exec, p: Period): Promise<RepExtras> {
    const win = (col: ReturnType<typeof sql>) => istRangeTz(col, p.from, p.to);
    const [hot_received, hot_handed, connected, engaged, quotes_delivered, dealer_approved, won] = await Promise.all([
        perRep(
            db,
            sql`SELECT COALESCE(t.to_owner_id, dl.asm_id) AS u, COUNT(DISTINCT t.dealer_lead_id) AS n
                  FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                 WHERE t.touchpoint_type = 'asm_transfer' AND ${win(sql`t.performed_at`)}
                   AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
                 GROUP BY 1`,
        ),
        perRep(
            db,
            sql`SELECT t.performed_by AS u, COUNT(DISTINCT t.dealer_lead_id) AS n
                  FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                 WHERE t.touchpoint_type = 'asm_transfer' AND ${win(sql`t.performed_at`)}
                   AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
                 GROUP BY 1`,
        ),
        perRep(
            db,
            sql`SELECT t.performed_by AS u, COUNT(*) AS n FROM lead_touchpoints t
                 WHERE ${connectedCall()} AND ${win(sql`t.performed_at`)}
                 GROUP BY 1`,
        ),
        // Engaged: a connected human call (ID 59), counted once.
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
                 WHERE h.to_status = 'Won' AND (to_jsonb(h) ->> 'won_undone_at') IS NULL AND ${win(sql`h.changed_at`)}
                 GROUP BY 1`,
        ),
    ]);
    return { hot_received, hot_handed, connected, engaged, quotes_delivered, dealer_approved, won };
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
