// Tracker ID 51 #2 — the small Ecofy block on the Sales Head and CEO
// dashboards: every Ecofy lead the CRM holds, by its CURRENT Ecofy stage.
// A separate pipeline: these counts are never added to the dealer funnel.
//
// Pure: no DB, no env. The route (api/ecofy/stage-summary) does the GROUP BY;
// this orders and labels the rows the same way Block G of the Sales Daily
// email and the admin Funnel tab do (S0 … S8, Closed, unknown last).

import { ECOFY_STAGE_LABELS } from "./access";

export interface EcofyStageRow {
    stage: string;
    label: string;
    count: number;
}

export interface EcofyStageSummary {
    /** false when ecofy_leads could not be read on this database. */
    available: boolean;
    total: number;
    /** Not S0 and not CLOSED — the leads being worked (same rule as ecofyCounts().open). */
    open: number;
    /** S1 with no CRM owner — the Pickup Queue. */
    queue: number;
    byStage: EcofyStageRow[];
}

export const EMPTY_ECOFY_STAGE_SUMMARY: EcofyStageSummary = { available: false, total: 0, open: 0, queue: 0, byStage: [] };

export function ecofyStageSummary(
    rows: Array<{ stage: string | null; n: number | string }>,
    queue: number | string,
): EcofyStageSummary {
    const order = Object.keys(ECOFY_STAGE_LABELS);
    const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length);
    const merged = new Map<string, number>();
    for (const r of rows) {
        const stage = (r.stage ?? "").trim() || "UNKNOWN";
        const n = Number(r.n) || 0;
        if (n > 0) merged.set(stage, (merged.get(stage) ?? 0) + n);
    }
    const byStage = [...merged.entries()]
        .map(([stage, count]) => ({
            stage,
            label: ECOFY_STAGE_LABELS[stage] ?? (stage === "UNKNOWN" ? "No stage" : stage),
            count,
        }))
        .sort((a, b) => rank(a.stage) - rank(b.stage) || a.stage.localeCompare(b.stage));
    const total = byStage.reduce((t, r) => t + r.count, 0);
    // ecofyCounts().open: stage IS NULL or not in (S0, CLOSED).
    const open = byStage.filter((r) => r.stage !== "S0" && r.stage !== "CLOSED").reduce((t, r) => t + r.count, 0);
    return { available: true, total, open, queue: Number(queue) || 0, byStage };
}
