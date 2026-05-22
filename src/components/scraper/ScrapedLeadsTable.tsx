"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, MapPin, Search, X } from "lucide-react";

interface LeadRow {
    id: string;
    dealer_name: string;
    phone: string | null;
    // Falls back to city+state when the API can't find an upstream address.
    full_address: string | null;
    location_city: string | null;
    location_state: string | null;
    exploration_status: string;
    created_at: string;
    scraper_run_id: string;
}

interface LeadsResponse {
    data: LeadRow[];
    meta: { total: number; limit: number; offset: number };
}

interface Props {
    runId?: string; // optional filter by run
}

type SortKey =
    | "created_at_desc"
    | "created_at_asc"
    | "dealer_name_asc"
    | "dealer_name_desc"
    | "status_asc";

const STATUS_OPTIONS = [
    { value: "", label: "All statuses" },
    { value: "unassigned", label: "Unassigned" },
    { value: "assigned", label: "Assigned" },
    { value: "in_review", label: "In review" },
    { value: "promoted", label: "Promoted" },
    { value: "rejected", label: "Rejected" },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
    { value: "created_at_desc", label: "Newest first" },
    { value: "created_at_asc", label: "Oldest first" },
    { value: "dealer_name_asc", label: "Name A→Z" },
    { value: "dealer_name_desc", label: "Name Z→A" },
    { value: "status_asc", label: "Status" },
];

const PAGE_SIZE = 25;

// Tiny debounce hook so we don't fire a request on every keystroke.
function useDebounced<T>(value: T, ms = 250): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return debounced;
}

export function ScrapedLeadsTable({ runId }: Props) {
    const [page, setPage] = useState(1);
    const [searchInput, setSearchInput] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [sort, setSort] = useState<SortKey>("created_at_desc");
    const search = useDebounced(searchInput, 250);

    // Reset to page 1 whenever any filter changes — otherwise filtering on
    // page 4 of an old result set with 0 matching rows looks broken.
    useEffect(() => {
        setPage(1);
    }, [search, statusFilter, sort, runId]);

    const offset = (page - 1) * PAGE_SIZE;

    const queryKey = [
        "scraper-leads",
        runId ?? "all",
        search,
        statusFilter,
        sort,
        page,
    ];

    const { data, isLoading, error } = useQuery<LeadsResponse>({
        queryKey,
        queryFn: async () => {
            const params = new URLSearchParams({
                limit: String(PAGE_SIZE),
                offset: String(offset),
                sort,
            });
            if (runId) params.set("run_id", runId);
            if (search) params.set("search", search);
            if (statusFilter) params.set("status", statusFilter);
            const res = await fetch(`/api/scraper/leads?${params}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return { data: json.data ?? [], meta: json.meta ?? { total: 0, limit: PAGE_SIZE, offset } };
        },
        placeholderData: (prev) => prev, // keep table populated while filters change
    });

    const leads = data?.data ?? [];
    const total = data?.meta.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const hasFiltersActive = useMemo(
        () => !!(search || statusFilter),
        [search, statusFilter],
    );

    const showFromIndex = total === 0 ? 0 : offset + 1;
    const showToIndex = Math.min(offset + leads.length, total);

    return (
        <>
            {/* Toolbar: search + status filter + sort */}
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                    <input
                        type="text"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        placeholder="Search by name, phone, or city..."
                        className="w-full pl-9 pr-9 py-2 text-sm border border-gray-200 rounded-xl bg-white outline-none focus:border-gray-400"
                    />
                    {searchInput && (
                        <button
                            onClick={() => setSearchInput("")}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                            aria-label="Clear search"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="text-sm border border-gray-200 rounded-xl bg-white px-3 py-2 outline-none focus:border-gray-400"
                >
                    {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
                <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    className="text-sm border border-gray-200 rounded-xl bg-white px-3 py-2 outline-none focus:border-gray-400"
                >
                    {SORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </div>

            {error ? (
                <p className="text-sm text-red-500 bg-red-50 rounded-xl p-4">
                    Failed to load leads.
                </p>
            ) : isLoading && !data ? (
                <div className="space-y-2">
                    {[1, 2, 3, 4].map((i) => (
                        <div
                            key={i}
                            className="h-14 bg-gray-100 animate-pulse rounded-xl"
                        />
                    ))}
                </div>
            ) : leads.length === 0 ? (
                <div className="text-center py-10 text-gray-400 text-sm">
                    {hasFiltersActive ? (
                        <>
                            No leads match your filters.{" "}
                            <button
                                onClick={() => {
                                    setSearchInput("");
                                    setStatusFilter("");
                                }}
                                className="text-teal-600 hover:underline"
                            >
                                Clear filters
                            </button>
                        </>
                    ) : (
                        "No scraped leads found."
                    )}
                </div>
            ) : (
                <div className="overflow-auto rounded-xl border border-gray-100 max-h-[70vh]">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 z-10 bg-gray-50 text-gray-500 text-xs uppercase tracking-wider shadow-sm">
                            <tr>
                                <th className="px-4 py-3 text-left font-medium w-1/4">
                                    Dealer
                                </th>
                                <th className="px-4 py-3 text-left font-medium w-[160px]">
                                    Phone
                                </th>
                                <th className="px-4 py-3 text-left font-medium">
                                    Location
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 bg-white">
                            {leads.map((lead) => {
                                const addressFallback = [
                                    lead.location_city,
                                    lead.location_state,
                                ]
                                    .filter(Boolean)
                                    .join(", ");
                                const address =
                                    lead.full_address || addressFallback || "";
                                return (
                                    <tr
                                        key={lead.id}
                                        className="hover:bg-gray-50/50 transition-colors align-top"
                                    >
                                        <td className="px-4 py-3.5">
                                            <span className="font-medium text-gray-900">
                                                {lead.dealer_name}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3.5">
                                            {lead.phone ? (
                                                <a
                                                    href={`tel:${lead.phone}`}
                                                    className="inline-flex items-center gap-1.5 text-teal-600 hover:text-teal-700"
                                                >
                                                    <Phone className="w-3.5 h-3.5" />
                                                    <span className="text-xs">{lead.phone}</span>
                                                </a>
                                            ) : (
                                                <span className="text-gray-400 text-xs">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3.5">
                                            {address ? (
                                                <span className="flex items-start gap-1.5 text-gray-600 text-xs whitespace-normal break-words">
                                                    <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                                                    <span>{address}</span>
                                                </span>
                                            ) : (
                                                <span className="text-gray-400 text-xs">—</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Pagination bar — always render once we have a non-error state
                so the user knows the total count even when on page 1. */}
            {!error && (isLoading ? data : true) && total > 0 && (
                <div className="flex items-center justify-between mt-4">
                    <p className="text-xs text-gray-500">
                        Showing {showFromIndex}–{showToIndex} of {total}
                        {hasFiltersActive && " (filtered)"}
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page === 1}
                            className="px-3 py-1 border rounded-lg text-sm disabled:opacity-50 cursor-pointer"
                        >
                            Previous
                        </button>
                        <span className="text-sm text-gray-600">
                            Page {page} of {totalPages}
                        </span>
                        <button
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page >= totalPages}
                            className="px-3 py-1 border rounded-lg text-sm disabled:opacity-50 cursor-pointer"
                        >
                            Next
                        </button>
                    </div>
                </div>
            )}

        </>
    );
}
