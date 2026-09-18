"use client";

// B10 — the Funnel tab on /admin/reports: four KPI cards, a group-by selector
// with the slicing filters, the grouped table, and a bar list of rejection
// reasons. Reads /api/admin/reports/funnel-counts; the CSV button calls the
// same URL with ?format=csv so the sheet is exactly the table on screen.
//
// Imports types from funnelCountsTypes (client-safe), never from the builder.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, FileCheck2, Info, Loader2, ShieldCheck, Wallet, XOctagon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { KPICard } from "@/components/shared/kpi-card";
import {
    FUNNEL_GROUP_BYS,
    FUNNEL_GROUP_LABELS,
    type FunnelCountsResult,
    type FunnelGroupBy,
    type FunnelReason,
} from "@/lib/admin/funnelCountsTypes";
import type { RegionsResponse } from "@/app/api/locations/regions/route";

const INPUT =
    "h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink outline-none focus:border-brand-teal";
const LABEL = "block text-[10px] font-medium uppercase tracking-wide text-ink-muted mb-1";
const fmt = (n: number) => n.toLocaleString("en-IN");

/** A bar list: one hue, length = share of the largest. Text carries the number; colour is decoration. */
function ReasonBars({ title, reasons, empty }: { title: string; reasons: FunnelReason[]; empty: string }) {
    const max = Math.max(1, ...reasons.map((r) => r.count));
    return (
        <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
            <h3 className="text-sm font-semibold text-ink">{title}</h3>
            {reasons.length === 0 ? (
                <p className="mt-2 text-xs text-ink-muted">{empty}</p>
            ) : (
                <ul className="mt-3 space-y-2">
                    {reasons.map((r) => (
                        <li key={r.reason} className="text-sm">
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="truncate text-ink" title={r.reason}>{r.reason}</span>
                                <span className="shrink-0 tabular-nums text-ink-muted">{fmt(r.count)}</span>
                            </div>
                            <div className="mt-1 h-2 w-full rounded-full bg-bg">
                                <div
                                    className="h-2 rounded-full"
                                    style={{ width: `${Math.max(2, (r.count / max) * 100)}%`, background: "#2e68b2" }}
                                />
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function FunnelView() {
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [state, setState] = useState("");
    const [city, setCity] = useState("");
    const [dealerId, setDealerId] = useState("");
    const [nbfcId, setNbfcId] = useState("");
    const [groupBy, setGroupBy] = useState<FunnelGroupBy>("none");

    const qs = useMemo(() => {
        const p = new URLSearchParams();
        if (from) p.set("from", from);
        if (to) p.set("to", to);
        if (state) p.set("state", state);
        if (city) p.set("city", city);
        if (dealerId) p.set("dealer_id", dealerId);
        if (nbfcId) p.set("nbfc_id", nbfcId);
        if (groupBy !== "none") p.set("group_by", groupBy);
        return p.toString();
    }, [from, to, state, city, dealerId, nbfcId, groupBy]);

    const query = useQuery<{ success: true; data: FunnelCountsResult }>({
        queryKey: ["admin-funnel-counts", qs],
        queryFn: async () => {
            const res = await fetch(`/api/admin/reports/funnel-counts${qs ? `?${qs}` : ""}`, { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load funnel counts");
            return json;
        },
        placeholderData: (prev) => prev,
    });
    const d = query.data?.data;

    const regions = useQuery<{ success: true; data: RegionsResponse }>({
        queryKey: ["locations-regions"],
        queryFn: async () => {
            const res = await fetch("/api/locations/regions", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load regions");
            return res.json();
        },
        staleTime: 60 * 60 * 1000,
    });
    const states = regions.data?.data.states ?? [];
    const citiesByState = regions.data?.data.citiesByState ?? {};
    const selectedCode = states.find((s) => s.name === state)?.code;
    const cities = selectedCode
        ? (citiesByState[selectedCode] ?? [])
        : Array.from(new Set(Object.values(citiesByState).flat())).sort();

    const csvHref = `/api/admin/reports/funnel-counts?${qs ? `${qs}&` : ""}format=csv`;
    const dirty = !!(from || to || state || city || dealerId || nbfcId || groupBy !== "none");

    return (
        <div className="space-y-4">
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="flex flex-wrap items-end gap-3 px-4 py-3">
                    <div>
                        <label className={LABEL}>From</label>
                        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT} />
                    </div>
                    <div>
                        <label className={LABEL}>To</label>
                        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={INPUT} />
                    </div>
                    <div>
                        <label className={LABEL}>State</label>
                        <select value={state} onChange={(e) => { setState(e.target.value); setCity(""); }} className={`${INPUT} min-w-[150px]`}>
                            <option value="">Any state</option>
                            {states.map((s) => <option key={s.code} value={s.name}>{s.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className={LABEL}>City</label>
                        <select value={city} onChange={(e) => setCity(e.target.value)} className={`${INPUT} min-w-[150px]`}>
                            <option value="">Any city</option>
                            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className={LABEL}>Dealer</label>
                        <select value={dealerId} onChange={(e) => setDealerId(e.target.value)} className={`${INPUT} min-w-[180px]`}>
                            <option value="">All dealers</option>
                            {(d?.options.dealers ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className={LABEL}>Financier</label>
                        <select value={nbfcId} onChange={(e) => setNbfcId(e.target.value)} className={`${INPUT} min-w-[180px]`}>
                            <option value="">All financiers</option>
                            {(d?.options.nbfcs ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className={LABEL}>Group by</label>
                        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as FunnelGroupBy)} className={INPUT}>
                            {FUNNEL_GROUP_BYS.map((g) => <option key={g} value={g}>{FUNNEL_GROUP_LABELS[g]}</option>)}
                        </select>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                        {query.isFetching && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
                        <Button type="button" variant="outline" size="sm" disabled={!dirty} onClick={() => { setFrom(""); setTo(""); setState(""); setCity(""); setDealerId(""); setNbfcId(""); setGroupBy("none"); }}>
                            Reset
                        </Button>
                        <a
                            href={csvHref}
                            download
                            className="inline-flex h-8 items-center justify-center rounded-lg border border-gray-300 bg-transparent px-3 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                            <Download className="mr-1 h-3.5 w-3.5" />
                            Export CSV
                        </a>
                    </div>
                </div>
                {d && (
                    <div className="border-t border-border px-4 py-2 text-[11px] text-ink-muted">
                        {d.filters.from} → {d.filters.to}. Defaults to the last 30 days.
                    </div>
                )}
            </div>

            {query.error && (
                <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    <AlertTriangle className="h-4 w-4" />
                    {(query.error as Error).message}
                </div>
            )}

            {!d && query.isLoading && (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy="true">
                    {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-2xl border border-border bg-bg/60" />)}
                </div>
            )}

            {d && (
                <>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <KPICard title="Dealers onboarded" value={fmt(d.totals.dealers_onboarded)} subtitle="applications approved" icon={ShieldCheck} />
                        <KPICard title="KYC files shared" value={fmt(d.totals.kyc_shared)} subtitle="leads entering KYC review" icon={FileCheck2} />
                        <KPICard title="Files disbursed" value={fmt(d.totals.files_disbursed)} subtitle="loan sanctions disbursed" icon={Wallet} />
                        <KPICard title="Files rejected" value={fmt(d.totals.files_rejected)} subtitle={`+ ${fmt(d.totals.onboarding_rejected)} onboarding rejected`} icon={XOctagon} />
                    </div>

                    {d.notes.length > 0 && (
                        <ul className="space-y-1 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
                            {d.notes.map((n) => (
                                <li key={n} className="flex items-start gap-2">
                                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                    <span>{n}</span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {groupBy !== "none" && (
                        <div className="rounded-xl border border-border bg-surface shadow-card">
                            <div className="px-4 py-3">
                                <h3 className="text-sm font-semibold text-ink">By {FUNNEL_GROUP_LABELS[groupBy].toLowerCase()}</h3>
                                <p className="text-[11px] text-ink-muted">Every column sums to the cards above.</p>
                            </div>
                            <div className="overflow-x-auto border-t border-border">
                                <table className="w-full min-w-[720px] text-sm">
                                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                                        <tr>
                                            <th className="px-4 py-2 text-left font-semibold">{FUNNEL_GROUP_LABELS[groupBy]}</th>
                                            <th className="px-4 py-2 text-right font-semibold">Onboarded</th>
                                            <th className="px-4 py-2 text-right font-semibold">KYC shared</th>
                                            <th className="px-4 py-2 text-right font-semibold">Disbursed</th>
                                            <th className="px-4 py-2 text-right font-semibold">Rejected</th>
                                            <th className="px-4 py-2 text-right font-semibold">Onboarding rejected</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                        {d.rows.length === 0 && (
                                            <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-muted">Nothing in this range.</td></tr>
                                        )}
                                        {d.rows.map((r) => (
                                            <tr key={r.key}>
                                                <td className="px-4 py-2 text-ink">{r.label}</td>
                                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.dealers_onboarded)}</td>
                                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.kyc_shared)}</td>
                                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.files_disbursed)}</td>
                                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.files_rejected)}</td>
                                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.onboarding_rejected)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <ReasonBars title="Loan rejection reasons" reasons={d.rejection_reasons} empty="No loan files were rejected in this range." />
                        <ReasonBars title="Onboarding rejection reasons" reasons={d.onboarding_rejection_reasons} empty="No onboarding applications were rejected in this range." />
                    </div>
                </>
            )}
        </div>
    );
}
