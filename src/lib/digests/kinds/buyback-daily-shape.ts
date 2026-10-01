/**
 * Buyback Daily — the pure row shaping for revised Format B (Reporting Review
 * v1.0, sheet 4_Email_Buyback; tracker ID 10). No I/O: the queries live in
 * ./buyback-daily.ts, and this half is unit-tested.
 *
 *   Block A  Company headline   metric × Yesterday / Last 7 days / MTD /
 *                               MTD target / % of target / same period last month
 *   Block B  Per SPOC           one table; per owner a Yesterday, Last 7 days
 *                               and MTD row, then MTD target and % of target
 *                               where the SPOC has a target
 *   Block C  Pipeline           built in the query (already row-shaped)
 *   Block D  Pickups            likewise
 *
 * A figure the CRM cannot measure is shown as "—", never as 0.
 */

import { fmtValue, pctOfTarget } from "../salesDailyBlockA";

export const UNASSIGNED = "(unassigned)";
const DASH = "—";

/** What one owner (or the company) did in one period. */
export type BuybackFigures = {
    /** Requests received (submitted) in the period. */
    requests: number;
    /** Requests whose FIRST photo arrived in the period. */
    images: number;
    /** Final offers sent. */
    quotes: number;
    /** Deals the dealer accepted. */
    accepted: number;
    /** Deals that completed pickup. */
    pickups: number;
    /** Σ quantity × unit_weight_kg over the picked-up requests' lines. */
    kg: number;
    /** Lines on those requests with no weight — the kg above is under by these. */
    missing_weight: number;
    /** ₹ paid to suppliers (dealer-leg settlements dated in the period). */
    paid: number;
    /** ₹ gross margin on deals whose recycler sale was booked in the period; null = none booked. */
    margin: number | null;
};

export type BuybackSpocRow = BuybackFigures & {
    /** users.id of the request owner; null = unassigned. */
    spoc: string | null;
    name: string | null;
    /** Distinct dealers this person called (human calls, the Sales Daily rule). */
    dealers_called: number;
};

export const EMPTY_FIGURES: BuybackFigures = {
    requests: 0,
    images: 0,
    quotes: 0,
    accepted: 0,
    pickups: 0,
    kg: 0,
    missing_weight: 0,
    paid: 0,
    margin: null,
};

/**
 * A SPOC row belongs in a buyback mail only when it has a BUYBACK figure.
 * ID 10: dealers_called now counts calls on buyback leads only, so a rep whose
 * only activity is those calls is buyback work and is listed too.
 */
export function hasBuybackFigure(r: BuybackFigures & { dealers_called?: number }): boolean {
    return (
        (r.dealers_called ?? 0) > 0 ||
        r.requests > 0 ||
        r.images > 0 ||
        r.quotes > 0 ||
        r.accepted > 0 ||
        r.pickups > 0 ||
        r.kg > 0 ||
        r.missing_weight > 0 ||
        r.paid > 0 ||
        r.margin != null
    );
}

/** Company totals: every figure is per request and a request has one owner, so they add up. */
export function sumFigures(rows: BuybackFigures[]): BuybackFigures {
    return rows.reduce<BuybackFigures>(
        (a, r) => ({
            requests: a.requests + r.requests,
            images: a.images + r.images,
            quotes: a.quotes + r.quotes,
            accepted: a.accepted + r.accepted,
            pickups: a.pickups + r.pickups,
            kg: a.kg + r.kg,
            missing_weight: a.missing_weight + r.missing_weight,
            paid: a.paid + r.paid,
            margin: r.margin == null ? a.margin : (a.margin ?? 0) + r.margin,
        }),
        { ...EMPTY_FIGURES },
    );
}

