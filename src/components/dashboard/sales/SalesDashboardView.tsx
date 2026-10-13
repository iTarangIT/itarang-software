"use client";

// B7 — the sales dashboard screen. Shared by /admin/reports/sales-dashboard
// (whole team: SPOC picker + per-SPOC table), /asm/performance and
// /inside-sales/performance (the logged-in rep only). `mode` picks the
// endpoint and whether the rep controls render; everything else is one
// component so the screens cannot disagree about what a number means.
//
// Filter state lives in the URL (useSalesDashboardFilters) so a view can be
// refreshed or pasted into WhatsApp. The same query string is the fetch URL.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Inbox } from "lucide-react";

import type { SalesDashboard } from "@/lib/admin/salesDashboardTypes";
import { TEAM_TOTAL_PERSON } from "@/lib/users/teamRules";
import { SalesCharts, bucketLabel } from "./SalesCharts";
import { SalesDashboardSkeleton } from "./SalesDashboardSkeleton";
import { SalesFilterBar } from "./SalesFilterBar";
import { SalesInterestTable } from "./SalesInterestTable";
import { SalesKpiRow } from "./SalesKpiRow";
import { SalesOutcomeStrip } from "./SalesOutcomeStrip";
import { SalesPerRepTable } from "./SalesPerRepTable";
import { useSalesDashboardFilters } from "./useSalesDashboardFilters";

export type SalesDashboardMode = "admin" | "asm" | "isr";

export const SALES_DASHBOARD_ENDPOINT: Record<SalesDashboardMode, string> = {
    admin: "/api/admin/reports/sales-dashboard",
    asm: "/api/asm/reports/sales-dashboard",
    isr: "/api/inside-sales/reports/sales-dashboard",
};

/** True when nothing in the range or the open pipeline has a non-zero count. */
function hasNoData(d: SalesDashboard): boolean {
    const s = d.snapshot;
    return (
        d.series.every((r) => !r.visits && !r.calls) &&
        d.interest.rows.every((r) => !r.total) &&
        !s.visits_yesterday && !s.calls_yesterday &&
        !s.planned_visits_today && !s.planned_visits_next_7_days &&
        !d.totals.converted &&
        !d.outcome.quotes_issued && !d.outcome.revenue &&
        !d.outcome.batteries_to_dealers && !d.outcome.kyc_submitted &&
        (d.per_spoc?.length ?? 0) === 0
    );
}

export function SalesDashboardView({
    mode,
    people,
}: {
    mode: SalesDashboardMode;
    /**
     * ID 155/156: a manager on their own Performance page — themself first,
     * then their direct reports. With more than one, a person picker shows and
     * the pick is sent as ?person= (the API ignores anyone outside the team).
     */
    people?: Array<{ id: string; name: string }>;
}) {
    const isAdmin = mode === "admin";
    const { filters, granularity, qs: filterQs, set, reset, dirty } = useSalesDashboardFilters(isAdmin);
    const endpoint = SALES_DASHBOARD_ENDPOINT[mode];
    const [personId, setPersonId] = useState("");
    const showPeople = !isAdmin && (people?.length ?? 0) > 1;
    const qs = showPeople && personId ? [filterQs, `person=${encodeURIComponent(personId)}`].filter(Boolean).join("&") : filterQs;

    const query = useQuery<{ success: true; data: SalesDashboard }>({
        queryKey: ["sales-dashboard", mode, qs],
        queryFn: async () => {
            const res = await fetch(`${endpoint}${qs ? `?${qs}` : ""}`, { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to load the sales dashboard");
            }
            return json;
        },
        placeholderData: (prev) => prev,
    });
    const d = query.data?.data;
    const csvHref = `${endpoint}?${qs ? `${qs}&` : ""}format=csv`;

    const summary = d
        ? `${bucketLabel(d.filters.from, "day")} → ${bucketLabel(d.filters.to, "day")} · ${d.averages.days_in_range} days · as of ${bucketLabel(d.as_of_date, "day")} (IST)`
        : null;

    return (
        <div className="space-y-4">
            {showPeople && (
                <label className="flex items-center gap-2 text-sm text-gray-700">
                    <span className="font-medium">Showing</span>
                    <select
                        value={personId}
                        onChange={(e) => setPersonId(e.target.value)}
                        className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
                        aria-label="Whose numbers to show"
                    >
                        {people!.map((p, i) => (
                            <option key={p.id} value={i === 0 ? "" : p.id}>
                                {i === 0 ? `Me (${p.name})` : p.name}
                            </option>
                        ))}
                        {/* ID 156: me + the whole team, the same builder over the group. */}
                        <option value={TEAM_TOTAL_PERSON}>Team total</option>
                    </select>
                </label>
            )}
            <SalesFilterBar
                filters={filters}
                onChange={set}
                onReset={reset}
                dirty={dirty}
                fetching={query.isFetching}
                showSpoc={isAdmin}
                csvHref={csvHref}
                summary={summary}
            />

            {query.error && (
                <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    <AlertTriangle className="h-4 w-4" />
                    {(query.error as Error).message}
                </div>
            )}

            {!d && query.isLoading && <SalesDashboardSkeleton withPerRep={isAdmin && !filters.spoc_id} />}

            {d && (
                <>
                    <SalesKpiRow d={d} />

                    {hasNoData(d) ? (
                        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center">
                            <Inbox className="h-8 w-8 text-ink-muted" />
                            <p className="text-sm font-medium text-ink">No data for these filters</p>
                            <p className="text-xs text-ink-muted">
                                Widen the date range or clear the city, state or business type filter.
                            </p>
                        </div>
                    ) : (
                        <>
                            <SalesOutcomeStrip d={d} />
                            <SalesCharts series={d.series} averages={d.averages} granularity={granularity} />
                            <SalesInterestTable d={d.interest} />
                            {isAdmin && d.per_spoc && (
                                <SalesPerRepTable reps={d.per_spoc} unassigned={d.unassigned} onPick={(id) => set("spoc_id", id)} />
                            )}
                        </>
                    )}
                </>
            )}
        </div>
    );
}
