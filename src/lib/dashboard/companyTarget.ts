// Company targets on the CEO headline tiles (Revenue, Batteries to dealers).
// Pure — no I/O — so the CEO page and its tests share one rule.
//
// There is no company-level target: it is the sum of everyone's monthly
// targets in the register (/admin/targets). A past month counts in full; the
// current month counts to date (pro-rata over working days).
//
// The tile's actual covers the WHOLE period, so a % of target is shown only
// when every month of the period has a target. Otherwise FY revenue would be
// divided by one month's target (seen live: 20,766 %).

export type CompanyTargetMetric = "revenue" | "batteries_sold";

export type TargetRowLite = {
    metric: string;
    /** draft · pending_approval · pushed · accepted (TARGET_STATUSES). */
    status?: string | null;
    progress: { monthly_target: number; mtd_target: number };
};

export type CompanyTarget = {
    /** Target over the months that have one — every status counts (ID 157). */
    sum: number;
    /**
     * ID 157 (10 Oct): the part of `sum` its people have accepted, and the rest
     * (Draft + Pending approval + Pushed). accepted + notAccepted === sum.
     */
    accepted: number;
    notAccepted: number;
    /** Months of the period ("YYYY-MM") with no target for the metric. */
    missing: string[];
};

export function summariseCompanyTargets(
    lists: ReadonlyArray<{ month: string; rows: ReadonlyArray<TargetRowLite> }>,
    months: readonly string[],
    thisMonth: string,
): Record<CompanyTargetMetric, CompanyTarget> {
    const perMonth: Record<CompanyTargetMetric, Map<string, number>> = {
        revenue: new Map(),
        batteries_sold: new Map(),
    };
    const accepted: Record<CompanyTargetMetric, number> = { revenue: 0, batteries_sold: 0 };
    for (const { month, rows } of lists) {
        for (const r of rows) {
            if (r.metric !== "revenue" && r.metric !== "batteries_sold") continue;
            // "Has a target" is judged on the full monthly figure, so the 1st of
            // the month (0 working days elapsed, to-date target 0) is not missing.
            if (!(Number(r.progress.monthly_target) > 0)) continue;
            const v = month === thisMonth ? r.progress.mtd_target : r.progress.monthly_target;
            const m = perMonth[r.metric];
            m.set(month, (m.get(month) ?? 0) + Number(v || 0));
            if (r.status === "accepted") accepted[r.metric] += Number(v || 0);
        }
    }
    const summarise = (metric: CompanyTargetMetric): CompanyTarget => {
        const m = perMonth[metric];
        const sum = [...m.values()].reduce((a, v) => a + v, 0);
        return {
            sum,
            accepted: accepted[metric],
            notAccepted: sum - accepted[metric],
            missing: months.filter((mo) => !m.has(mo)),
        };
    };
    return { revenue: summarise("revenue"), batteries_sold: summarise("batteries_sold") };
}

export type TargetVerdict =
    | { kind: "none" }
    | { kind: "partial"; goal: number; covered: string[]; includesThisMonth: boolean }
    | { kind: "set"; goal: number; pct: number | null };

/** What the tile shows: no target, a target for only some months, or a %. */
export function targetVerdict(
    t: Pick<CompanyTarget, "sum" | "missing"> | null | undefined,
    actual: number | null,
    months: readonly string[],
    thisMonth: string,
): TargetVerdict {
    if (!t || !(t.sum > 0)) return { kind: "none" };
    if (t.missing.length > 0) {
        const covered = months.filter((mo) => !t.missing.includes(mo));
        return { kind: "partial", goal: t.sum, covered, includesThisMonth: covered.includes(thisMonth) };
    }
    return { kind: "set", goal: t.sum, pct: actual == null ? null : Math.round((actual / t.sum) * 100) };
}