/** ₹ paid ÷ kg sourced; null when nothing was weighed (never a division by zero, never a fake 0). */
export function avgPerKg(paid: number, kg: number): number | null {
    return kg > 0 ? Math.round((paid / kg) * 100) / 100 : null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
export const fmtKg = (v: number) => `${round1(v).toLocaleString("en-IN")} kg`;
const fmtMoney = (v: number | null) => (v == null ? DASH : fmtValue(v, "money"));
const fmtPerKg = (v: number | null) => (v == null ? DASH : `₹${v.toLocaleString("en-IN")}/kg`);
const fmtCount = (v: number) => fmtValue(v, "count");

// ───────────────────────────────── Block A ──────────────────────────────────

export const BLOCK_A_COLUMNS = [
    "Metric",
    "Yesterday",
    "Last 7 days",
    "MTD",
    "MTD target",
    "% of target",
    "Same period last month",
];

export type BuybackPeriods<T> = { y: T; d7: T; mtd: T; lm: T };

/**
 * Block A rows. `acceptedTarget` is the company's pro-rated MTD target for
 * Scrap deals (= quotes accepted) — the only buyback target that exists in the
 * targets register today; every other row's target cells read "—".
 */
export function blockARows(
    p: BuybackPeriods<BuybackFigures>,
    acceptedTarget: number | null,
): Array<Array<string | number>> {
    const row = (
        label: string,
        cell: (f: BuybackFigures) => string,
        target: { value: string; pct: string } = { value: DASH, pct: DASH },
    ): Array<string | number> => [label, cell(p.y), cell(p.d7), cell(p.mtd), target.value, target.pct, cell(p.lm)];

    const pct = pctOfTarget(p.mtd.accepted, acceptedTarget);
    return [
        row("Requests received", (f) => fmtCount(f.requests)),
        row("Quotes shared", (f) => fmtCount(f.quotes)),
        row("Quotes accepted", (f) => fmtCount(f.accepted), {
            value: acceptedTarget == null ? DASH : fmtCount(acceptedTarget),
            pct: pct == null ? DASH : `${pct}%`,
        }),
        row("Pickups completed", (f) => fmtCount(f.pickups)),
        row("Kg sourced", (f) => fmtKg(f.kg)),
        row("Lines missing weight", (f) => fmtCount(f.missing_weight)),
        row("₹ paid to suppliers", (f) => fmtMoney(f.paid)),
        row("Avg ₹ / kg", (f) => fmtPerKg(avgPerKg(f.paid, f.kg))),
        row("Gross margin ₹ (where recycler sale booked)", (f) => fmtMoney(f.margin)),
    ];
}

// ───────────────────────────────── Block B ──────────────────────────────────

export const BLOCK_B_COLUMNS = [
    "Period",
    "SPOC",
    "Requests received",
    "Dealers called (unique)",
    "Images received",
    "Quotes shared",
    "Quotes accepted",
    "Pickups completed",
    "Kg sourced (weighed)",
    "Lines missing weight",
    "₹ paid",
    "Avg ₹ / kg",
];

const spocKey = (r: { spoc: string | null }) => r.spoc ?? "";

/**
 * Block B rows: per SPOC a Yesterday, Last 7 days and MTD row; then, where the
 * SPOC has a Scrap-deals target, an MTD target row and a % of target row (the
 * target sits under "Quotes accepted", the metric it is set on).
 *
 * A SPOC appears when any of the three periods has a buyback figure for them.
 * Ordered by name, "(unassigned)" last.
 */
export function blockBRows(
    periods: { yesterday: BuybackSpocRow[]; last7: BuybackSpocRow[]; mtd: BuybackSpocRow[] },
    acceptedTargets: ReadonlyMap<string, number>,
): Array<Array<string | number>> {
    const names = new Map<string, string | null>();
    for (const list of [periods.mtd, periods.last7, periods.yesterday]) {
        for (const r of list) {
            if (hasBuybackFigure(r) && !names.has(spocKey(r))) names.set(spocKey(r), r.name);
        }
    }
    const spocs = [...names.entries()].sort(([ka, a], [kb, b]) => {
        if (ka === "" || kb === "") return ka === kb ? 0 : ka === "" ? 1 : -1;
        return (a ?? ka).localeCompare(b ?? kb);
    });

    const find = (list: BuybackSpocRow[], key: string): BuybackSpocRow | null =>
        list.find((r) => spocKey(r) === key) ?? null;
    const line = (period: string, name: string, r: BuybackSpocRow | null): Array<string | number> => {
        const f: BuybackFigures = r ?? EMPTY_FIGURES;
        return [
            period,
            name,
            f.requests,
            r?.dealers_called ?? 0,
            f.images,
            f.quotes,
            f.accepted,
            f.pickups,
            round1(f.kg),
            f.missing_weight,
            fmtMoney(f.paid),
            fmtPerKg(avgPerKg(f.paid, f.kg)),
        ];
    };

    const out: Array<Array<string | number>> = [];
    for (const [key, rawName] of spocs) {
        const name = key === "" ? UNASSIGNED : (rawName ?? key);
        const mtd = find(periods.mtd, key);
        out.push(line("Yesterday", name, find(periods.yesterday, key)));
        out.push(line("Last 7 days", name, find(periods.last7, key)));
        out.push(line("MTD", name, mtd));
        const target = key === "" ? undefined : acceptedTargets.get(key);
        if (target != null) {
            const pct = pctOfTarget(mtd?.accepted ?? 0, target);
            // Only "Quotes accepted" carries a target; the rest read "—".
            const targetRow = (label: string, accepted: string): Array<string | number> => [
                label, name, DASH, DASH, DASH, DASH, accepted, DASH, DASH, DASH, DASH, DASH,
            ];
            out.push(targetRow("MTD target", fmtCount(target)));
            out.push(targetRow("% of target", pct == null ? DASH : `${pct}%`));
        }
    }
    return out;
}

// ───────────────────────────────── headline ─────────────────────────────────

/** The one line at the top: what was sourced and paid yesterday. */
export function buybackHeadline(y: BuybackFigures): string {
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const kg =
        fmtKg(y.kg) +
        " sourced" +
        // R-13 — never let an under-count read as the real number.
        (y.missing_weight > 0 ? ` (+ ${plural(y.missing_weight, "line", "lines")} with no weight, not counted)` : "");
    return (
        `Yesterday: ${kg} · ${plural(y.requests, "request", "requests")} received · ` +
        `${plural(y.quotes, "quote", "quotes")} shared, ${y.accepted} accepted · ` +
        `${plural(y.pickups, "pickup", "pickups")} completed · ${fmtMoney(y.paid)} paid to suppliers.`
    );
}
