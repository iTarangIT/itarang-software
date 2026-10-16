"use client";

// R-17 — the target register (sheet 8 §A) and actual vs target (§B) on one
// screen. Cells the caller may edit are inputs; saving is per cell on blur.
//
// ID 189 (Kartik 14 Oct, confirmed 16 Oct):
//   CEO        enters the CEO target per person (drafts nobody else sees) and
//              presses "Post to Sales Head" — the only way targets move on;
//              adds people and metrics and removes targets (16 Oct gap fix)
//   Sales Head / Admin   see posted targets only, add an add-only STRETCH per
//              target with an optional note (final = CEO + stretch, no CEO
//              re-confirmation) and press "Approve & push"
//   member     accepts (optional remark) or asks for a correction (remark),
//              shown here for the Sales Head to act on; there is no reject
// A CEO change after Post is a draft revision and a stretch change on a target
// the member has waits for the next push: the version in force stays until
// then, and "History" lists every version. The rules live in
// src/lib/targets/service.ts.

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { TargetProgressCells, fmtTarget, fmtTargetPer, fmtTargetSum, progressHeaders } from "@/components/targets/TargetProgressCells";
import {
    SALES_HEAD_METRIC_FOR_ROLES,
    TARGET_METRIC_KEYS,
    TARGET_METRICS,
    TARGET_STATUS_LABEL,
    metricsForRole,
    type TargetStatus,
} from "@/lib/targets/rules";
import type { TargetRow, TargetVersionRow } from "@/lib/targets/service";

type Data = {
    month: string;
    rows: TargetRow[];
    context: { working_days_total: number; working_days_elapsed: number };
    people: Array<{ user_id: string; name: string | null; role: string | null }>;
    can: {
        add_person: boolean;
        set_ceo_target: boolean;
        set_stretch?: boolean;
        approve: boolean;
        /** ID 189 — add a metric: the CEO only. */
        edit_metrics?: boolean;
        /** Remove any target (CEO). */
        remove_any?: boolean;
        /** Remove a target that is not the CEO's (Sales Head / Admin). */
        remove_own?: boolean;
        /** Type in a custom metric's progress. */
        enter_progress?: boolean;
        post?: boolean;
        send_to_member?: boolean;
    };
};

const STATUS_TONE: Partial<Record<TargetStatus, string>> = {
    pending_approval: "text-sky-700",
    rejected: "font-semibold text-rose-700",
    accepted: "text-emerald-700",
};

const CUSTOM = "__custom__";

const EVENT_LABEL: Record<string, string> = {
    baseline: "Version in force at the change-over",
    ceo_draft: "CEO draft (not posted)",
    posted: "Posted by the CEO",
    stretch: "Stretch changed",
    pushed: "Pushed to the member",
    accepted: "Accepted",
    correction_requested: "Correction asked",
    removed: "Removed",
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

const fmtWhen = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

/** What the CEO's Post would move: never-posted drafts and draft revisions. */
const toPost = (rows: TargetRow[]) => rows.filter((r) => r.status === "draft" || r.draft_ceo_target != null).map((r) => r.id);
/** What the Sales Head's push would send: posted and waiting. */
const toPush = (rows: TargetRow[]) => rows.filter((r) => r.waiting_push).map((r) => r.id);

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
    const refresh = () => {
        qc.invalidateQueries({ queryKey: ["targets", month] });
        qc.invalidateQueries({ queryKey: ["targets-history"] });
    };

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

    const can = data?.can;
    const all = data?.rows ?? [];
    const postIds = toPost(all);
    const pushIds = toPush(all);
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
                        {data.context.working_days_elapsed} of {data.context.working_days_total} working days elapsed
                        (everyone&apos;s month counts from the 1st)
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
                    {can?.post && postIds.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "post", ids: postIds }), "Posted to the Sales Head")}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white"
                        >
                            <Send className="h-3.5 w-3.5" /> Post {postIds.length} to Sales Head
                        </button>
                    )}
                    {can?.send_to_member && pushIds.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "send_to_member", ids: pushIds }), "Pushed to the team")}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white"
                        >
                            <Send className="h-3.5 w-3.5" /> Approve &amp; push {pushIds.length} to the team
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
                    {can?.add_person
                        ? "No targets for this month yet. Add a person to start."
                        : "No targets have been posted by the CEO for this month yet."}
                </p>
            )}

            {byPerson.map((rows) => (
                <PersonCard
                    key={rows[0].user_id}
                    rows={rows}
                    month={month}
                    can={can}
                    ctx={data?.context}
                    busy={busy}
                    run={run}
                />
            ))}
        </div>
    );
}

