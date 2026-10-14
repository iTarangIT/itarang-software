"use client";

// R-17 — the target register (sheet 8 §A) and actual vs target (§B) on one
// screen. Cells the caller may edit are inputs; saving is per cell on blur.
//
// Item 3 (14 Oct 2026): the CEO creates a person's targets and sends them to
// the Sales Head; the Sales Head reviews, edits, adds or removes metrics
// (built-in or custom) and sends them to the member, who accepts or rejects
// with a comment. A reject shows here with the comment, ready to edit and send
// again. The rules live in src/lib/targets/service.ts.
//
// Numbers (E-342): the CEO target, and the Sales Head target — empty means the
// CEO's number goes to the member; any number the Sales Head enters (higher or
// lower) goes instead. Monthly target = what the member gets.

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PROGRESS_HEADERS, TargetProgressCells, fmtTarget } from "@/components/targets/TargetProgressCells";
import { TARGET_METRIC_KEYS, TARGET_METRICS, TARGET_STATUS_LABEL, metricsForRole, type TargetStatus } from "@/lib/targets/rules";
import type { TargetRow } from "@/lib/targets/service";

type Data = {
    month: string;
    rows: TargetRow[];
    context: { working_days_total: number; working_days_elapsed: number };
    people: Array<{ user_id: string; name: string | null; role: string | null }>;
    can: {
        add_person: boolean;
        set_ceo_target: boolean;
        set_sales_head_target?: boolean;
        set_addon: boolean;
        approve: boolean;
        edit_metrics?: boolean;
        send_for_review?: boolean;
        send_to_member?: boolean;
    };
};

const STATUS_TONE: Partial<Record<TargetStatus, string>> = {
    pending_approval: "text-sky-700",
    rejected: "font-semibold text-rose-700",
    accepted: "text-emerald-700",
};

const CUSTOM = "__custom__";

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

const fmtWhen = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

export function TargetsView() {
    const qc = useQueryClient();
    const sp = useSearchParams();
    const [month, setMonth] = useState(() => {
        const m = sp.get("month") ?? "";
        return /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7);
    });
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

    const saveCell = (row: TargetRow, field: "ceo_target" | "sales_head_target", raw: string) => {
        if (field === "sales_head_target") {
            // Empty or 0 = "use the CEO's target" (stored as nothing).
            const v = raw.trim() === "" ? null : Number(raw);
            if ((v || null) === (row.sales_head_target || null)) return;
            run(() => post({ action: "update", id: row.id, sales_head_target: v }), v ? "Sales Head target saved" : "Cleared — the CEO target goes");
            return;
        }
        const n = Number(raw);
        if (raw.trim() === "" || n === row[field]) return;
        run(() => post({ action: "update", id: row.id, [field]: n }), "Saved");
    };

    const can = data?.can;
    const all = data?.rows ?? [];
    const forReview = all.filter((r) => r.status === "draft" || r.status === "rejected").map((r) => r.id);
    const forMember = all.filter((r) => r.status === "pending_approval" || r.status === "rejected").map((r) => r.id);
    const alreadyIn = new Set(all.map((r) => r.user_id));

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
                <div className="ml-auto flex flex-wrap gap-2">
                    {can?.send_for_review && forReview.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "send_for_review", ids: forReview }), "Sent to the Sales Head")}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium"
                        >
                            <Send className="h-3.5 w-3.5" /> Send all {forReview.length} to Sales Head
                        </button>
                    )}
                    {can?.send_to_member && forMember.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "send_to_member", ids: forMember }), "Sent to the members")}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white"
                        >
                            <Send className="h-3.5 w-3.5" /> Send all {forMember.length} reviewed to members
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
                <PersonCard key={rows[0].user_id} rows={rows} month={month} can={can} busy={busy} run={run} saveCell={saveCell} />
            ))}
        </div>
    );
}

