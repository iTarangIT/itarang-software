"use client";

// R-17 — the target register (sheet 8 §A) and actual vs target (§B) on one
// screen. Cells the caller may edit are inputs; saving is per cell on blur.

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { PROGRESS_HEADERS, TargetProgressCells, fmtTarget } from "@/components/targets/TargetProgressCells";
import type { TargetRow } from "@/lib/targets/service";

type Data = {
    month: string;
    rows: TargetRow[];
    context: { working_days_total: number; working_days_elapsed: number };
    people: Array<{ user_id: string; name: string | null; role: string | null }>;
    can: { add_person: boolean; set_ceo_target: boolean; set_addon: boolean; approve: boolean };
};

const STATUS_LABEL: Record<string, string> = {
    draft: "Draft",
    pending_approval: "Pending approval",
    pushed: "Pushed — awaiting acceptance",
    accepted: "Accepted",
};

async function post(body: unknown) {
    const res = await fetch("/api/admin/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message ?? "Action failed");
    return json.data;
}

export function TargetsView() {
    const qc = useQueryClient();
    const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
    const [person, setPerson] = useState("");
    const [busy, setBusy] = useState(false);

    const { data, isLoading, error } = useQuery<Data>({
        queryKey: ["targets", month],
        queryFn: async () => {
            const res = await fetch(`/api/admin/targets?month=${month}`, { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load targets");
            return json.data;
        },
        placeholderData: (prev) => prev,
    });
    const refresh = () => qc.invalidateQueries({ queryKey: ["targets", month] });

    const byPerson = useMemo(() => {
        const m = new Map<string, TargetRow[]>();
        for (const r of data?.rows ?? []) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r]);
        return [...m.values()];
    }, [data]);

    const run = async (fn: () => Promise<unknown>, ok: string) => {
        setBusy(true);
        try {
            await fn();
            toast.success(ok);
            refresh();
        } catch (e) {
            toast.error((e as Error).message);
            refresh(); // puts a refused edit back to the saved number
        } finally {
            setBusy(false);
        }
    };

    const saveCell = (row: TargetRow, field: "ceo_target" | "admin_addon", raw: string) => {
        const n = Number(raw);
        if (raw.trim() === "" || n === row[field]) return;
        run(() => post({ action: "update", id: row.id, [field]: n }), "Saved");
    };

    const drafts = (data?.rows ?? []).filter((r) => r.status === "draft").map((r) => r.id);
    const pending = (data?.rows ?? []).filter((r) => r.status === "pending_approval").map((r) => r.id);
    const can = data?.can;
    const alreadyIn = new Set((data?.rows ?? []).map((r) => r.user_id));

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-ink-muted">
                    Month
                    <input
                        type="month"
                        value={month}
                        onChange={(e) => e.target.value && setMonth(e.target.value)}
                        className="mt-1 block rounded-lg border border-border bg-surface px-2 py-1 text-sm text-ink"
                    />
                </label>
                {data && (
                    <p className="pb-1 text-xs text-ink-muted">
                        {data.context.working_days_elapsed} of {data.context.working_days_total} working days
                        elapsed
                    </p>
                )}
                {can?.add_person && (
                    <div className="flex items-end gap-2">
                        <select
                            value={person}
                            onChange={(e) => setPerson(e.target.value)}
                            className="rounded-lg border border-border bg-surface px-2 py-1 text-sm"
                        >
                            <option value="">Add a person…</option>
                            {(data?.people ?? [])
                                .filter((p) => !alreadyIn.has(p.user_id))
                                .map((p) => (
                                    <option key={p.user_id} value={p.user_id}>
                                        {p.name ?? p.user_id} · {(p.role ?? "").replace(/_/g, " ")}
                                    </option>
                                ))}
                        </select>
                        <button
                            type="button"
                            disabled={!person || busy}
                            onClick={() =>
                                run(async () => {
                                    await post({ action: "add_person", month, user_id: person });
                                    setPerson("");
                                }, "Targets added as drafts")
                            }
                            className="rounded-lg border border-border px-3 py-1 text-sm font-medium disabled:opacity-50"
                        >
                            Add
                        </button>
                    </div>
                )}
                <div className="ml-auto flex gap-2">
                    {can?.add_person && drafts.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "submit", ids: drafts }), "Submitted for approval")}
                            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium"
                        >
                            Submit {drafts.length} draft{drafts.length === 1 ? "" : "s"} for approval
                        </button>
                    )}
                    {can?.approve && pending.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "approve_push", ids: pending }), "Approved and pushed")}
                            className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white"
                        >
                            Approve &amp; push {pending.length}
                        </button>
                    )}
                </div>
            </div>

            {isLoading && !data && (
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            )}
            {error && <p className="text-sm text-rose-600">{(error as Error).message}</p>}
            {data && byPerson.length === 0 && (
                <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-ink-muted">
                    No targets for this month yet.{can?.add_person ? " Add a person to start." : ""}
                </p>
            )}

            {byPerson.map((rows) => (
                <div key={rows[0].user_id} className="rounded-xl border border-border bg-surface shadow-card">
                    <div className="px-4 py-3">
                        <h2 className="text-sm font-semibold text-ink">
                            {rows[0].user_name ?? rows[0].user_id}
                            <span className="ml-2 text-[11px] font-normal text-ink-muted">
                                {(rows[0].user_role ?? "").replace(/_/g, " ")}
                            </span>
                        </h2>
                    </div>
                    <div className="overflow-x-auto border-t border-border">
                        <table className="w-full min-w-[1150px] text-sm">
                            <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                                <tr>
                                    <th className="px-3 py-2 text-left font-semibold">Metric</th>
                                    <th className="px-3 py-2 text-right font-semibold">CEO target</th>
                                    <th className="px-3 py-2 text-right font-semibold">Admin add-on</th>
                                    <th className="px-3 py-2 text-right font-semibold">Monthly target</th>
                                    <th className="px-3 py-2 text-left font-semibold">Status</th>
                                    {PROGRESS_HEADERS.map((h) => (
                                        <th key={h} className="px-3 py-2 text-right font-semibold">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {rows.map((r) => (
                                    <tr key={r.id}>
                                        <td className="px-3 py-2 text-ink">{r.metric_label}</td>
                                        <td className="px-3 py-2 text-right">
                                            {can?.set_ceo_target ? (
                                                <input
                                                    key={`${r.id}:${r.ceo_target}`}
                                                    type="number"
                                                    min={0}
                                                    defaultValue={r.ceo_target}
                                                    onBlur={(e) => saveCell(r, "ceo_target", e.target.value)}
                                                    className="w-24 rounded border border-border px-2 py-1 text-right tabular-nums"
                                                />
                                            ) : (
                                                <span className="tabular-nums">{fmtTarget(r.metric, r.ceo_target)}</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            {can?.set_addon ? (
                                                <input
                                                    key={`${r.id}:${r.admin_addon}`}
                                                    type="number"
                                                    min={0}
                                                    defaultValue={r.admin_addon}
                                                    onBlur={(e) => saveCell(r, "admin_addon", e.target.value)}
                                                    className="w-24 rounded border border-border px-2 py-1 text-right tabular-nums"
                                                    title="Admin can add to the CEO's target, never reduce it"
                                                />
                                            ) : (
                                                <span className="tabular-nums">{fmtTarget(r.metric, r.admin_addon)}</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-right font-semibold tabular-nums">
                                            {fmtTarget(r.metric, r.final_target)}
                                        </td>
                                        <td className="px-3 py-2 text-[12px]">
                                            <span className={r.status === "pushed" && (r.hours_since_push_unaccepted ?? 0) >= 48 ? "font-semibold text-rose-700" : "text-ink-muted"}>
                                                {STATUS_LABEL[r.status] ?? r.status}
                                                {r.status === "pushed" && r.hours_since_push_unaccepted != null &&
                                                    ` (${r.hours_since_push_unaccepted}h)`}
                                            </span>
                                        </td>
                                        <TargetProgressCells metric={r.metric} p={r.progress} />
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ))}
        </div>
    );
}
