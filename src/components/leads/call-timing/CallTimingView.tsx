// ID 144 — AI dialer: when dealers answer and talk, by weekday × hour (IST),
// so calling hours can be set from data. Admin / CEO on /leads ("Call timing"
// tab), Sales Head on /sales-head/campaigns. Data: /api/campaigns/call-timing.

"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Download, RefreshCw } from "lucide-react";

import {
    WEEKDAYS,
    rate,
    type CallTimingCount,
    type CallTimingGrid,
} from "@/lib/ai-dialer/callTimingShape";

type Metric = "talk" | "answer" | "dials";

type Filters = { from: string; to: string; campaign_id: string; state: string; city: string };

type Payload = {
    grid: CallTimingGrid;
    places: Array<{ state: string; city: string | null }>;
    can_set_hours: boolean;
};

const METRICS: Array<{ key: Metric; label: string }> = [
    { key: "talk", label: "Talk rate" },
    { key: "answer", label: "Answer rate" },
    { key: "dials", label: "Dials" },
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const isoDaysAgo = (days: number) => {
    const d = new Date(Date.now() + 5.5 * 3600_000 - days * 86400_000); // IST calendar day
    return d.toISOString().slice(0, 10);
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function value(c: CallTimingCount, m: Metric): number {
    if (m === "dials") return c.dials;
    return m === "talk" ? rate(c.talked, c.dials) : rate(c.answered, c.dials);
}

function qs(f: Filters, extra?: Record<string, string>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    return p.toString();
}

export function CallTimingView() {
    const [filters, setFilters] = useState<Filters>({
        from: isoDaysAgo(30),
        to: isoDaysAgo(0),
        campaign_id: "",
        state: "",
        city: "",
    });
    const [metric, setMetric] = useState<Metric>("talk");
    const set = (k: keyof Filters, v: string) =>
        setFilters((f) => ({ ...f, [k]: v, ...(k === "state" ? { city: "" } : {}) }));

    const campaigns = useQuery<Array<{ id: string; name: string }>>({
        queryKey: ["call-timing-campaigns"],
        queryFn: async () => {
            const res = await fetch("/api/ai-dialer/campaigns?limit=200");
            if (!res.ok) return [];
            const j = await res.json();
            return (j?.data?.data ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }));
        },
        staleTime: 60_000,
    });

    const q = useQuery<Payload>({
        queryKey: ["call-timing", filters],
        queryFn: async () => {
            const res = await fetch(`/api/campaigns/call-timing?${qs(filters)}`);
            const j = await res.json();
            if (!res.ok || !j.success) throw new Error(j?.error?.message ?? "Could not load call timing");
            return j.data as Payload;
        },
    });

    const qc = useQueryClient();
    const apply = useMutation({
        mutationFn: async (w: { window_start: string; window_end: string }) => {
            const res = await fetch("/api/campaigns/call-timing", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(w),
            });
            const j = await res.json();
            if (!res.ok || !j.success) throw new Error(j?.error?.message ?? "Could not save calling hours");
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ["call-timing"] }),
    });

    const grid = q.data?.grid;
    const states = useMemo(() => [...new Set((q.data?.places ?? []).map((p) => p.state))], [q.data]);
    const cities = useMemo(
        () =>
            (q.data?.places ?? [])
                .filter((p) => p.city && (!filters.state || p.state === filters.state))
                .map((p) => p.city as string),
        [q.data, filters.state],
    );

    const max = useMemo(() => {
        if (!grid) return 0;
        return Math.max(0, ...grid.cells.flat().filter((c) => c.dials > 0).map((c) => value(c, metric)));
    }, [grid, metric]);

    const s = grid?.suggestion ?? null;

    return (
        <div className="space-y-4">
            <div className="bg-white border border-gray-200 rounded-2xl px-4 py-4 flex flex-wrap items-end gap-3">
                <Field label="From">
                    <input type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} className={INPUT} />
                </Field>
                <Field label="To">
                    <input type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} className={INPUT} />
                </Field>
                <Field label="Campaign">
                    <select value={filters.campaign_id} onChange={(e) => set("campaign_id", e.target.value)} className={INPUT}>
                        <option value="">All campaigns</option>
                        {(campaigns.data ?? []).map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="State">
                    <select value={filters.state} onChange={(e) => set("state", e.target.value)} className={INPUT}>
                        <option value="">All states</option>
                        {states.map((st) => (
                            <option key={st} value={st}>
                                {st}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="City">
                    <select value={filters.city} onChange={(e) => set("city", e.target.value)} className={INPUT}>
                        <option value="">All cities</option>
                        {cities.map((c) => (
                            <option key={c} value={c}>
                                {c}
                            </option>
                        ))}
                    </select>
                </Field>
                <div className="flex items-center gap-2 ml-auto">
                    <button onClick={() => q.refetch()} className={BUTTON} title="Refresh">
                        <RefreshCw className={`w-4 h-4 ${q.isFetching ? "animate-spin" : ""}`} />
                    </button>
                    <a href={`/api/campaigns/call-timing?${qs(filters, { format: "csv" })}`} className={BUTTON}>
                        <Download className="w-4 h-4" /> CSV
                    </a>
                </div>
            </div>

            {q.isError && <p className="text-sm text-rose-600">{(q.error as Error).message}</p>}

            {grid && (
                <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <Kpi label="Dials" value={grid.total.dials.toLocaleString("en-IN")} />
                        <Kpi label="Answered" value={pct(rate(grid.total.answered, grid.total.dials))} />
                        <Kpi label="Talked" value={pct(rate(grid.total.talked, grid.total.dials))} />
                        <Kpi label="Conversations" value={grid.total.talked.toLocaleString("en-IN")} />
                    </div>

                    <div className="bg-white border border-gray-200 rounded-2xl p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                            <p className="text-sm font-semibold text-gray-900">Weekday × hour (IST)</p>
                            <div className="flex bg-gray-100 rounded-lg p-0.5">
                                {METRICS.map((m) => (
                                    <button
                                        key={m.key}
                                        onClick={() => setMetric(m.key)}
                                        className={`px-3 py-1 text-xs font-medium rounded-md ${metric === m.key ? "bg-white shadow-sm text-gray-900" : "text-gray-500"}`}
                                    >
                                        {m.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {grid.total.dials === 0 ? (
                            <p className="text-sm text-gray-500 py-6 text-center">No AI dialer calls match these filters.</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="border-separate border-spacing-0.5 text-[10px]">
                                    <thead>
                                        <tr>
                                            <th />
                                            {HOURS.map((h) => (
                                                <th key={h} className="w-9 font-medium text-gray-400">
                                                    {String(h).padStart(2, "0")}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {grid.cells.map((row, d) => (
                                            <tr key={WEEKDAYS[d]}>
                                                <th className="pr-2 text-left font-medium text-gray-500">{WEEKDAYS[d]}</th>
                                                {row.map((c, h) => (
                                                    <Cell key={h} c={c} metric={metric} max={max} day={WEEKDAYS[d]} hour={h} />
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <p className="mt-3 text-xs text-gray-500">
                            Every attempt counts, retries included. Answered = picked up (spoke, silent or hung up
                            early); talked = the dealer spoke. Calls that never left our side are left out. Hours outside
                            a campaign's calling window stay empty.
                        </p>
                    </div>

                    <div className="bg-white border border-gray-200 rounded-2xl p-4 flex flex-wrap items-center gap-4">
                        <Clock className="w-5 h-5 text-gray-400" />
                        {s ? (
                            <div className="flex-1 min-w-[240px] text-sm text-gray-700">
                                <p className="font-semibold text-gray-900">
                                    Suggested calling hours: {s.window_start}–{s.window_end}
                                </p>
                                <p className="text-xs text-gray-500 mt-0.5">
                                    Talk rate {pct(s.window_talk_rate)} inside this window vs {pct(s.overall_talk_rate)}{" "}
                                    overall. Best hours: {s.best_hours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")}.
                                </p>
                            </div>
                        ) : (
                            <p className="flex-1 text-sm text-gray-500">
                                Not enough calls yet to suggest calling hours (each hour needs at least 20 dials).
                            </p>
                        )}
                        {s && q.data?.can_set_hours && (
                            <button
                                disabled={apply.isPending}
                                onClick={() => apply.mutate({ window_start: s.window_start, window_end: s.window_end })}
                                className="px-3 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium disabled:opacity-50"
                            >
                                {apply.isSuccess ? "Saved as default calling hours" : "Use as default calling hours"}
                            </button>
                        )}
                        {apply.isError && <p className="w-full text-xs text-rose-600">{(apply.error as Error).message}</p>}
                        {s && q.data?.can_set_hours && (
                            <p className="w-full text-xs text-gray-400">
                                New campaigns start with these hours. Running campaigns keep their own window.
                            </p>
                        )}
                    </div>
                </>
            )}
            {q.isLoading && <p className="text-sm text-gray-500">Loading call timing…</p>}
        </div>
    );
}

const INPUT = "border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm bg-white";
const BUTTON =
    "inline-flex items-center gap-1.5 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">{label}</span>
            {children}
        </label>
    );
}

function Kpi({ label, value: v }: { label: string; value: string }) {
    return (
        <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3">
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-xl font-semibold text-gray-900">{v}</p>
        </div>
    );
}

function Cell({ c, metric, max, day, hour }: { c: CallTimingCount; metric: Metric; max: number; day: string; hour: number }) {
    if (c.dials === 0) return <td className="w-9 h-7 rounded bg-gray-50" />;
    const v = value(c, metric);
    const strength = max > 0 ? v / max : 0;
    const label = metric === "dials" ? String(c.dials) : `${Math.round(v * 100)}`;
    return (
        <td
            className={`w-9 h-7 rounded text-center tabular-nums ${strength > 0.55 ? "text-white" : "text-gray-700"}`}
            style={{ backgroundColor: `rgba(16, 122, 87, ${0.08 + strength * 0.85})` }}
            title={`${day} ${String(hour).padStart(2, "0")}:00 IST — ${c.dials} dials, ${c.answered} answered (${pct(rate(c.answered, c.dials))}), ${c.talked} talked (${pct(rate(c.talked, c.dials))})`}
        >
            {label}
        </td>
    );
}
