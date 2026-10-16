"use client";

// ID 156 — a manager's team against the manager's OWN target (everyone has
// their own target; the team lead's is not the sum of the members'). Shown on
// the Performance page when "Team total" is picked. The actual is the
// manager's own + each member's for the days they were in the team, month to
// date (src/lib/admin/teamPerformance.ts). Renders nothing without targets.

import { useQuery } from "@tanstack/react-query";

import { TargetProgressCells, fmtTargetPer, fmtTargetSum, progressHeaders } from "@/components/targets/TargetProgressCells";
import type { TargetRow } from "@/lib/targets/service";

type TeamTargets = {
    month: string;
    rows: TargetRow[];
    context: { working_days_total: number; working_days_elapsed: number } | null;
    members: Array<{ id: string; name: string | null; from: string; to: string }>;
};

export function TeamTargetsCard() {
    const { data, isLoading, error } = useQuery<TeamTargets>({
        queryKey: ["my-team-targets"],
        queryFn: async () => {
            const res = await fetch("/api/me/team-targets", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load the team target");
            return json.data;
        },
    });

    if (isLoading) return <div className="h-24 animate-pulse rounded-xl border border-border bg-surface" />;
    if (error) return <p className="text-sm text-danger">{(error as Error).message}</p>;
    if (!data || data.rows.length === 0) {
        return (
            <div className="rounded-xl border border-dashed border-border bg-surface px-4 py-3 text-sm text-ink-muted">
                No target is pushed to you for this month, so there is nothing to hold the team total against.
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 py-3">
                <h3 className="text-sm font-semibold text-ink">Team against your target</h3>
                <p className="text-[11px] text-ink-muted">
                    Your own monthly target (the team lead&apos;s target is yours, not the sum of the members&apos;). Actual =
                    you + each member for the days they were in your team, this month to date
                    {data.context ? ` · ${data.context.working_days_elapsed} of ${data.context.working_days_total} working days gone` : ""}.
                </p>
            </div>
            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Metric</th>
                            <th className="px-3 py-2 text-right font-semibold">Your target</th>
                            {progressHeaders(data.context).map((h) => (
                                <th key={h} className="px-3 py-2 text-right font-semibold">
                                    {h === "Actual to date" ? "Team actual to date" : h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {data.rows.map((r) => (
                            <tr key={r.id}>
                                <td className="px-3 py-2 text-ink">{r.metric_label}</td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {fmtTargetPer(r.metric, r.final_target, r.unit, r.kind)}
                                    {/* ID 189: the sum, so a stretch is visible. */}
                                    {r.stretch > 0 && (
                                        <span className="block text-[10px] text-ink-muted">{fmtTargetSum(r.metric, r.ceo_target, r.stretch, r.unit)}</span>
                                    )}
                                </td>
                                <TargetProgressCells metric={r.metric} p={r.progress} unit={r.unit} kind={r.kind} />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
