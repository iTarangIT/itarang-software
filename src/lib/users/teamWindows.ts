/**
 * ID 156 — a manager's "Team total" for a date range, as pure rules (no db, so
 * it is unit-tested). The data half is src/lib/admin/teamPerformance.ts.
 *
 * Business (Kartik, 10 Oct): Team total = the members' numbers FOR THE DATES
 * THEY WERE IN THE TEAM, plus the manager's own. Reporting lines are dated
 * (E-338 user_reporting_lines: effective_from, effective_to = exclusive end),
 * so each member's line is clipped to the range, members sharing the same
 * clipped window are read in one go, and the parts are summed.
 */
import type {
    SalesAverages,
    SalesOutcome,
    SalesSeriesRow,
    SalesTotals,
} from "@/lib/admin/salesDashboardTypes";

/** One reporting line of a member to the manager: [from, to_excl). */
export type TeamStint = { user_id: string; effective_from: string; effective_to: string | null };

/** A date window and the reps whose numbers are read for it. */
export type TeamWindow = { from: string; to: string; ids: string[] };

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysInclusive = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

/**
 * The windows to read for the manager's team over [from, to] (inclusive days):
 * the manager over the whole range, each member over the part of it they
 * reported to the manager. Members (and the manager) with the same window
 * share one entry. A member with two stints in the range gets both.
 */
export function teamWindows(managerId: string, stints: readonly TeamStint[], from: string, to: string): TeamWindow[] {
    const byWindow = new Map<string, TeamWindow>();
    const add = (id: string, a: string, b: string) => {
        if (a > b) return;
        const key = `${a}|${b}`;
        const w = byWindow.get(key) ?? { from: a, to: b, ids: [] };
        if (!w.ids.includes(id)) w.ids.push(id);
        byWindow.set(key, w);
    };
    add(managerId, from, to);
    for (const s of stints) {
        if (s.user_id === managerId) continue;
        const start = s.effective_from > from ? s.effective_from : from;
        const lastDay = s.effective_to ? addDays(s.effective_to, -1) : to;
        add(s.user_id, start, lastDay < to ? lastDay : to);
    }
    return [...byWindow.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** True when one read over [from, to] for these ids is the whole answer. */
export function isSingleWindow(windows: readonly TeamWindow[], from: string, to: string): boolean {
    return windows.length === 1 && windows[0].from === from && windows[0].to === to;
}

export type WindowPart = {
    days: number;
    series: SalesSeriesRow[];
    averages: SalesAverages;
    totals: SalesTotals;
    outcome: SalesOutcome;
};

const sumKeys = <T extends object>(parts: T[]): T => {
    const out = { ...parts[0] } as Record<string, unknown>;
    for (const p of parts.slice(1)) {
        for (const [k, v] of Object.entries(p)) {
            if (typeof v === "number") out[k] = (Number(out[k]) || 0) + v;
        }
    }
    return out as T;
};

/**
 * Sum the windows' range sections. Totals, outcome and series add up (series
 * by bucket); averages are re-weighted to the whole range: each window's
 * average × its days, over the range's days. Distinct counts (unique visits,
 * dealers called) are summed per person — the Team total is the sum of the
 * members' own numbers, as the business asked.
 */
export function mergeWindowParts(parts: readonly WindowPart[], rangeDays: number) {
    if (parts.length === 0) throw new Error("mergeWindowParts: no parts");
    const series = new Map<string, SalesSeriesRow>();
    for (const p of parts) {
        for (const r of p.series) {
            const cur = series.get(r.bucket);
            series.set(r.bucket, cur ? sumKeys([cur, r]) : { ...r });
        }
    }
    const lines = parts.map((p) => p.outcome.battery_lines);
    const outcome: SalesOutcome = {
        ...sumKeys(parts.map((p) => p.outcome)),
        battery_lines: lines.every((l) => l == null)
            ? null
            : {
                  invoices: lines.reduce((a, l) => a + (l?.invoices ?? 0), 0),
                  with_lines: lines.reduce((a, l) => a + (l?.with_lines ?? 0), 0),
              },
    };
    const weigh = (k: keyof Omit<SalesAverages, "days_in_range">) =>
        Math.round((parts.reduce((a, p) => a + p.averages[k] * p.days, 0) / rangeDays) * 100) / 100;
    return {
        series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
        averages: {
            days_in_range: rangeDays,
            avg_visits_per_day: weigh("avg_visits_per_day"),
            avg_unique_per_day: weigh("avg_unique_per_day"),
            avg_new_per_day: weigh("avg_new_per_day"),
            avg_calls_per_day: weigh("avg_calls_per_day"),
        } satisfies SalesAverages,
        totals: sumKeys(parts.map((p) => p.totals)),
        outcome,
    };
}
