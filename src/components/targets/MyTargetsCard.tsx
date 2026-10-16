"use client";

// R-17 — a rep's own targets on their performance page: accept or reject what
// has been sent, and see actual vs target as the month goes. Next month's
// targets are shown too once sent — the CEO sets them before the month starts,
// and the rep must be able to answer them then, not only from the 1st.
//
// Item 3 (14 Oct 2026): Accept, or Reject with a required comment — the reject
// goes back to the Sales Head and CEO, and the targets show as "rejected,
// waiting for the Sales Head" until they are sent again. A custom metric's
// progress is entered here by hand.
// Renders nothing when the person has no sent / accepted / rejected targets.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { PROGRESS_HEADERS, TargetProgressCells, fmtTarget } from "@/components/targets/TargetProgressCells";
import { REJECT_COMMENT_MIN } from "@/lib/targets/rules";
import type { TargetRow } from "@/lib/targets/service";

type MyTargets = {
    rows: TargetRow[];
    context: { working_days_total: number; working_days_elapsed: number; actuals_up_to?: string | null };
    next?: { month: string; rows: TargetRow[] };
};

// Drafts and those with the Sales Head for review are not the person's business yet.
const visible = (rows: TargetRow[] | undefined) =>
    (rows ?? []).filter((r) => r.status === "pushed" || r.status === "accepted" || r.status === "rejected");

function monthLabel(ym: string): string {
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

async function postMine(body: unknown) {
    const res = await fetch("/api/me/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message ?? "Action failed");
    return json.data;
}

export function MyTargetsCard() {
    const qc = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [rejecting, setRejecting] = useState(false);
    const [comment, setComment] = useState("");
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
    const waiting = [...rows, ...nextRows].filter((r) => r.status === "pushed").map((r) => r.id);
    const rejected = [...rows, ...nextRows].filter((r) => r.status === "rejected");

    const act = async (fn: () => Promise<unknown>, ok: string) => {
        setBusy(true);
        try {
            await fn();
            toast.success(ok);
            setRejecting(false);
            setComment("");
            qc.invalidateQueries({ queryKey: ["my-targets"] });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const saveActual = (r: TargetRow, raw: string) => {
        const v = raw.trim() === "" ? null : Number(raw);
        if (v === r.progress.actual) return;
        act(() => postMine({ action: "set_actual", id: r.id, value: v }), "Progress saved");
    };
    const commentOk = comment.trim().length >= REJECT_COMMENT_MIN;

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                    <h3 className="text-sm font-semibold text-ink">My targets</h3>
                    <p className="text-[11px] text-ink-muted">
                        {data?.context.working_days_elapsed} of {data?.context.working_days_total} working days of
                        this month gone. MTD target is your monthly target spread over working days.
                        {data?.context.actuals_up_to ? ` Actuals up to ${data.context.actuals_up_to}.` : ""}
                    </p>
                </div>
                {waiting.length > 0 && !rejecting && (
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(() => postMine({ action: "accept", ids: waiting }), "Targets accepted")}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                            Accept {waiting.length} target{waiting.length === 1 ? "" : "s"}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => setRejecting(true)}
                            className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                        >
                            Reject
                        </button>
                    </div>
                )}
            </div>

            {rejecting && (
                <div className="mx-4 mb-3 space-y-2 rounded-lg border border-rose-200 bg-rose-50/60 p-3">
                    <label htmlFor="target-reject-comment" className="block text-xs font-semibold text-rose-800">
                        Why are you rejecting these targets? (required — the Sales Head and CEO will see this)
                    </label>
                    <textarea
                        id="target-reject-comment"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={3}
                        maxLength={1000}
                        placeholder="e.g. 40 calls a day is not possible with the field visits I also have this month"
                        className="w-full rounded-lg border border-rose-200 bg-white px-2 py-1.5 text-sm"
                    />
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            disabled={busy || !commentOk}
                            onClick={() => act(() => postMine({ action: "reject", ids: waiting, comment }), "Rejected — the Sales Head has been told")}
                            className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                        >
                            Reject {waiting.length} target{waiting.length === 1 ? "" : "s"}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                setRejecting(false);
                                setComment("");
                            }}
                            className="text-sm text-ink-muted hover:underline"
                        >
                            Cancel
                        </button>
                        {!commentOk && <span className="text-[11px] text-rose-700">At least {REJECT_COMMENT_MIN} characters.</span>}
                    </div>
                </div>
            )}

            {rejected.length > 0 && (
                <p className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    You rejected {rejected.length} target{rejected.length === 1 ? "" : "s"}: “{rejected[0].reject_comment ?? ""}”. Waiting for the
                    Sales Head to change and send them again.
                </p>
            )}

            {rows.length > 0 && <TargetsTable title="This month" rows={rows} progress onSaveActual={saveActual} />}
            {nextRows.length > 0 && data?.next && (
                <TargetsTable title={`Next month — ${monthLabel(data.next.month)}`} rows={nextRows} progress={false} />
            )}
        </div>
    );
}

function TargetsTable({
    title,
    rows,
    progress,
    onSaveActual,
}: {
    title: string;
    rows: TargetRow[];
    progress: boolean;
    onSaveActual?: (r: TargetRow, raw: string) => void;
}) {
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
                                {r.status === "rejected" && (
                                    <span className="ml-2 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
                                        rejected
                                    </span>
                                )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtTarget(r.metric, r.final_target, r.unit)}</td>
                            {progress && (
                                <TargetProgressCells
                                    metric={r.metric}
                                    p={r.progress}
                                    unit={r.unit}
                                    actualSlot={
                                        r.is_custom && onSaveActual ? (
                                            <input
                                                key={`${r.id}:${r.progress.actual}`}
                                                type="number"
                                                min={0}
                                                defaultValue={r.progress.actual ?? ""}
                                                placeholder="enter"
                                                title="Enter your progress on this target"
                                                onBlur={(e) => onSaveActual(r, e.target.value)}
                                                className="w-20 rounded border border-border px-2 py-1 text-right tabular-nums"
                                            />
                                        ) : undefined
                                    }
                                />
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
