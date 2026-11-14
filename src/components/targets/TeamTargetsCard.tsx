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
    /** ID 239: each direct report's own targets (read-only). */
    member_rows?: TargetRow[];
    people?: Array<{ id: string; name: string }>;
};

const RAG_TONE: Record<string, string> = { green: "bg-emerald-100 text-emerald-800", amber: "bg-amber-100 text-amber-800", red: "bg-rose-100 text-rose-800" };

/** ID 239: the members' final targets on one metric, added up. Pure. */
export function membersTargetSum(memberRows: TargetRow[], metric: string): number | null {
    const rows = memberRows.filter((r) => r.metric === metric);
    return rows.length ? rows.reduce((s, r) => s + (r.final_target ?? 0), 0) : null;
}

/**
 * ID 239: `member` = one direct report's id → that person's targets and RAG (read-only);
 * absent → the team against the manager's own target, plus the Team targets table.
 */
export function TeamTargetsCard({ member }: { member?: string } = {}) {
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
    if (member) {
        const rows = (data?.member_rows ?? []).filter((r) => r.user_id === member);
        const name = data?.people?.find((p) => p.id === member)?.name ?? "This team member";
        return <MemberTargets title={`${name}: targets this month`} rows={rows} context={data?.context ?? null} />;
    }
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
                    you + each member for the days they were in your team, this month to date (a custom metric adds
                    each person&apos;s hand-entered progress on the same metric)
                    {data.context ? ` · ${data.context.working_days_elapsed} of ${data.context.working_days_total} working days gone` : ""}.
                </p>
            </div>
            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Metric</th>
                            <th className="px-3 py-2 text-right font-semibold">Your target</th>
                            <th className="px-3 py-2 text-right font-semibold">Members&apos; targets added up</th>
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
                                <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                                    {(() => {
                                        const sum = membersTargetSum(data.member_rows ?? [], r.metric);
                                        return sum == null ? "—" : fmtTargetPer(r.metric, sum, r.unit, r.kind);
                                    })()}
                                </td>
                                <TargetProgressCells metric={r.metric} p={r.progress} unit={r.unit} kind={r.kind} />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {(data.member_rows?.length ?? 0) > 0 && (
                <TeamTable rows={data.member_rows!} context={data.context} />
            )}
        </div>
    );
}

/** ID 239: every direct report's targets, one row per person and metric, with % to date and RAG. */
function TeamTable({ rows, context }: { rows: TargetRow[]; context: TeamTargets["context"] }) {
    const sorted = [...rows].sort((a, b) => (a.user_name ?? "").localeCompare(b.user_name ?? "") || a.metric_label.localeCompare(b.metric_label));
    return (
        <div className="border-t border-border">
            <h4 className="px-4 pt-3 text-sm font-semibold text-ink">Team targets</h4>
            <p className="px-4 text-[11px] text-ink-muted">Each person&apos;s own target this month, month to date. View only.</p>
            <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Member</th>
                            <th className="px-3 py-2 text-left font-semibold">Metric</th>
                            <th className="px-3 py-2 text-right font-semibold">Target</th>
                            <th className="px-3 py-2 text-right font-semibold">Actual to date</th>
                            <th className="px-3 py-2 text-right font-semibold">% to date</th>
                            <th className="px-3 py-2 text-left font-semibold">RAG</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {sorted.map((r) => (
                            <tr key={r.id}>
                                <td className="px-3 py-2 text-ink">{r.user_name ?? "—"}</td>
                                <td className="px-3 py-2 text-ink">{r.metric_label}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{fmtTargetPer(r.metric, r.final_target, r.unit, r.kind)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{r.progress.actual ?? "not measured"}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{r.progress.pct_of_mtd == null ? "—" : `${r.progress.pct_of_mtd}%`}</td>
                                <td className="px-3 py-2">
                                    {r.progress.rag ? (
                                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${RAG_TONE[r.progress.rag]}`}>{r.progress.rag}</span>
                                    ) : (
                                        "—"
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {context ? (
                <p className="px-4 pb-3 pt-2 text-[11px] text-ink-muted">
                    {context.working_days_elapsed} of {context.working_days_total} working days gone.
                </p>
            ) : null}
        </div>
    );
}

/** ID 239: one member's targets, as their own card shows them (read-only). */
function MemberTargets({ title, rows, context }: { title: string; rows: TargetRow[]; context: TeamTargets["context"] }) {
    if (rows.length === 0) {
        return (
            <div className="rounded-xl border border-dashed border-border bg-surface px-4 py-3 text-sm text-ink-muted">
                No target is pushed to this team member for this month.
            </div>
        );
    }
    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 py-3">
                <h3 className="text-sm font-semibold text-ink">{title}</h3>
                <p className="text-[11px] text-ink-muted">View only. The member accepts or asks for a correction on their own page.</p>
            </div>
            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Metric</th>
                            <th className="px-3 py-2 text-right font-semibold">Target</th>
                            {progressHeaders(context).map((h) => (
                                <th key={h} className="px-3 py-2 text-right font-semibold">
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.map((r) => (
                            <tr key={r.id}>
                                <td className="px-3 py-2 text-ink">{r.metric_label}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{fmtTargetPer(r.metric, r.final_target, r.unit, r.kind)}</td>
                                <TargetProgressCells metric={r.metric} p={r.progress} unit={r.unit} kind={r.kind} />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
