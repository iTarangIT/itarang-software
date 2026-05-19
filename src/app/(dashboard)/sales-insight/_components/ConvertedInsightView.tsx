"use client";

// Owner of the filter state for the sales-insight page. Filters live here
// so the KPIs and the table share the same fetch — when a filter changes,
// both update from one /converted response and can never disagree.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConvertedFilters, ConvertedListResponse, ConvertedRow } from "@/lib/sales-insight/types";
import { KpiCards } from "./KpiCards";
import { FiltersBar } from "./FiltersBar";
import { ConvertedTable } from "./ConvertedTable";
import { DrillDrawer } from "./DrillDrawer";

const PAGE_SIZE = 25;

function serializeFilters(f: ConvertedFilters): string {
    const params = new URLSearchParams();
    if (f.from_date) params.set("from_date", f.from_date);
    if (f.to_date) params.set("to_date", f.to_date);
    if (f.region) params.set("region", f.region);
    if (f.dealer_id) params.set("dealer_id", f.dealer_id);
    if (f.search) params.set("search", f.search);
    params.set("page", String(f.page ?? 1));
    params.set("limit", String(f.limit ?? PAGE_SIZE));
    return params.toString();
}

export function ConvertedInsightView() {
    const [filters, setFilters] = useState<ConvertedFilters>({
        from_date: null,
        to_date: null,
        region: null,
        dealer_id: null,
        search: null,
        page: 1,
        limit: PAGE_SIZE,
    });

    const [drawerRow, setDrawerRow] = useState<ConvertedRow | null>(null);

    const query = useQuery<ConvertedListResponse>({
        queryKey: ["sales-insight-converted", filters],
        queryFn: async () => {
            const res = await fetch(`/api/sales-insight/converted?${serializeFilters(filters)}`, {
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Failed to load converted leads");
            return res.json();
        },
        placeholderData: (prev) => prev,
    });

    const handleExport = () => {
        const url = `/api/sales-insight/converted/export?${serializeFilters({ ...filters, page: 1, limit: 50_000 })}`;
        window.location.href = url;
    };

    return (
        <div className="space-y-6">
            <KpiCards kpis={query.data?.kpis} loading={query.isLoading} />

            <FiltersBar
                filters={filters}
                onChange={(next) => setFilters({ ...next, page: 1 })}
                onExport={handleExport}
                disabled={query.isLoading}
            />

            <ConvertedTable
                rows={query.data?.rows ?? []}
                total={query.data?.total ?? 0}
                page={filters.page ?? 1}
                pageSize={filters.limit ?? PAGE_SIZE}
                loading={query.isLoading}
                error={query.error?.message ?? null}
                onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
                onRowClick={(row) => setDrawerRow(row)}
            />

            <DrillDrawer row={drawerRow} onClose={() => setDrawerRow(null)} />
        </div>
    );
}
