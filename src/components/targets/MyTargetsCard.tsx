"use client";

// R-17 — a rep's own targets on their performance page: accept what has been
// pushed, and see actual vs target as the month goes. Next month's targets are
// shown too once pushed — the CEO sets them before the month starts, and the
// rep must be able to accept them then, not only from the 1st.
// Renders nothing when the person has no pushed / accepted targets for either.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { PROGRESS_HEADERS, TargetProgressCells, fmtTarget } from "@/components/targets/TargetProgressCells";
import type { TargetRow } from "@/lib/targets/service";

type MyTargets = {
    rows: TargetRow[];
    context: { working_days_total: number; working_days_elapsed: number };
    next?: { month: string; rows: TargetRow[] };
};

// Drafts and pending-approval rows are not the person's business yet.
const visible = (rows: TargetRow[] | undefined) =>
    (rows ?? []).filter((r) => r.status === "pushed" || r.status === "accepted");

function monthLabel(ym: string): string {
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function MyTargetsCard() {
    const qc = useQueryClient();
    const [busy, setBusy] = useState(false);
    const { data } = useQuery<MyTargets>({
        queryKey: ["my-targets"],
        queryFn: async () => {
            const res = await fetch("/api/me/targets", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load targets");
            return json.data;
        },
    });

    const rows = visible(data?.rows);
    const nextRows = visible(data?.next?.rows);
    if (rows.length === 0 && nextRows.length === 0) return null;
    const toAccept = [...rows, ...nextRows].filter((r) => r.status === "pushed").map((r) => r.id);

    const accept = async () => {
        setBusy(true);
        try {
            const res = await fetch("/api/me/targets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: toAccept }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not accept");
            toast.success("Targets accepted");
            qc.invalidateQueries({ queryKey: ["my-targets"] });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                    <h3 className="text-sm font-semibold text-ink">My targets</h3>
                    <p className="text-[11px] text-ink-muted">
                        {data?.context.working_days_elapsed} of {data?.context.working_days_total} working days of
                        this month gone. MTD target is your monthly target spread over working days.
                    </p>
                </div>
                {toAccept.length > 0 && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={accept}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                        Accept {toAccept.length} new target{toAccept.length === 1 ? "" : "s"}
                    </button>
                )}
            </div>
            {rows.length > 0 && <TargetsTable title="This month" rows={rows} progress />}
            {nextRows.length > 0 && data?.next && (
                <TargetsTable title={`Next month — ${monthLabel(data.next.month)}`} rows={nextRows} progress={false} />
            )}
        </div>
    );
}

function TargetsTable({ title, rows, progress }: { title: string; rows: TargetRow[]; progress: boolean }) {
    return (
        <div className="overflow-x-auto border-t border-border">
            <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{title}</p>
            <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                    <tr>
                        <th className="px-3 py-2 text-left font-semibold">Metric</th>
                        <th className="px-3 py-2 text-right font-semibold">Monthly target</th>
                        {progress &&
                            PROGRESS_HEADERS.map((h) => (
                                <th key={h} className="px-3 py-2 text-right font-semibold">{h}</th>
                            ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {rows.map((r) => (
                        <tr key={r.id}>
                            <td className="px-3 py-2 text-ink">
                                {r.metric_label}
                                {r.status === "pushed" && (
                                    <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                                        new
                                    </span>
                                )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtTarget(r.metric, r.final_target)}</td>
                            {progress && <TargetProgressCells metric={r.metric} p={r.progress} />}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
