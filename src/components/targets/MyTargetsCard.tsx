"use client";

// R-17 — a rep's own targets for this month on their performance page: accept
// what has been pushed, and see actual vs target as the month goes.
// Renders nothing when the person has no targets this month.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { PROGRESS_HEADERS, TargetProgressCells, fmtTarget } from "@/components/targets/TargetProgressCells";
import type { TargetRow } from "@/lib/targets/service";

export function MyTargetsCard() {
    const qc = useQueryClient();
    const [busy, setBusy] = useState(false);
    const { data } = useQuery<{ rows: TargetRow[]; context: { working_days_total: number; working_days_elapsed: number } }>({
        queryKey: ["my-targets"],
        queryFn: async () => {
            const res = await fetch("/api/me/targets", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load targets");
            return json.data;
        },
    });

    // Drafts and pending-approval rows are not the person's business yet.
    const rows = (data?.rows ?? []).filter((r) => r.status === "pushed" || r.status === "accepted");
    if (rows.length === 0) return null;
    const toAccept = rows.filter((r) => r.status === "pushed").map((r) => r.id);

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
                    <h3 className="text-sm font-semibold text-ink">My targets this month</h3>
                    <p className="text-[11px] text-ink-muted">
                        {data?.context.working_days_elapsed} of {data?.context.working_days_total} working days
                        gone. MTD target is your monthly target spread over working days.
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
            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Metric</th>
                            <th className="px-3 py-2 text-right font-semibold">Monthly target</th>
                            {PROGRESS_HEADERS.map((h) => (
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
                                <TargetProgressCells metric={r.metric} p={r.progress} />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