function PersonCard({
    rows,
    month,
    can,
    ctx,
    busy,
    run,
}: {
    rows: TargetRow[];
    month: string;
    can: Data["can"] | undefined;
    ctx: Data["context"] | undefined;
    busy: boolean;
    run: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
    const first = rows[0];
    const name = first.user_name ?? first.user_id;
    const rejected = rows.filter((r) => r.status === "rejected");
    const corrections = rows.filter((r) => r.correction_open);
    const postIds = toPost(rows);
    const pushIds = toPush(rows);
    const [showHistory, setShowHistory] = useState(false);

    // Add a metric: the role's own first, then every other built-in, then custom.
    const [pick, setPick] = useState("");
    const [label, setLabel] = useState("");
    const [unit, setUnit] = useState("");
    const [target, setTarget] = useState("");
    const present = new Set(rows.map((r) => r.metric));
    const own = metricsForRole(first.user_role).filter((m) => !present.has(m));
    const other = TARGET_METRIC_KEYS.filter((m) => !present.has(m) && !own.includes(m));
    // ID 189 (16 Oct): the CEO adds a metric for anyone (his draft); the Sales
    // Head only for an ISR or an ASM (his own number, ready to push).
    const isCeoAdder = !!can?.set_ceo_target;
    const mayAddHere =
        !!can?.edit_metrics &&
        (isCeoAdder || (SALES_HEAD_METRIC_FOR_ROLES as readonly string[]).includes((first.user_role ?? "").toLowerCase()));

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
        }, isCeoAdder ? "Metric added as a draft — post it to send it on" : "Metric added — push it to send it to the member");

    const saveActual = (r: TargetRow, raw: string) => {
        const v = raw.trim() === "" ? null : Number(raw);
        if (v === r.progress.actual) return;
        run(() => post({ action: "set_actual", id: r.id, value: v }), "Progress saved");
    };

    const saveCeo = (r: TargetRow, raw: string) => {
        const n = Number(raw);
        const shown = r.draft_ceo_target ?? r.next_ceo_target ?? r.ceo_target;
        if (raw.trim() === "" || n === shown) return;
        run(
            () => post({ action: "update", id: r.id, ceo_target: n }),
            r.status === "draft" ? "Saved" : "Saved as a draft revision — post it to send it on",
        );
    };

    const saveStretch = (r: TargetRow, raw: string, note: string | null) => {
        const n = raw.trim() === "" ? 0 : Number(raw);
        const shown = r.next_stretch ?? r.stretch;
        const shownNote = (r.next_stretch != null ? r.next_stretch_note : r.stretch_note) ?? "";
        if (n === shown && (note ?? "") === shownNote) return;
        run(
            () => post({ action: "update", id: r.id, stretch: n, stretch_note: note }),
            r.status === "pushed" || r.status === "accepted" || r.status === "rejected"
                ? "Stretch saved — it reaches the member when you push"
                : "Stretch saved",
        );
    };

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">
                    {name}
                    <span className="ml-2 text-[11px] font-normal text-ink-muted">{(first.user_role ?? "").replace(/_/g, " ")}</span>
                </h2>
                <button
                    type="button"
                    onClick={() => setShowHistory((v) => !v)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink"
                >
                    <History className="h-3 w-3" /> {showHistory ? "Hide history" : "History"}
                </button>
                <div className="ml-auto flex flex-wrap gap-2">
                    {can?.post && postIds.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "post", ids: postIds }), `Posted ${name}'s targets to the Sales Head`)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium"
                        >
                            <Send className="h-3 w-3" /> Post {postIds.length} to Sales Head
                        </button>
                    )}
                    {can?.send_to_member && pushIds.length > 0 && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => run(() => post({ action: "send_to_member", ids: pushIds }), `Pushed to ${name}`)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-2.5 py-1 text-xs font-medium text-white"
                        >
                            <Send className="h-3 w-3" /> Approve &amp; push {pushIds.length} to {name}
                        </button>
                    )}
                </div>
            </div>

            {corrections.length > 0 && (
                <div className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <span className="font-semibold">
                        {name} asked for a correction on {corrections.length} target{corrections.length === 1 ? "" : "s"}
                        {corrections[0].correction_requested_at ? ` on ${fmtWhen(corrections[0].correction_requested_at)}` : ""}:
                    </span>{" "}
                    “{corrections[0].correction_remark ?? ""}”
                    <span className="block text-amber-800/80">
                        The targets stay in force and the 48-hour clock keeps running. Change the stretch (or ask the CEO to post a
                        change), then push again.
                    </span>
                </div>
            )}
            {rejected.length > 0 && (
                <div className="mx-4 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                    <span className="font-semibold">
                        {name} rejected {rejected.length} target{rejected.length === 1 ? "" : "s"} (old flow)
                        {rejected[0].rejected_at ? ` on ${fmtWhen(rejected[0].rejected_at)}` : ""}:
                    </span>{" "}
                    “{rejected[0].reject_comment ?? "no comment"}”
                    <span className="block text-rose-700/80">Change the stretch below if needed, then push again.</span>
                </div>
            )}

            {showHistory && <HistoryPanel month={month} userId={first.user_id} />}

            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[1250px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Metric</th>
                            <th className="px-3 py-2 text-right font-semibold">CEO target</th>
                            <th className="px-3 py-2 text-right font-semibold" title="Added on top of the CEO target; never reduces it">
                                Stretch (Sales Head)
                            </th>
                            <th className="px-3 py-2 text-right font-semibold">Final target</th>
                            <th className="px-3 py-2 text-left font-semibold">Status</th>
                            {progressHeaders(ctx).map((h) => (
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
                                        {(can?.remove_any || (can?.remove_own && !r.ceo_owned)) && (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                title="Remove this metric (its history is kept)"
                                                onClick={() => {
                                                    const told =
                                                        r.status === "pushed" || r.status === "accepted" || r.status === "rejected"
                                                            ? ` ${name} and the Sales Head will be told.`
                                                            : r.status === "pending_approval"
                                                              ? " The Sales Head will be told."
                                                              : "";
                                                    if (confirm(`Remove "${r.metric_label}" from ${name}'s targets?${told}`)) {
                                                        run(() => post({ action: "remove", id: r.id }), "Metric removed");
                                                    }
                                                }}
                                                className="text-ink-muted hover:text-rose-600"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                    </span>
                                    <span className="block text-[10px] text-ink-muted">{r.kind === "per_day" ? "per day" : "per month"}</span>
                                </td>
                                <td className="px-3 py-2 text-right">
                                    {can?.set_ceo_target ? (
                                        <input
                                            key={`${r.id}:${r.draft_ceo_target ?? r.next_ceo_target ?? r.ceo_target}`}
                                            type="number"
                                            min={0}
                                            defaultValue={r.draft_ceo_target ?? r.next_ceo_target ?? r.ceo_target}
                                            onBlur={(e) => saveCeo(r, e.target.value)}
                                            className="w-24 rounded border border-border px-2 py-1 text-right tabular-nums"
                                        />
                                    ) : (
                                        <span className="tabular-nums">{fmtTarget(r.metric, r.next_ceo_target ?? r.ceo_target, r.unit)}</span>
                                    )}
                                    {r.draft_ceo_target != null && (
                                        <span className="block text-[10px] font-semibold text-amber-700">
                                            Draft revision — not posted. In force: {fmtTarget(r.metric, r.ceo_target, r.unit)}
                                        </span>
                                    )}
                                    {r.next_ceo_target != null && (
                                        <span className="block text-[10px] text-sky-700">
                                            Posted change — waits for the push. In force: {fmtTarget(r.metric, r.ceo_target, r.unit)}
                                        </span>
                                    )}
                                </td>
                                <td className="px-3 py-2 text-right">
                                    {can?.set_stretch && r.status !== "draft" ? (
                                        <StretchCell row={r} busy={busy} onSave={saveStretch} />
                                    ) : (
                                        <span className="tabular-nums">
                                            {(r.next_stretch ?? r.stretch) > 0 ? `+ ${fmtTarget(r.metric, r.next_stretch ?? r.stretch, r.unit)}` : "—"}
                                            {(r.next_stretch != null ? r.next_stretch_note : r.stretch_note) && (
                                                <span className="block max-w-[180px] text-[10px] italic text-ink-muted">
                                                    “{r.next_stretch != null ? r.next_stretch_note : r.stretch_note}”
                                                </span>
                                            )}
                                        </span>
                                    )}
                                    {r.next_stretch != null && (
                                        <span className="block text-[10px] text-sky-700">
                                            Waits for the push. In force: + {fmtTarget(r.metric, r.stretch, r.unit)}
                                        </span>
                                    )}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    <span className="font-semibold">{fmtTargetPer(r.metric, r.final_target, r.unit, r.kind)}</span>
                                    <span className="block text-[10px] font-normal text-ink-muted">{fmtTargetSum(r.metric, r.ceo_target, r.stretch, r.unit)}</span>
                                    {r.version > 0 && <span className="block text-[10px] font-normal text-ink-muted">version {r.version}</span>}
                                </td>
                                <td className="px-3 py-2 text-[12px]">
                                    <span
                                        className={
                                            (r.status === "pushed" || r.status === "rejected") && (r.hours_since_push_unaccepted ?? 0) >= 48
                                                ? "font-semibold text-rose-700"
                                                : (STATUS_TONE[r.status] ?? "text-ink-muted")
                                        }
                                    >
                                        {TARGET_STATUS_LABEL[r.status] ?? r.status}
                                        {r.status === "pushed" && r.hours_since_push_unaccepted != null && ` (${r.hours_since_push_unaccepted}h since first sent)`}
                                    </span>
                                    {r.posted_at && r.status !== "draft" && (
                                        <span className="block text-[10px] text-ink-muted">Posted {fmtWhen(r.posted_at)}</span>
                                    )}
                                    {r.pushed_at && <span className="block text-[10px] text-ink-muted">Arrived {fmtWhen(r.pushed_at)}</span>}
                                    {r.status === "accepted" && r.accept_remark && (
                                        <span className="block max-w-[200px] text-[10px] italic text-emerald-800">“{r.accept_remark}”</span>
                                    )}
                                    {r.correction_open && <span className="block text-[10px] font-semibold text-amber-700">Correction asked</span>}
                                </td>
                                <TargetProgressCells
                                    metric={r.metric}
                                    p={r.progress}
                                    unit={r.unit}
                                    kind={r.kind}
                                    actualSlot={
                                        r.is_custom && (can?.enter_progress ?? can?.edit_metrics) ? (
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

            {mayAddHere && (
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
                            placeholder={isCeoAdder ? "CEO target" : "Target"}
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

/** The Sales Head's stretch: a number (add only) and an optional note, saved on blur. */
function StretchCell({
    row,
    busy,
    onSave,
}: {
    row: TargetRow;
    busy: boolean;
    onSave: (r: TargetRow, raw: string, note: string | null) => void;
}) {
    const shown = row.next_stretch ?? row.stretch;
    const shownNote = (row.next_stretch != null ? row.next_stretch_note : row.stretch_note) ?? "";
    const [value, setValue] = useState(shown ? String(shown) : "");
    const [note, setNote] = useState(shownNote);
    const save = () => onSave(row, value, note.trim() || null);
    return (
        <span className="inline-flex flex-col items-end gap-1">
            <input
                type="number"
                min={0}
                value={value}
                disabled={busy}
                onChange={(e) => setValue(e.target.value)}
                onBlur={save}
                placeholder="+ 0"
                title="Added on top of the CEO target. It can never reduce it."
                className="w-24 rounded border border-border px-2 py-1 text-right tabular-nums placeholder:text-[11px]"
            />
            <input
                value={note}
                disabled={busy}
                onChange={(e) => setNote(e.target.value)}
                onBlur={save}
                maxLength={1000}
                placeholder="Note (optional)"
                className="w-40 rounded border border-border px-2 py-0.5 text-right text-[11px]"
            />
        </span>
    );
}

/** Every version of one person's targets this month (E-343 sales_target_versions). */
function HistoryPanel({ month, userId }: { month: string; userId: string }) {
    const { data, isLoading, error } = useQuery<{ rows: TargetVersionRow[] }>({
        queryKey: ["targets-history", month, userId],
        queryFn: async () => {
            const res = await fetch(`/api/admin/targets?month=${month}&history=${encodeURIComponent(userId)}`, { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load the history");
            return json.data;
        },
    });
    const num = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 1 }));
    return (
        <div className="mx-4 mb-3 rounded-lg border border-border bg-bg/40 px-3 py-2 text-xs">
            {isLoading && <p className="text-ink-muted">Loading history…</p>}
            {error && <p className="text-rose-600">{(error as Error).message}</p>}
            {data && data.rows.length === 0 && <p className="text-ink-muted">No changes recorded yet.</p>}
            {data && data.rows.length > 0 && (
                <table className="w-full">
                    <thead className="text-[10px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="py-1 text-left font-semibold">When</th>
                            <th className="py-1 text-left font-semibold">Metric</th>
                            <th className="py-1 text-left font-semibold">What</th>
                            <th className="py-1 text-right font-semibold">Version</th>
                            <th className="py-1 text-right font-semibold">CEO target</th>
                            <th className="py-1 text-right font-semibold">Stretch</th>
                            <th className="py-1 text-left font-semibold">Who</th>
                            <th className="py-1 text-left font-semibold">Note / remark</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {data.rows.map((v, i) => (
                            <tr key={`${v.target_id}:${v.changed_at}:${i}`}>
                                <td className="py-1 pr-2 text-ink-muted">{fmtWhen(v.changed_at)}</td>
                                <td className="py-1 pr-2">{v.metric_label}</td>
                                <td className="py-1 pr-2">{EVENT_LABEL[v.event] ?? v.event}</td>
                                <td className="py-1 pr-2 text-right tabular-nums">{v.version || "—"}</td>
                                <td className="py-1 pr-2 text-right tabular-nums">
                                    {v.old_ceo_target != null && v.old_ceo_target !== v.ceo_target ? `${num(v.old_ceo_target)} → ` : ""}
                                    {num(v.ceo_target)}
                                </td>
                                <td className="py-1 pr-2 text-right tabular-nums">
                                    {v.old_stretch != null && v.old_stretch !== v.stretch ? `${num(v.old_stretch)} → ` : ""}
                                    {num(v.stretch)}
                                </td>
                                <td className="py-1 pr-2">{v.changed_by_name ?? "—"}</td>
                                <td className="py-1 text-ink-muted">{v.note ?? ""}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
