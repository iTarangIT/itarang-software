"use client";

// R-17 — a rep's own targets on their performance page: accept what has been
// sent, or ask for a correction, and see actual vs target as the month goes.
// Next month's targets are shown too once sent — the CEO sets them before the
// month starts, and the rep must be able to answer them then, not only from
// the 1st.
//
// ID 189 (Kartik 14 Oct, confirmed 16 Oct): Accept with an optional remark, or
// "Ask for correction" with a remark that goes to the Sales Head — there is no
// reject, and the target stays in force (the 48-hour clock keeps running)
// until the Sales Head pushes a corrected version. Each target shows its sum
// ("CEO 100 + 50 = 150"), "per day" / "per month", the date it arrived and
// what is needed per day for the working days left. Everyone's month counts
// from the 1st. A custom metric's progress is entered here by hand. Old-flow
// rejected targets still show, waiting for the Sales Head.
// Renders nothing when the person has no sent / accepted / rejected targets.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { TargetProgressCells, fmtTargetPer, fmtTargetSum, progressHeaders } from "@/components/targets/TargetProgressCells";
import { CORRECTION_REMARK_MIN } from "@/lib/targets/rules";
import type { TargetRow } from "@/lib/targets/service";

type Ctx = { working_days_total: number; working_days_elapsed: number };
type MyTargets = {
    rows: TargetRow[];
    context: Ctx;
    next?: { month: string; rows: TargetRow[] };
};

// Drafts and those with the Sales Head are not the person's business yet.
const visible = (rows: TargetRow[] | undefined) =>
    (rows ?? []).filter((r) => r.status === "pushed" || r.status === "accepted" || r.status === "rejected");

function monthLabel(ym: string): string {
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

const fmtDay = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";

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
    const [mode, setMode] = useState<"none" | "accept" | "correction">("none");
    const [remark, setRemark] = useState("");
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
    const all = [...rows, ...nextRows];
    const waiting = all.filter((r) => r.status === "pushed").map((r) => r.id);
    const rejected = all.filter((r) => r.status === "rejected");
    const asked = all.filter((r) => r.correction_open);

    const act = async (fn: () => Promise<unknown>, ok: string) => {
        setBusy(true);
        try {
            await fn();
            toast.success(ok);
            setMode("none");
            setRemark("");
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
    const remarkOk = mode === "accept" || remark.trim().length >= CORRECTION_REMARK_MIN;
    const ctx = data?.context;

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                    <h3 className="text-sm font-semibold text-ink">My targets</h3>
                    <p className="text-[11px] text-ink-muted">
                        {ctx?.working_days_elapsed} of {ctx?.working_days_total} working days of this month gone (the month
                        counts from the 1st). Target to date is your target spread over the working days so far.
                    </p>
                </div>
                {waiting.length > 0 && mode === "none" && (
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => setMode("accept")}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                            Accept {waiting.length} target{waiting.length === 1 ? "" : "s"}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => setMode("correction")}
                            className="rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                        >
                            Ask for correction
                        </button>
                    </div>
                )}
            </div>

            {mode !== "none" && (
                <div
                    className={`mx-4 mb-3 space-y-2 rounded-lg border p-3 ${
                        mode === "accept" ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60"
                    }`}
                >
                    <label htmlFor="target-remark" className="block text-xs font-semibold text-ink">
                        {mode === "accept"
                            ? "Remark (optional) — the Sales Head and CEO will see it"
                            : "What needs correcting? (required — the Sales Head will see this). Your targets stay as they are until the Sales Head sends a corrected version."}
                    </label>
                    <textarea
                        id="target-remark"
                        value={remark}
                        onChange={(e) => setRemark(e.target.value)}
                        rows={3}
                        maxLength={1000}
                        placeholder={
                            mode === "accept"
                                ? "e.g. Fine, I will need two demo batteries in the first week"
                                : "e.g. 40 calls a day is not possible with the field visits I also have this month"
                        }
                        className="w-full rounded-lg border border-border bg-white px-2 py-1.5 text-sm"
                    />
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            disabled={busy || !remarkOk}
                            onClick={() =>
                                mode === "accept"
                                    ? act(() => postMine({ action: "accept", ids: waiting, remark: remark.trim() || null }), "Targets accepted")
                                    : act(() => postMine({ action: "correction", ids: waiting, remark }), "Sent — the Sales Head has been told")
                            }
                            className={`rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 ${
                                mode === "accept" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"
                            }`}
                        >
                            {mode === "accept" ? `Accept ${waiting.length}` : "Ask for correction"}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                setMode("none");
                                setRemark("");
                            }}
                            className="text-sm text-ink-muted hover:underline"
                        >
                            Cancel
                        </button>
                        {!remarkOk && <span className="text-[11px] text-amber-800">At least {CORRECTION_REMARK_MIN} characters.</span>}
                    </div>
                </div>
            )}

            {asked.length > 0 && (
                <p className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    You asked for a correction on {asked.length} target{asked.length === 1 ? "" : "s"}
                    {asked[0].correction_requested_at ? ` on ${fmtDay(asked[0].correction_requested_at)}` : ""}: “
                    {asked[0].correction_remark ?? ""}”. Waiting for the Sales Head; the targets below stay in force until then.
                </p>
            )}
            {rejected.length > 0 && (
                <p className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    You rejected {rejected.length} target{rejected.length === 1 ? "" : "s"}: “{rejected[0].reject_comment ?? ""}”. Waiting for the
                    Sales Head to change and send them again.
                </p>
            )}

            {rows.length > 0 && <TargetsTable title="This month" rows={rows} ctx={ctx} progress onSaveActual={saveActual} />}
            {nextRows.length > 0 && data?.next && (
                <TargetsTable title={`Next month — ${monthLabel(data.next.month)}`} rows={nextRows} ctx={null} progress={false} />
            )}
        </div>
    );
}

function TargetsTable({
    title,
    rows,
    ctx,
    progress,
    onSaveActual,
}: {
    title: string;
    rows: TargetRow[];
    ctx: Ctx | null | undefined;
    progress: boolean;
    onSaveActual?: (r: TargetRow, raw: string) => void;
}) {
    return (
        <div className="overflow-x-auto border-t border-border">
            <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{title}</p>
            <table className="w-full min-w-[920px] text-sm">
                <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                    <tr>
                        <th className="px-3 py-2 text-left font-semibold">Metric</th>
                        <th className="px-3 py-2 text-right font-semibold">Target</th>
                        {progress &&
                            progressHeaders(ctx).map((h) => (
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
                                {r.pushed_at && (
                                    <span className="block text-[10px] text-ink-muted">Target arrived on {fmtDay(r.pushed_at)}</span>
                                )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                                <span className="font-semibold">{fmtTargetPer(r.metric, r.final_target, r.unit, r.kind)}</span>
                                <span className="block text-[10px] text-ink-muted">{fmtTargetSum(r.metric, r.ceo_target, r.stretch, r.unit)}</span>
                                {r.stretch_note && <span className="block text-[10px] italic text-ink-muted">“{r.stretch_note}”</span>}
                            </td>
                            {progress && (
                                <TargetProgressCells
                                    metric={r.metric}
                                    p={r.progress}
                                    unit={r.unit}
                                    kind={r.kind}
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
