"use client";

// BRD §0.11 — reports hub: 6-report picker, date-range filter, result table,
// CSV export.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    REPORT_LABELS,
    REPORT_TYPES,
    type ReportResult,
    type ReportType,
} from "@/lib/admin/types";
import { ReportChart } from "./ReportChart";
import { ReportTable } from "./ReportTable";
import { FunnelView } from "./FunnelView";

// B10 — the Funnel tab reads /api/admin/reports/funnel-counts, whose role gate
// is narrower than this page's, so the tab only renders for roles that would
// not get a 403 from it. The catalogue reports keep their own (wider) gate.
const FUNNEL_ROLES = new Set(["admin", "ceo", "business_head", "finance_controller", "sales_head"]);
const CATALOGUE_ROLES = new Set(["admin", "sales_head", "ceo", "partner"]);

type Tab = ReportType | "funnel";

export function ReportsView({ viewerRole }: { viewerRole: string }) {
    const canFunnel = FUNNEL_ROLES.has(viewerRole);
    const canCatalogue = CATALOGUE_ROLES.has(viewerRole);
    const [tab, setTab] = useState<Tab>(canCatalogue ? "daily_activity" : "funnel");
    const type: ReportType = tab === "funnel" ? "daily_activity" : tab;
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");

    const params = new URLSearchParams();
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);
    const qs = params.toString();

    const query = useQuery<{ success: true; data: ReportResult }>({
        enabled: tab !== "funnel",
        queryKey: ["admin-report", type, from, to],
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/reports/${type}${qs ? `?${qs}` : ""}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to run report");
            return res.json();
        },
    });
    const data = query.data?.data;

    const csvHref = `/api/admin/reports/${type}?format=csv${qs ? `&${qs}` : ""}`;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
                {canCatalogue && REPORT_TYPES.map((t) => (
                    <button
                        key={t}
                        type="button"
                        onClick={() => setTab(t)}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium border transition ${
                            tab === t
                                ? "bg-brand-600 text-white border-brand-600"
                                : "bg-surface text-ink-muted border-border hover:bg-bg"
                        }`}
                    >
                        {REPORT_LABELS[t]}
                    </button>
                ))}
                {canFunnel && (
                    <button
                        type="button"
                        onClick={() => setTab("funnel")}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium border transition ${
                            tab === "funnel"
                                ? "bg-brand-600 text-white border-brand-600"
                                : "bg-surface text-ink-muted border-border hover:bg-bg"
                        }`}
                    >
                        Funnel
                    </button>
                )}
            </div>

            {tab === "funnel" ? (
                <FunnelView />
            ) : (
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="px-4 py-3 border-b border-border flex flex-wrap items-end gap-3">
                    <div>
                        <label className="block text-[10px] font-medium uppercase tracking-wide text-ink-muted mb-1">
                            From
                        </label>
                        <input
                            type="date"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            className="h-9 rounded-md border border-border px-2 text-sm"
                        />
                    </div>
                    <div>
                        <label className="block text-[10px] font-medium uppercase tracking-wide text-ink-muted mb-1">
                            To
                        </label>
                        <input
                            type="date"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                            className="h-9 rounded-md border border-border px-2 text-sm"
                        />
                    </div>
                    <p className="text-xs text-ink-muted pb-2">
                        Defaults to the last 30 days when no range is set.
                    </p>
                    <div className="ml-auto pb-1">
                        <a href={csvHref} download>
                            <Button type="button" variant="outline" size="sm">
                                <Download className="h-3.5 w-3.5 mr-1" />
                                Export CSV
                            </Button>
                        </a>
                    </div>
                </div>

                <div className="p-1">
                    {query.isLoading && (
                        <div className="flex items-center justify-center py-12 text-ink-muted">
                            <Loader2 className="h-5 w-5 animate-spin mr-2" />
                            Running report…
                        </div>
                    )}
                    {query.error && (
                        <div className="flex items-center gap-2 p-4 text-sm text-danger">
                            <AlertTriangle className="h-4 w-4" />
                            {(query.error as Error).message}
                        </div>
                    )}
                    {data && (
                        <>
                            <ReportChart result={data} />
                            <div className="mt-3 border-t border-border">
                                <ReportTable result={data} />
                            </div>
                        </>
                    )}
                </div>
            </div>
            )}
        </div>
    );
}
