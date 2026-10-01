"use client";

// The Ecofy leads list (E-307 list redesign): one card with a tab strip, a
// search box, a Filters disclosure, Download CSV and a paginated table — the
// same shape as the ASM "My Visits" queue (AsmQueueView), so ASM / ISR / Sales
// Head work Ecofy leads the way they work their own queue.
//
// The Sales Head additionally selects rows and assigns / reassigns them
// (EcofyAssignBar). Workers see only their own leads — the server enforces
// that; this component just never offers the queue tab or the owner filter.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { QueueCsvButton } from "@/components/leads/QueueCsvButton";
import type { EcofyViewerKind } from "@/lib/ecofy/access";
import {
    ECOFY_FILTER_KEYS,
    ECOFY_LIST_PAGE_SIZE,
    ecofyTabsFor,
    type EcofyFilterKey,
    type EcofyListCounts,
    type EcofyListResponse,
    type EcofyListTab,
} from "@/lib/ecofy/listTypes";
import { EcofyAssignBar } from "./EcofyAssignBar";
import { countEcofyFilters, EMPTY_ECOFY_FILTERS, EcofyLeadsFilters, type EcofyFilterValues } from "./EcofyLeadsFilters";
import { EcofyLeadsTable } from "./EcofyLeadsTable";
import { EcofyLeadsTabs } from "./EcofyLeadsTabs";

type Props = {
    kind: EcofyViewerKind;
    /** Where a row opens: `${hrefBase}/${leadId}`. */
    hrefBase: string;
    /** The tab the page starts on when the URL names none. */
    initialTab: EcofyListTab;
    viewerId: string;
};

