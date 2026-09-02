"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Loader2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateLeadModal } from "@/app/(dashboard)/inside-sales/_components/modals/CreateLeadModal";
import {
    QueueFilterBar,
    QueueFilterField,
    QUEUE_SELECT_CLASS,
} from "@/components/leads/QueueFilterBar";
import { QueueCsvButton } from "@/components/leads/QueueCsvButton";
import {
    EMPTY_QUEUE_FILTERS,
    hasAnyQueueFilter,
    readQueueFilters,
    writeQueueFilters,
    type QueueFilters,
    type QueueRegion,
} from "@/lib/leads/queueFilters";
import {
    EMPTY_QUEUE_SORT,
    hasQueueSort,
    readQueueSort,
    writeQueueSort,
    type QueueSort,
} from "@/lib/leads/queueSort";
import { AsmQueueTabs } from "./AsmQueueTabs";
import { AsmQueueTable } from "./AsmQueueTable";
import {
    ASM_QUEUE_TABS,
    VISIT_OUTCOME,
    VISIT_OUTCOME_LABELS,
    VISIT_STATUS,
    type AsmQueueCounts,
    type AsmQueueResponse,
    type AsmQueueTab,
    type VisitOutcome,
} from "@/lib/asm/types";

type Props = {
    viewerId: string;
};

const PAGE_SIZE = 25;

function parseTab(raw: string | null): AsmQueueTab {
    if (raw && (ASM_QUEUE_TABS as readonly string[]).includes(raw)) return raw as AsmQueueTab;
    return "my_visits";
}