function PersonCard({
    rows,
    month,
    can,
    busy,
    run,
    saveCell,
}: {
    rows: TargetRow[];
    month: string;
    can: Data["can"] | undefined;
    busy: boolean;
    run: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
    saveCell: (row: TargetRow, field: "ceo_target" | "sales_head_target", raw: string) => void;
}) {
    const first = rows[0];
    const name = first.user_name ?? first.user_id;
    const rejected = rows.filter((r) => r.status === "rejected");
    const toReview = rows.filter((r) => r.status === "draft" || r.status === "rejected").map((r) => r.id);
    const toMember = rows.filter((r) => r.status === "pending_approval" || r.status === "rejected" || r.status === "draft").map((r) => r.id);

    // Add a metric: the role's own first, then every other built-in, then custom.
    const [pick, setPick] = useState("");
    const [label, setLabel] = useState("");
    const [unit, setUnit] = useState("");
    const [target, setTarget] = useState("");
    const present = new Set(rows.map((r) => r.metric));
    const own = metricsForRole(first.user_role).filter((m) => !present.has(m));
    const other = TARGET_METRIC_KEYS.filter((m) => !present.has(m) && !own.includes(m));

    const addMetric = () =>
        run(async () => {
            await post({
                action: "add_metric",
                month,
                user_id: first.user_id,
                ...(pick === CUSTOM ? { custom: { label, unit: unit || null } } : { metric: pick }),
                target: target.trim() === "" ? 0 : Number(target),
            });
            setPick("");
            setLabel("");
            setUnit("");
            setTarget("");
        }, "Metric added as a draft");

    const saveActual = (r: TargetRow, raw: string) => {
        const v = raw.trim() === "" ? null : Number(raw);
        if (v === r.progress.actual) return;
        run(() => post({ action: "set_actual", id: r.id, value: v }), "Progress saved");
    };

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">
                    {name}
                    <span className="ml-2 text-[11px] font-normal text-ink-muted">{(first.user_role ?? "").replace(/_/g, " ")}</span>
                </h2>
                <div className="ml-auto flex flex-wrap gap-2">
                    {can?.send_for_review && toReview.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "send_for_review", ids: toReview }), `Sent ${name}'s targets to the Sales Head`)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium"
                        >
                            <Send className="h-3 w-3" /> Send to Sales Head
                        </button>
                    )}
                    {can?.send_to_member && toMember.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "send_to_member", ids: toMember }), `Sent to ${name}`)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-2.5 py-1 text-xs font-medium text-white"
                        >
                            <Send className="h-3 w-3" /> Send {toMember.length} to {name}
                        </button>
                    )}
                </div>
            </div>

            {rejected.length > 0 && (
                <div className="mx-4 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                    <span className="font-semibold">
                        {name} rejected {rejected.length} target{rejected.length === 1 ? "" : "s"}
                        {rejected[0].rejected_at ? ` on ${fmtWhen(rejected[0].rejected_at)}` : ""}:
                    </span>{" "}
                    “{rejected[0].reject_comment ?? "no comment"}”
                    <span className="block text-rose-700/80">Change the numbers or metrics below, then send again.</span>
                </div>
            )}

            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[1150px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Metric</th>
                            <th className="px-3 py-2 text-right font-semibold">CEO target</th>
                            <th className="px-3 py-2 text-right font-semibold" title="Empty = the CEO target goes to the person">
                                Sales Head target
                            </th>
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
                                <td className="px-3 py-2 text-ink">
                                    <span className="inline-flex items-center gap-2">
                                        {r.metric_label}
                                        {r.is_custom && (
                                            <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">custom</span>
                                        )}
                                        {can?.edit_metrics && (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                title="Remove this metric"
                                                onClick={() => {
                                                    if (confirm(`Remove "${r.metric_label}" from ${name}'s targets?`)) {
                                                        run(() => post({ action: "remove", id: r.id }), "Metric removed");
                                                    }
                                                }}
                                                className="text-ink-muted hover:text-rose-600"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                    </span>
                                </td>
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
                                        <span className="tabular-nums">{fmtTarget(r.metric, r.ceo_target, r.unit)}</span>
                                    )}
                                </td>
                                <td className="px-3 py-2 text-right">
                                    {can?.set_sales_head_target ? (
                                        <input
                                            key={`${r.id}:sh:${r.sales_head_target}`}
                                            type="number"
                                            min={0}
                                            defaultValue={r.sales_head_target || ""}
                                            placeholder="uses CEO"
                                            onBlur={(e) => saveCell(r, "sales_head_target", e.target.value)}
                                            className="w-24 rounded border border-border px-2 py-1 text-right tabular-nums placeholder:text-[11px]"
                                            title="Leave empty (or 0) to send the CEO's target. Any number here — higher or lower — is what goes to the person."
                                        />
                                    ) : r.sales_head_target ? (
                                        <span className="tabular-nums">{fmtTarget(r.metric, r.sales_head_target, r.unit)}</span>
                                    ) : (
                                        <span className="text-[11px] text-ink-muted">uses CEO</span>
                                    )}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    <span className="font-semibold">{fmtTarget(r.metric, r.final_target, r.unit)}</span>
                                    <span className="block text-[10px] font-normal text-ink-muted">
                                        {r.sales_head_target ? "Sales Head's" : "CEO's"}
                                        {r.admin_addon ? ` + ${fmtTarget(r.metric, r.admin_addon, r.unit)} add-on` : ""}
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-[12px]">
                                    <span
                                        className={
                                            r.status === "pushed" && (r.hours_since_push_unaccepted ?? 0) >= 48
                                                ? "font-semibold text-rose-700"
                                                : (STATUS_TONE[r.status] ?? "text-ink-muted")
                                        }
                                    >
                                        {TARGET_STATUS_LABEL[r.status] ?? r.status}
                                        {r.status === "pushed" && r.hours_since_push_unaccepted != null && ` (${r.hours_since_push_unaccepted}h)`}
                                    </span>
                                </td>
                                <TargetProgressCells
                                    metric={r.metric}
                                    p={r.progress}
                                    unit={r.unit}
                                    actualSlot={
                                        r.is_custom && can?.edit_metrics ? (
                                            <input
                                                key={`${r.id}:a:${r.progress.actual}`}
                                                type="number"
                                                min={0}
                                                defaultValue={r.progress.actual ?? ""}
                                                placeholder="enter"
                                                title="A custom metric's progress is entered by hand"
                                                onBlur={(e) => saveActual(r, e.target.value)}
                                                className="w-20 rounded border border-border px-2 py-1 text-right tabular-nums"
                                            />
                                        ) : undefined
                                    }
                                />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {can?.edit_metrics && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-sm">
                    <select
                        value={pick}
                        onChange={(e) => setPick(e.target.value)}
                        aria-label="Metric to add"
                        className="rounded-lg border border-border bg-surface px-2 py-1"
                    >
                        <option value="">Add a metric…</option>
                        {own.length > 0 && (
                            <optgroup label={`${(first.user_role ?? "").replace(/_/g, " ")} metrics`}>
                                {own.map((m) => (
                                    <option key={m} value={m}>
                                        {TARGET_METRICS[m].label}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                        {other.length > 0 && (
                            <optgroup label="Other metrics">
                                {other.map((m) => (
                                    <option key={m} value={m}>
                                        {TARGET_METRICS[m].label}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                        <option value={CUSTOM}>Custom metric…</option>
                    </select>
                    {pick === CUSTOM && (
                        <>
                            <input
                                value={label}
                                onChange={(e) => setLabel(e.target.value)}
                                placeholder="Metric name, e.g. Demo rides"
                                maxLength={80}
                                className="w-56 rounded-lg border border-border px-2 py-1"
                            />
                            <input
                                value={unit}
                                onChange={(e) => setUnit(e.target.value)}
                                placeholder="Unit (optional, ₹ for money)"
                                maxLength={20}
                                className="w-44 rounded-lg border border-border px-2 py-1"
                            />
                        </>
                    )}
                    {pick && (
                        <input
                            type="number"
                            min={0}
                            value={target}
                            onChange={(e) => setTarget(e.target.value)}
                            placeholder="Target"
                            className="w-24 rounded-lg border border-border px-2 py-1 text-right"
                        />
                    )}
                    <button
                        type="button"
                        disabled={!pick || busy || (pick === CUSTOM && label.trim().length < 2)}
                        onClick={addMetric}
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1 font-medium disabled:opacity-50"
                    >
                        <Plus className="h-3.5 w-3.5" /> Add
                    </button>
                    {pick === CUSTOM && (
                        <span className="text-[11px] text-ink-muted">A custom metric is not measured by the CRM — its progress is entered by hand.</span>
                    )}
                </div>
            )}
        </div>
    );
}