async function getJson<T>(path: string, search: string): Promise<T> {
    const u = new URL(path, window.location.origin);
    u.search = search;
    const res = await fetch(u.toString(), { cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
    return json.data as T;
}

export function EcofyLeadsWorkspace({ kind, hrefBase, initialTab, viewerId }: Props) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const queryClient = useQueryClient();
    const manager = kind === "manager";
    const tabs = useMemo(() => ecofyTabsFor(kind), [kind]);

    const parseTab = (raw: string | null): EcofyListTab => (raw && (tabs as string[]).includes(raw) ? (raw as EcofyListTab) : initialTab);
    const readFilters = (sp: URLSearchParams): EcofyFilterValues => {
        const out = { ...EMPTY_ECOFY_FILTERS };
        for (const k of ECOFY_FILTER_KEYS) out[k] = (k === "assignee" && !manager ? "" : sp.get(k)) ?? "";
        return out;
    };

    // Seeded from the URL so a filtered view survives a reload and can be
    // pasted to a colleague — the same contract the queues have.
    const [tab, setTab] = useState<EcofyListTab>(() => parseTab(params.get("tab")));
    const [page, setPage] = useState(() => Math.max(1, Number(params.get("page") ?? "1")));
    const [search, setSearch] = useState(params.get("q") ?? "");
    const [searchDebounced, setSearchDebounced] = useState(params.get("q") ?? "");
    const [filters, setFilters] = useState<EcofyFilterValues>(() => readFilters(new URLSearchParams(params.toString())));
    // Open on load when any filter arrived in the URL, so a filter inherited
    // from a pasted link is never doing invisible work.
    const [filtersOpen, setFiltersOpen] = useState(() => countEcofyFilters(readFilters(new URLSearchParams(params.toString()))) > 0);

    /** Everything that narrows the list, as query params — ONE builder for the rows, the badges and the CSV. */
    const filterKey = useMemo(() => {
        const p = new URLSearchParams();
        if (searchDebounced) p.set("q", searchDebounced);
        for (const k of ECOFY_FILTER_KEYS) if (filters[k]) p.set(k, filters[k]);
        return p.toString();
    }, [searchDebounced, filters]);

    useEffect(() => {
        const next = new URLSearchParams(filterKey);
        if (tab !== initialTab) next.set("tab", tab);
        if (page !== 1) next.set("page", String(page));
        const qs = next.toString();
        router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    }, [tab, page, filterKey, router, pathname, initialTab]);

    useEffect(() => {
        const t = window.setTimeout(() => {
            setSearchDebounced(search);
            setPage(1);
        }, 300);
        return () => window.clearTimeout(t);
    }, [search]);

    const patchFilter = useCallback((key: EcofyFilterKey, value: string) => {
        setFilters((f) => ({ ...f, [key]: value }));
        setPage(1);
    }, []);
    const resetFilters = useCallback(() => {
        setFilters(EMPTY_ECOFY_FILTERS);
        setPage(1);
    }, []);

    const countsQuery = useQuery<EcofyListCounts>({
        // The filters are part of the key: the badges narrow with the list.
        queryKey: ["ecofy-list-counts", filterKey],
        queryFn: () => getJson<EcofyListCounts>("/api/ecofy/leads/counts", filterKey),
        refetchInterval: 30_000,
    });

    const rowsQuery = useQuery<EcofyListResponse>({
        queryKey: ["ecofy-list", tab, page, filterKey],
        queryFn: () => {
            const p = new URLSearchParams(filterKey);
            p.set("tab", tab);
            p.set("page", String(page));
            p.set("limit", String(ECOFY_LIST_PAGE_SIZE));
            return getJson<EcofyListResponse>("/api/ecofy/leads", p.toString());
        },
    });
    const data = rowsQuery.data;

    // ── Sales Head: select rows → assign / reassign ─────────────────────
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const selectionScope = `${tab}|${filterKey}`;
    const [selectionScopeSeen, setSelectionScopeSeen] = useState(selectionScope);
    if (selectionScopeSeen !== selectionScope) {
        // A tab or filter change drops the selection; paging keeps it.
        setSelectionScopeSeen(selectionScope);
        setSelectedIds(new Set());
    }
    const toggleSelected = useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);
    const toggleAllOnPage = useCallback(() => {
        const pageRows = data?.rows ?? [];
        setSelectedIds((prev) => {
            const next = new Set(prev);
            const allTicked = pageRows.length > 0 && pageRows.every((r) => next.has(r.id));
            if (allTicked) pageRows.forEach((r) => next.delete(r.id));
            else pageRows.forEach((r) => next.add(r.id));
            return next;
        });
    }, [data]);
    const selectedRows = useMemo(() => (data?.rows ?? []).filter((r) => selectedIds.has(r.id)), [data, selectedIds]);
    const refreshAfterAssign = useCallback(() => {
        setSelectedIds(new Set());
        queryClient.invalidateQueries({ queryKey: ["ecofy-list"] });
        queryClient.invalidateQueries({ queryKey: ["ecofy-list-counts"] });
        router.refresh();
    }, [queryClient, router]);

    const exportHref = useMemo(() => {
        const p = new URLSearchParams(filterKey);
        p.set("tab", tab);
        return `/api/ecofy/leads/export?${p.toString()}`;
    }, [filterKey, tab]);

    return (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
            <EcofyLeadsTabs
                kind={kind}
                active={tab}
                counts={countsQuery.data ?? null}
                onChange={(t) => {
                    setTab(t);
                    setPage(1);
                }}
            />
            <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-4 py-3">
                <div className="relative min-w-[220px] flex-1 md:max-w-md">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, case no., mobile or city…" className="pl-9" />
                </div>
                <EcofyLeadsFilters
                    values={filters}
                    onChange={patchFilter}
                    onReset={resetFilters}
                    open={filtersOpen}
                    onToggle={() => setFiltersOpen((v) => !v)}
                    showOwner={manager}
                />
                {rowsQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                <div className="ml-auto flex items-center gap-2">
                    <QueueCsvButton href={exportHref} filename={`ecofy-${tab}`} disabled={rowsQuery.isLoading} />
                </div>
            </div>
            <EcofyLeadsTable
                tab={tab}
                rows={data?.rows ?? []}
                total={data?.total ?? 0}
                page={page}
                pageSize={ECOFY_LIST_PAGE_SIZE}
                loading={rowsQuery.isLoading}
                error={rowsQuery.error ? (rowsQuery.error as Error).message : null}
                onPageChange={setPage}
                hrefBase={hrefBase}
                viewerId={viewerId}
                showOwner={manager}
                selection={manager ? { selected: selectedIds, onToggle: toggleSelected, onToggleAll: toggleAllOnPage } : undefined}
            />
            {manager && <EcofyAssignBar leadIds={[...selectedIds]} reassign={selectedRows.some((r) => r.assignedTo)} onDone={refreshAfterAssign} />}
        </div>
    );
}