/** `pending_scheduling` → `Pending Scheduling`. */
function pretty(v: string): string {
    return v.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AsmQueueView({ viewerId }: Props) {
    const router = useRouter();
    const params = useSearchParams();
    const queryClient = useQueryClient();
    const [tab, setTab] = useState<AsmQueueTab>(parseTab(params.get("tab")));
    const [page, setPage] = useState(Math.max(1, Number(params.get("page") ?? "1")));
    const [search, setSearch] = useState(params.get("q") ?? "");
    const [searchDebounced, setSearchDebounced] = useState(params.get("q") ?? "");
    const [createOpen, setCreateOpen] = useState(false);
    // Seeded from the URL so a filtered view survives a reload and can be
    // pasted to a colleague — the same contract the tab and page already had.
    const [filters, setFilters] = useState<QueueFilters>(() =>
        readQueueFilters(new URLSearchParams(params.toString())),
    );
    // Order, seeded from the URL like the filters so a sorted view survives a
    // reload and can be pasted to a colleague.
    const [sort, setSort] = useState<QueueSort>(() =>
        readQueueSort(new URLSearchParams(params.toString())),
    );
    const [visitStatus, setVisitStatus] = useState(() => {
        const v = params.get("visit_status") ?? "";
        return (VISIT_STATUS as readonly string[]).includes(v) ? v : "";
    });
    const [visitOutcome, setVisitOutcome] = useState(() => {
        const v = params.get("visit_outcome") ?? "";
        return (VISIT_OUTCOME as readonly string[]).includes(v) ? v : "";
    });
    // Open on load when ANY filter arrived in the URL, so a filter inherited
    // from a pasted link is never doing invisible work. Derived from the parsed
    // values rather than from param names, so it cannot fall out of step with
    // the filter set.
    const [filtersOpen, setFiltersOpen] = useState(
        () =>
            hasAnyQueueFilter(readQueueFilters(new URLSearchParams(params.toString()))) ||
            hasQueueSort(readQueueSort(new URLSearchParams(params.toString()))) ||
            params.get("visit_status") !== null ||
            params.get("visit_outcome") !== null,
    );

    const extraActive = (visitStatus ? 1 : 0) + (visitOutcome ? 1 : 0);

    /**
     * Everything that narrows the list, as query params.
     *
     * ONE BUILDER for the rows request, the badge counts and the CSV href, so
     * the sheet is exactly what the screen is showing. `page` is deliberately
     * absent — the counts and the export both span the whole result set.
     */
    const filterParams = useMemo(() => {
        const p = new URLSearchParams();
        if (searchDebounced) p.set("q", searchDebounced);
        if (visitStatus) p.set("visit_status", visitStatus);
        if (visitOutcome) p.set("visit_outcome", visitOutcome);
        // The sort rides along: the rows and the CSV honour it, the counts and
        // facets simply never read it.
        writeQueueSort(p, sort);
        return writeQueueFilters(p, filters);
    }, [searchDebounced, visitStatus, visitOutcome, filters, sort]);

    const filterKey = filterParams.toString();

    useEffect(() => {
        const next = new URLSearchParams(filterKey);
        if (tab !== "my_visits") next.set("tab", tab);
        if (page !== 1) next.set("page", String(page));
        const qs = next.toString();
        router.replace(`/asm${qs ? `?${qs}` : ""}`, { scroll: false });
    }, [tab, page, filterKey, router]);

    useEffect(() => {
        const t = window.setTimeout(() => {
            setSearchDebounced(search);
            setPage(1);
        }, 300);
        return () => window.clearTimeout(t);
    }, [search]);

    const patchFilter = useCallback((key: keyof QueueFilters, value: string) => {
        setFilters((f) => ({ ...f, [key]: value }));
        setPage(1);
    }, []);

    const patchSort = useCallback((next: QueueSort) => {
        setSort(next);
        setPage(1);
    }, []);

    const resetFilters = useCallback(() => {
        setFilters(EMPTY_QUEUE_FILTERS);
        setSort(EMPTY_QUEUE_SORT);
        setVisitStatus("");
        setVisitOutcome("");
        setPage(1);
    }, []);

    const countsQuery = useQuery<{ success: true; data: AsmQueueCounts }>({
        // The filters are part of the key: the badges narrow with the list, so a
        // cached unfiltered count must not be shown above a filtered table.
        queryKey: ["asm-counts", filterKey],
        queryFn: async () => {
            const u = new URL("/api/asm/queue/counts", window.location.origin);
            u.search = filterKey;
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load tab counts");
            return res.json();
        },
        refetchInterval: 30000,
    });
    const counts = countsQuery.data?.data;

    // The State/City options this tab's leads actually span. Keyed on the tab
    // alone and cached for the session: the options describe the queue, not the
    // current filter, so re-fetching them as the filter changes would cost a
    // DISTINCT scan per keystroke to return the same list.
    const regionsQuery = useQuery<{ success: true; data: { regions: QueueRegion[] } }>({
        queryKey: ["asm-queue-regions", tab],
        queryFn: async () => {
            const u = new URL("/api/asm/queue/facets", window.location.origin);
            u.searchParams.set("tab", tab);
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load regions");
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
    });
    const regions = regionsQuery.data?.data?.regions ?? [];

    const rowsQuery = useQuery<{ success: true; data: AsmQueueResponse }>({
        queryKey: ["asm-queue", tab, page, filterKey],
        queryFn: async () => {
            const u = new URL("/api/asm/queue", window.location.origin);
            u.search = filterKey;
            u.searchParams.set("tab", tab);
            u.searchParams.set("page", String(page));
            u.searchParams.set("limit", String(PAGE_SIZE));
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load queue");
            return res.json();
        },
    });

    const data = rowsQuery.data?.data;

    const exportHref = useMemo(() => {
        const p = new URLSearchParams(filterKey);
        p.set("tab", tab);
        return `/api/asm/queue/export?${p.toString()}`;
    }, [filterKey, tab]);

    return (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
            <AsmQueueTabs
                active={tab}
                counts={counts ?? null}
                onChange={(t) => {
                    setTab(t);
                    setPage(1);
                }}
            />
            <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-4 py-3">
                <div className="relative min-w-[220px] flex-1 md:max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by dealer, shop, or phone…"
                        className="pl-9"
                    />
                </div>
                <QueueFilterBar
                    values={filters}
                    onChange={patchFilter}
                    onReset={resetFilters}
                    open={filtersOpen}
                    onToggle={() => setFiltersOpen((v) => !v)}
                    regions={regions}
                    // Not "created": an ASM's range question is which visits fall
                    // in the window, and the queue filters on the visit date.
                    dateLabel="Visit"
                    extraActiveCount={extraActive}
                    sort={sort}
                    onSortChange={patchSort}
                >
                    <QueueFilterField label="Visit status">
                        <select
                            value={visitStatus}
                            onChange={(e) => {
                                setVisitStatus(e.target.value);
                                setPage(1);
                            }}
                            className={QUEUE_SELECT_CLASS}
                        >
                            <option value="">Any visit status</option>
                            {VISIT_STATUS.map((v) => (
                                <option key={v} value={v}>
                                    {pretty(v)}
                                </option>
                            ))}
                        </select>
                    </QueueFilterField>
                    <QueueFilterField label="Visit outcome">
                        <select
                            value={visitOutcome}
                            onChange={(e) => {
                                setVisitOutcome(e.target.value);
                                setPage(1);
                            }}
                            className={QUEUE_SELECT_CLASS}
                        >
                            <option value="">Any outcome</option>
                            {VISIT_OUTCOME.map((v) => (
                                <option key={v} value={v}>
                                    {VISIT_OUTCOME_LABELS[v as VisitOutcome]}
                                </option>
                            ))}
                        </select>
                    </QueueFilterField>
                </QueueFilterBar>
                {rowsQuery.isFetching && (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                )}
                <div className="ml-auto flex items-center gap-2">
                    <QueueCsvButton
                        href={exportHref}
                        filename={`asm-${tab}`}
                        disabled={rowsQuery.isLoading}
                    />
                    <Button type="button" onClick={() => setCreateOpen(true)} className="gap-1.5">
                        <Plus className="h-4 w-4" />
                        Create Lead
                    </Button>
                </div>
            </div>
            <AsmQueueTable
                tab={tab}
                rows={data?.rows ?? []}
                total={data?.total ?? 0}
                page={page}
                pageSize={PAGE_SIZE}
                loading={rowsQuery.isLoading}
                error={rowsQuery.error ? (rowsQuery.error as Error).message : null}
                onPageChange={setPage}
                viewerId={viewerId}
            />
            <CreateLeadModal
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                onSuccess={() => {
                    setCreateOpen(false);
                    queryClient.invalidateQueries({ queryKey: ["asm-queue"] });
                    queryClient.invalidateQueries({ queryKey: ["asm-counts"] });
                }}
            />
        </div>
    );
}
