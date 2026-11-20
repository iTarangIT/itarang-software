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
import { useUrlTableSort, type SortSpec } from "@/components/shared/TableSort";

const PAGE_SIZE = 25;

// ID 243 — header sort, kept in the page link and done by the API (the list is
// paged). Keys match CONVERTED_SORT_KEYS in lib/sales-insight/types.ts.
const CONVERTED_SORT: SortSpec<unknown>[] = [
    { key: "source", type: "text" },
    { key: "name", type: "text" },
    { key: "region", type: "text" },
    { key: "dealer", type: "text" },
    { key: "converted", type: "date" },
    { key: "intent", type: "number" },
];

function serializeFilters(f: ConvertedFilters): string {
    const params = new URLSearchParams();
    if (f.from_date) params.set("from_date", f.from_date);
    if (f.to_date) params.set("to_date", f.to_date);
    if (f.region) params.set("region", f.region);
    if (f.dealer_id) params.set("dealer_id", f.dealer_id);
    if (f.search) params.set("search", f.search);
    params.set("page", String(f.page ?? 1));
    params.set("limit", String(f.limit ?? PAGE_SIZE));
    if (f.sort) {
        params.set("sort", f.sort.key);
        params.set("dir", f.sort.dir);
    }
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

    const { sort, toggle: toggleSort } = useUrlTableSort(CONVERTED_SORT, { mode: "server" });
    // A new order starts from the first page.
    const sortQs = sort ? `${sort.key}:${sort.dir}` : "";
    const [pagedFor, setPagedFor] = useState(sortQs);
    if (pagedFor !== sortQs) {
        setPagedFor(sortQs);
        setFilters((f) => ({ ...f, page: 1 }));
    }
    const sorted: ConvertedFilters = {
        ...filters,
        sort: sort ? { key: sort.key as NonNullable<ConvertedFilters["sort"]>["key"], dir: sort.dir } : null,
    };

    const query = useQuery<ConvertedListResponse>({
        queryKey: ["sales-insight-converted", sorted],
        queryFn: async () => {
            const res = await fetch(`/api/sales-insight/converted?${serializeFilters(sorted)}`, {
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Failed to load converted leads");
            return res.json();
        },
        placeholderData: (prev) => prev,
    });

    const handleExport = () => {
        const url = `/api/sales-insight/converted/export?${serializeFilters({ ...sorted, page: 1, limit: 50_000 })}`;
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
                sort={sort}
                onSort={toggleSort}
            />

            <DrillDrawer row={drawerRow} onClose={() => setDrawerRow(null)} />
        </div>
    );
}
