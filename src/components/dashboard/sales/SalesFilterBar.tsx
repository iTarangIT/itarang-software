"use client";

// B7 — one row of controls above everything they affect. State and city are
// selects fed by /api/locations/regions (the same reference lists the queue
// filter bars use); the rep picker only renders on the admin screen.

import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BUSINESS_TYPE_OPTIONS, BUSINESS_TYPE_UNSET } from "@/lib/leads/businessType";
import { SALES_DASHBOARD_GRANULARITIES } from "@/lib/admin/salesDashboardTypes";
import type { UserOption } from "@/lib/admin/types";
import type { RegionsResponse } from "@/app/api/locations/regions/route";
import type { SalesFilterKey, SalesFilters } from "./useSalesDashboardFilters";

type Props = {
    filters: SalesFilters;
    onChange: (key: SalesFilterKey, value: string) => void;
    onReset: () => void;
    dirty: boolean;
    fetching: boolean;
    /** Admin only: show the rep picker. */
    showSpoc: boolean;
    /** Full URL of the CSV for the current filters. */
    csvHref: string;
    /** Resolved window + as-of line, once the data is in. */
    summary?: string | null;
};

const INPUT =
    "h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink outline-none focus:border-brand-teal";
const LABEL = "block text-[10px] font-medium uppercase tracking-wide text-ink-muted mb-1";

const GRANULARITY_LABEL: Record<string, string> = { day: "Day", week: "Week", month: "Month" };

export function SalesFilterBar({
    filters,
    onChange,
    onReset,
    dirty,
    fetching,
    showSpoc,
    csvHref,
    summary,
}: Props) {
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
    // Leads store the state NAME; the reference list keys cities by CODE.
    const selectedCode = states.find((s) => s.name === filters.state)?.code;
    const cities = selectedCode
        ? (citiesByState[selectedCode] ?? [])
        : Array.from(new Set(Object.values(citiesByState).flat())).sort();

    const reps = useQuery<{ success: true; data: { users: UserOption[] } }>({
        queryKey: ["admin-user-options", "sales-dashboard-reps"],
        queryFn: async () => {
            const res = await fetch(
                "/api/admin/users?roles=asm,inside_sales_rep,sales_manager,sales_head,partner",
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load reps");
            return res.json();
        },
        enabled: showSpoc,
        staleTime: 5 * 60 * 1000,
    });
    const repOptions = reps.data?.data.users ?? [];

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex flex-wrap items-end gap-3 px-4 py-3">
                <div>
                    <label className={LABEL}>From</label>
                    <input type="date" value={filters.from} onChange={(e) => onChange("from", e.target.value)} className={INPUT} />
                </div>
                <div>
                    <label className={LABEL}>To</label>
                    <input type="date" value={filters.to} onChange={(e) => onChange("to", e.target.value)} className={INPUT} />
                </div>
                <div>
                    <label className={LABEL}>Granularity</label>
                    <div role="group" aria-label="Granularity" className="inline-flex h-9 overflow-hidden rounded-md border border-border">
                        {SALES_DASHBOARD_GRANULARITIES.map((g) => {
                            const active = filters.granularity === g;
                            return (
                                <button
                                    key={g}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => onChange("granularity", g)}
                                    className={`px-3 text-sm font-medium transition ${
                                        active
                                            ? "bg-brand-600 text-white"
                                            : "bg-surface text-ink-muted hover:bg-bg"
                                    }`}
                                >
                                    {GRANULARITY_LABEL[g]}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div>
                    <label className={LABEL}>State</label>
                    <select value={filters.state} onChange={(e) => onChange("state", e.target.value)} className={`${INPUT} min-w-[150px]`}>
                        <option value="">Any state</option>
                        {states.map((s) => (
                            <option key={s.code} value={s.name}>{s.name}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className={LABEL}>City</label>
                    <select value={filters.city} onChange={(e) => onChange("city", e.target.value)} className={`${INPUT} min-w-[150px]`}>
                        <option value="">Any city</option>
                        {cities.map((c) => (
                            <option key={c} value={c}>{c}</option>
                        ))}
                    </select>
                </div>
                {showSpoc && (
                    <div>
                        <label className={LABEL}>SPOC</label>
                        <select value={filters.spoc_id} onChange={(e) => onChange("spoc_id", e.target.value)} className={`${INPUT} min-w-[180px]`}>
                            <option value="">Whole team</option>
                            {repOptions.map((r) => (
                                <option key={r.user_id} value={r.user_id}>{r.name ?? r.email}</option>
                            ))}
                        </select>
                    </div>
                )}
                <div>
                    <label className={LABEL}>Business type</label>
                    <select value={filters.business_type} onChange={(e) => onChange("business_type", e.target.value)} className={INPUT}>
                        <option value="">Any</option>
                        {BUSINESS_TYPE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                        <option value={BUSINESS_TYPE_UNSET}>Not set</option>
                    </select>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {fetching && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
                    <Button type="button" variant="outline" size="sm" onClick={onReset} disabled={!dirty}>
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        Reset
                    </Button>
                    <a
                        href={csvHref}
                        download
                        className="inline-flex h-8 items-center justify-center rounded-lg border border-gray-300 bg-transparent px-3 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        <Download className="mr-1 h-3.5 w-3.5" />
                        Download CSV
                    </a>
                </div>
            </div>
            {summary && (
                <div className="border-t border-border px-4 py-2 text-[11px] text-ink-muted">{summary}</div>
            )}
        </div>
    );
}
