"use client";

// R-15 — the needs-attention list. Reassigning goes through the admin
// BulkActionBar (real user picker, /api/admin/leads/bulk): tick rows for a
// batch, or press a row's Reassign to act on that one lead.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, PhoneOff } from "lucide-react";

import { BulkActionBar } from "@/app/(dashboard)/admin/_components/BulkActionBar";
import type { NeedsAttentionHolderSummary, NeedsAttentionRow } from "@/lib/leads/needsAttention";

const QUERY_KEY = ["needs-attention"];

function fmtDate(iso: string | null): string {
    if (!iso) return "never";
    return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function idleTone(days: number): string {
    if (days >= 14) return "text-rose-700 font-semibold";
    if (days >= 7) return "text-amber-700 font-semibold";
    return "text-ink";
}

export function NeedsAttentionView() {
    const qc = useQueryClient();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [reassignSignal, setReassignSignal] = useState(0);
    const [holder, setHolder] = useState("");

    const { data, isLoading, error } = useQuery<{
        rows: NeedsAttentionRow[];
        holders: NeedsAttentionHolderSummary[];
    }>({
        queryKey: [...QUERY_KEY, holder],
        queryFn: async () => {
            const qs = holder ? `?holder=${encodeURIComponent(holder)}` : "";
            const res = await fetch(`/api/admin/needs-attention${qs}`, { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load the list");
            return json.data;
        },
        placeholderData: (prev) => prev,
    });

    // The holder picker is built from the FIRST, unfiltered load so choosing a
    // person does not shrink the picker to that one person.
    const [allHolders, setAllHolders] = useState<NeedsAttentionHolderSummary[]>([]);
    useEffect(() => {
        if (!holder && data) setAllHolders(data.holders);
    }, [holder, data]);
    const holders = useMemo(
        () =>
            allHolders
                .map((h) => [h.holder_id, `${h.holder_name ?? h.holder_id} (${h.idle})`] as const)
                .sort((a, b) => a[1].localeCompare(b[1])),
        [allHolders],
    );

    const rows = data?.rows ?? [];
    const totalIdle = (data?.holders ?? []).reduce((s, h) => s + h.idle, 0);
    const totalDead = (data?.holders ?? []).reduce((s, h) => s + h.non_responsive, 0);
    const idle = rows.filter((r) => !r.non_responsive);
    const deadNumbers = rows.filter((r) => r.non_responsive);

    const toggle = (id: string) =>
        setSelected((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
        });

    const refresh = () => {
        setSelected(new Set());
        qc.invalidateQueries({ queryKey: QUERY_KEY });
    };

    const table = (list: NeedsAttentionRow[]) => (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                    <tr>
                        <th className="w-8 px-3 py-2" />
                        <th className="px-3 py-2 text-left font-semibold">Dealer / shop</th>
                        <th className="px-3 py-2 text-left font-semibold">Held by</th>
                        <th className="px-3 py-2 text-left font-semibold">Status</th>
                        <th className="px-3 py-2 text-right font-semibold">Working days idle</th>
                        <th className="px-3 py-2 text-left font-semibold">Last worked</th>
                        <th className="px-3 py-2 text-left font-semibold">Last disposition</th>
                        <th className="px-3 py-2" />
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {list.map((r) => (
                        <tr key={r.lead_id} className="hover:bg-brand-50/30">
                            <td className="px-3 py-2">
                                <input
                                    type="checkbox"
                                    aria-label={`Select ${r.dealer}`}
                                    checked={selected.has(r.lead_id)}
                                    onChange={() => toggle(r.lead_id)}
                                />
                            </td>
                            <td className="px-3 py-2">
                                <Link
                                    href={`/inside-sales/lead/${encodeURIComponent(r.lead_id)}`}
                                    className="font-medium text-ink hover:underline"
                                >
                                    {r.dealer}
                                </Link>
                                <div className="text-[11px] text-ink-muted">{r.city ?? "—"}</div>
                            </td>
                            <td className="px-3 py-2">
                                <div className="text-ink">{r.holder_name ?? "(unknown user)"}</div>
                                <div className="text-[11px] text-ink-muted">
                                    {(r.holder_role ?? "").replace(/_/g, " ")}
                                </div>
                            </td>
                            <td className="px-3 py-2 text-ink-muted">
                                {(r.lead_status ?? "—").replace(/_/g, " ")}
                                {r.interest_level && (
                                    <span className="ml-1 text-[11px] uppercase">· {r.interest_level}</span>
                                )}
                            </td>
                            <td className={`px-3 py-2 text-right tabular-nums ${idleTone(r.days_idle)}`}>
                                {r.days_idle}
                            </td>
                            <td className="px-3 py-2 text-ink-muted">{fmtDate(r.last_worked_at)}</td>
                            <td className="px-3 py-2 text-ink-muted">
                                {r.last_disposition ?? "—"}
                                {r.last_disposition_bucket && (
                                    <span className="ml-1 text-[11px]">({r.last_disposition_bucket})</span>
                                )}
                            </td>
                            <td className="px-3 py-2 text-right">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSelected(new Set([r.lead_id]));
                                        setReassignSignal((n) => n + 1);
                                    }}
                                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink hover:bg-bg"
                                >
                                    Reassign
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <span className="font-semibold text-ink">{totalIdle.toLocaleString("en-IN")}</span>
                    <span className="text-ink-muted">idle leads</span>
                    {totalDead > 0 && (
                        <span className="text-ink-muted">
                            · {totalDead.toLocaleString("en-IN")} non-responsive
                        </span>
                    )}
                    {idle.length + deadNumbers.length < totalIdle + totalDead && (
                        <span className="text-ink-muted">
                            · showing the oldest {(idle.length + deadNumbers.length).toLocaleString("en-IN")} — pick a person to narrow
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-ink-muted">
                        Held by
                        <select
                            value={holder}
                            onChange={(e) => {
                                setHolder(e.target.value);
                                setSelected(new Set());
                            }}
                            className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-ink"
                        >
                            <option value="">Everyone</option>
                            {holders.map(([id, name]) => (
                                <option key={id} value={id}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    </label>
                    {selected.size > 0 && (
                        <BulkActionBar
                            selectedIds={[...selected]}
                            onClear={() => setSelected(new Set())}
                            onActionDone={refresh}
                            reassignSignal={reassignSignal}
                        />
                    )}
                </div>
            </div>

            {isLoading && (
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            )}
            {error && <p className="text-sm text-rose-600">{(error as Error).message}</p>}

            {!isLoading && !error && (
                <div className="rounded-xl border border-border bg-surface shadow-card">
                    {idle.length === 0 ? (
                        <p className="px-4 py-10 text-center text-sm text-ink-muted">
                            Nobody is sitting on a lead. Nothing needs attention.
                        </p>
                    ) : (
                        table(idle)
                    )}
                </div>
            )}

            {deadNumbers.length > 0 && (
                <div className="rounded-xl border border-border bg-surface shadow-card">
                    <div className="flex items-center gap-2 px-4 py-3">
                        <PhoneOff className="h-4 w-4 text-ink-muted" />
                        <h2 className="text-sm font-semibold text-ink">Non-responsive</h2>
                        <p className="text-[11px] text-ink-muted">
                            6 or more days of unanswered calls in the last 45. Kept out of the idle
                            count — consider marking Lost or reassigning for a fresh approach.
                        </p>
                    </div>
                    <div className="border-t border-border">{table(deadNumbers)}</div>
                </div>
            )}
        </div>
    );
}
