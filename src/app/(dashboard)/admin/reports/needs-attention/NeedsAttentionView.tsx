"use client";

// R-15 — the needs-attention list. Reassigning goes through the admin
// BulkActionBar (real user picker, /api/admin/leads/bulk): tick rows — or
// "select all" on a filtered list — for a batch, or press a row's Reassign to
// act on that one lead.
//
// Filters: "Held by" narrows the query (server); search / role / status /
// interest / idle days narrow the loaded rows with filterNeedsAttention, the
// same function the CSV route runs, so "Download CSV" is the list on screen.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Loader2, PhoneOff, Search } from "lucide-react";

import { BulkActionBar } from "@/app/(dashboard)/admin/_components/BulkActionBar";
import type { NeedsAttentionHolderSummary, NeedsAttentionRow } from "@/lib/leads/needsAttention";
import { IDLE_MIN_OPTIONS, filterNeedsAttention, type NeedsAttentionFilters } from "@/lib/leads/needsAttentionFilter";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";

const QUERY_KEY = ["needs-attention"];

const FIELD =
    "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand-teal";

function fmtDate(iso: string | null): string {
    if (!iso) return "never";
    return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function idleTone(days: number): string {
    if (days >= 14) return "text-rose-700 font-semibold";
    if (days >= 7) return "text-amber-700 font-semibold";
    return "text-ink";
}

const statusLabel = (s: string | null) =>
    (s && (LEAD_STATUS_LABEL as Record<string, string>)[s]) || (s ?? "—").replace(/_/g, " ");

export function NeedsAttentionView() {
    const qc = useQueryClient();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [reassignSignal, setReassignSignal] = useState(0);
    const [holder, setHolder] = useState("");
    const [q, setQ] = useState("");
    const [role, setRole] = useState("");
    const [status, setStatus] = useState("");
    const [interest, setInterest] = useState("");
    const [minDays, setMinDays] = useState("");

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

    const filters: NeedsAttentionFilters = { q, role, status, interest, minDays: minDays ? Number(minDays) : null };
    const rows = data?.rows ?? [];
    const shown = filterNeedsAttention(rows, filters);
    const anyFilter = Boolean(q || role || status || interest || minDays);
    const totalIdle = (data?.holders ?? []).reduce((s, h) => s + h.idle, 0);
    const totalDead = (data?.holders ?? []).reduce((s, h) => s + h.non_responsive, 0);
    const capped = rows.length < totalIdle + totalDead;
    const idle = shown.filter((r) => !r.non_responsive);
    const deadNumbers = shown.filter((r) => r.non_responsive);
    const statuses = useMemo(
        () => [...new Set(rows.map((r) => r.lead_status).filter((s): s is string => !!s))].sort(),
        [rows],
    );

    // A changed filter starts a fresh selection: ticked rows that are now
    // hidden must not be reassigned by a batch the user cannot see.
    useEffect(() => {
        setSelected(new Set());
    }, [holder, q, role, status, interest, minDays]);

    const csvQs = new URLSearchParams({ format: "csv" });
    if (holder) csvQs.set("holder", holder);
    if (q.trim()) csvQs.set("q", q.trim());
    if (role) csvQs.set("role", role);
    if (status) csvQs.set("status", status);
    if (interest) csvQs.set("interest", interest);
    if (minDays) csvQs.set("min_days", minDays);

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

    const clearFilters = () => {
        setQ("");
        setRole("");
        setStatus("");
        setInterest("");
        setMinDays("");
    };

    const table = (list: NeedsAttentionRow[]) => {
        const allTicked = list.length > 0 && list.every((r) => selected.has(r.lead_id));
        const toggleAll = () =>
            setSelected((s) => {
                const n = new Set(s);
                for (const r of list) {
                    if (allTicked) n.delete(r.lead_id);
                    else n.add(r.lead_id);
                }
                return n;
            });
        return (
            <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="w-8 px-3 py-2">
                                <input
                                    type="checkbox"
                                    aria-label={allTicked ? "Untick all leads in this list" : "Tick all leads in this list"}
                                    title={allTicked ? "Untick all" : `Tick all ${list.length}`}
                                    checked={allTicked}
                                    onChange={toggleAll}
                                />
                            </th>
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
                            <tr key={r.lead_id} className={selected.has(r.lead_id) ? "bg-brand-50/50" : "hover:bg-brand-50/30"}>
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
                                    <div className="text-[11px] text-ink-muted">{(r.holder_role ?? "").replace(/_/g, " ")}</div>
                                </td>
                                <td className="px-3 py-2 text-ink-muted">
                                    {statusLabel(r.lead_status)}
                                    {r.interest_level && <span className="ml-1 text-[11px] uppercase">· {r.interest_level}</span>}
                                    {r.visit_overdue && (
                                        <div className="mt-0.5">
                                            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                                                Field visit overdue
                                            </span>
                                        </div>
                                    )}
                                </td>
                                <td className={`px-3 py-2 text-right tabular-nums ${idleTone(r.days_idle)}`}>{r.days_idle}</td>
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
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <span className="font-semibold text-ink">{totalIdle.toLocaleString("en-IN")}</span>
                <span className="text-ink-muted">idle leads</span>
                {totalDead > 0 && <span className="text-ink-muted">· {totalDead.toLocaleString("en-IN")} non-responsive</span>}
                {anyFilter && (
                    <span className="text-ink-muted">
                        · <span className="font-semibold text-ink">{shown.length.toLocaleString("en-IN")}</span> match the filters
                    </span>
                )}
                {capped && (
                    <span className="text-ink-muted">
                        · showing the oldest {rows.length.toLocaleString("en-IN")} — pick a person to narrow
                    </span>
                )}
            </div>

            {/* Filters + download */}
            <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5">
                <label className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 sm:w-64">
                    <Search className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search dealer, city, person…"
                        aria-label="Search"
                        className="min-w-0 grow border-0 bg-transparent text-sm text-ink outline-none"
                    />
                </label>
                <select value={holder} onChange={(e) => setHolder(e.target.value)} aria-label="Held by" className={FIELD}>
                    <option value="">Held by: everyone</option>
                    {holders.map(([id, name]) => (
                        <option key={id} value={id}>
                            {name}
                        </option>
                    ))}
                </select>
                <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role" className={FIELD}>
                    <option value="">All roles</option>
                    <option value="inside">Inside sales (ISR)</option>
                    <option value="field">Field (ASM)</option>
                </select>
                <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className={FIELD}>
                    <option value="">All statuses</option>
                    {statuses.map((s) => (
                        <option key={s} value={s}>
                            {statusLabel(s)}
                        </option>
                    ))}
                </select>
                <select value={interest} onChange={(e) => setInterest(e.target.value)} aria-label="Interest" className={FIELD}>
                    <option value="">Any interest</option>
                    <option value="hot">Hot</option>
                    <option value="warm">Warm</option>
                    <option value="cold">Cold</option>
                </select>
                <select value={minDays} onChange={(e) => setMinDays(e.target.value)} aria-label="Idle at least" className={FIELD}>
                    <option value="">Any idle days</option>
                    {IDLE_MIN_OPTIONS.map((d) => (
                        <option key={d} value={String(d)}>
                            Idle {d}+ working days
                        </option>
                    ))}
                </select>
                {anyFilter && (
                    <button type="button" onClick={clearFilters} className="text-sm font-semibold text-brand-sky hover:underline">
                        Clear
                    </button>
                )}
                <a
                    href={`/api/admin/needs-attention?${csvQs}`}
                    download
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-brand-navy hover:bg-bg"
                >
                    <Download className="h-3.5 w-3.5" aria-hidden /> Download CSV
                </a>
            </div>

            {/* Bulk actions — always visible so the option is findable */}
            <div className="flex min-h-[44px] flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2 text-sm">
                {selected.size > 0 ? (
                    <BulkActionBar
                        selectedIds={[...selected]}
                        onClear={() => setSelected(new Set())}
                        onActionDone={refresh}
                        reassignSignal={reassignSignal}
                    />
                ) : (
                    <>
                        <span className="text-ink-muted">
                            <span className="font-semibold text-ink">Bulk reassign:</span> tick leads, or tick the box in the table header
                            to select every lead shown{anyFilter ? " (after filtering)" : ""}.
                        </span>
                        {idle.length > 0 && (
                            <button
                                type="button"
                                onClick={() => setSelected(new Set(idle.map((r) => r.lead_id)))}
                                className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-ink hover:bg-bg"
                            >
                                Select all {idle.length.toLocaleString("en-IN")} shown
                            </button>
                        )}
                    </>
                )}
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
                            {anyFilter ? "No idle leads match these filters." : "Nobody is sitting on a lead. Nothing needs attention."}
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
                            6 or more days of unanswered calls in the last 45. Kept out of the idle count — consider marking
                            Lost or reassigning for a fresh approach.
                        </p>
                    </div>
                    <div className="border-t border-border">{table(deadNumbers)}</div>
                </div>
            )}
        </div>
    );
}
