"use client";

// Admin Dashboard client shell — owns the Zone-4 filter state and fetches all
// four zones in one /api/admin/dashboard call (BRD §0.11).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardFilters, DashboardResponse } from "@/lib/admin/types";
import { DashboardFilterBar } from "./DashboardFilterBar";
import { KpiStrip } from "./KpiStrip";
import { TeamPerformanceTable } from "./TeamPerformanceTable";
import { AlertPanels } from "./AlertPanels";

export function buildFilterQuery(f: DashboardFilters): string {
    const p = new URLSearchParams();
    if (f.date_from) p.set("date_from", f.date_from);
    if (f.date_to) p.set("date_to", f.date_to);
    if (f.owner_id) p.set("owner_id", f.owner_id);
    if (f.status) p.set("status", f.status);
    if (f.source) p.set("source", f.source);
    if (f.segment) p.set("segment", f.segment);
    if (f.city) p.set("city", f.city);
    if (f.state) p.set("state", f.state);
    if (f.follow_up_due_today) p.set("follow_up_due_today", "true");
    if (f.reactivated_only) p.set("reactivated_only", "true");
    return p.toString();
}

export function AdminDashboardView({ readOnly }: { readOnly: boolean }) {
    const [filters, setFilters] = useState<DashboardFilters>({});
    const qs = useMemo(() => buildFilterQuery(filters), [filters]);

    const query = useQuery<{ success: true; data: DashboardResponse }>({
        queryKey: ["admin-dashboard", qs],
        queryFn: async () => {
            const res = await fetch(
                `/api/admin/dashboard${qs ? `?${qs}` : ""}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error("Failed to load dashboard");
            return res.json();
        },
        refetchInterval: 60_000,
    });

    const data = query.data?.data;

    return (
        <div className="space-y-5">
            <DashboardFilterBar filters={filters} onApply={setFilters} />

            {query.isLoading && <DashboardSkeleton />}

            {query.error && (
                <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-bg p-4">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-danger" />
                    <div className="text-sm text-danger">
                        {(query.error as Error).message}
                    </div>
                </div>
            )}

            {data && (
                <>
                    <KpiStrip kpis={data.kpis} />
                    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]">
                        <TeamPerformanceTable rows={data.team} />
                        <AlertPanels
                            counts={data.alert_counts}
                            filterQs={qs}
                        />
                    </div>
                </>
            )}

            {readOnly && (
                <p className="text-xs text-ink-muted">
                    Read-only view — bulk actions and settings are admin-only
                    (BRD §0.12).
                </p>
            )}
        </div>
    );
}

function DashboardSkeleton() {
    return (
        <div className="space-y-5">
            <KpiSkeletonRow cols="xl:grid-cols-5" tiles={5} />
            <KpiSkeletonRow cols="xl:grid-cols-4" tiles={4} />
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.5fr_1fr]">
                <Skeleton className="h-80 rounded-xl" />
                <Skeleton className="h-80 rounded-xl" />
            </div>
        </div>
    );
}

function KpiSkeletonRow({ cols, tiles }: { cols: string; tiles: number }) {
    return (
        <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${cols}`}>
            {Array.from({ length: tiles }).map((_, i) => (
                <div
                    key={i}
                    className="rounded-xl border border-border bg-surface p-4 shadow-card"
                >
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="mt-3 h-7 w-1/2" />
                </div>
            ))}
        </div>
    );
}
