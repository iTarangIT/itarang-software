"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, MapPin, Search, X } from "lucide-react";

interface RawLeadRow {
    id: string;
    dealer_name: string;
    phone: string | null;
    address: string | null;
    email: string | null;
    website: string | null;
    source: string | null;
    was_saved: boolean;
    created_at: string | null;
}

interface RawLeadsResponse {
    data: RawLeadRow[];
    meta: { total: number; limit: number; page: number };
}

interface Props {
    runId: string;
}

const PAGE_SIZE = 50;

function useDebounced<T>(value: T, ms = 250): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return debounced;
}

export function RawLeadsTable({ runId }: Props) {
    const [page, setPage] = useState(1);
    const [searchInput, setSearchInput] = useState("");
    const search = useDebounced(searchInput, 250);

    useEffect(() => {
        setPage(1);
    }, [search, runId]);

    const { data, isLoading, error } = useQuery<RawLeadsResponse>({
        queryKey: ["scraper-raw-leads", runId, search, page],
        queryFn: async () => {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(PAGE_SIZE),
            });
            if (search) params.set("search", search);
            const res = await fetch(
                `/api/scraper/runs/${runId}/raw-leads?${params}`,
            );
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return {
                data: json.data ?? [],
                meta: json.meta ?? { total: 0, limit: PAGE_SIZE, page: 1 },
            };
        },
        placeholderData: (prev) => prev,
    });

    const rows = data?.data ?? [];
    const total = data?.meta.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const showFromIndex = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const showToIndex = Math.min(page * PAGE_SIZE, total);

    return (
        <>
            <div className="flex items-center gap-3 mb-4">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                    <input
                        type="text"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        placeholder="Search by name, phone, or address..."
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
            </div>

            {error ? (
                <p className="text-sm text-red-500 bg-red-50 rounded-xl p-4">
                    Failed to load raw leads.
                </p>
            ) : isLoading && !data ? (
                <div className="space-y-2">
                    {[1, 2, 3, 4, 5].map((i) => (
                        <div
                            key={i}
                            className="h-14 bg-gray-100 animate-pulse rounded-xl"
                        />
                    ))}
                </div>
            ) : rows.length === 0 ? (
                <div className="text-center py-10 text-gray-400 text-sm">
                    {search
                        ? "No raw leads match your search."
                        : "No raw leads recorded for this run."}
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
                                    Address
                                </th>
                                <th className="px-4 py-3 text-left font-medium w-[110px]">
                                    Status
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 bg-white">
                            {rows.map((row) => (
                                <tr
                                    key={row.id}
                                    className="hover:bg-gray-50/50 transition-colors align-top"
                                >
                                    <td className="px-4 py-3.5">
                                        <span className="font-medium text-gray-900">
                                            {row.dealer_name}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3.5">
                                        {row.phone ? (
                                            <a
                                                href={`tel:${row.phone}`}
                                                className="inline-flex items-center gap-1.5 text-teal-600 hover:text-teal-700"
                                            >
                                                <Phone className="w-3.5 h-3.5" />
                                                <span className="text-xs">{row.phone}</span>
                                            </a>
                                        ) : (
                                            <span className="text-gray-400 text-xs">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3.5">
                                        {row.address ? (
                                            <span className="flex items-start gap-1.5 text-gray-600 text-xs whitespace-normal break-words">
                                                <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                                                <span>{row.address}</span>
                                            </span>
                                        ) : (
                                            <span className="text-gray-400 text-xs">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3.5">
                                        <span
                                            className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                                                row.was_saved
                                                    ? "bg-green-100 text-green-700"
                                                    : "bg-gray-100 text-gray-500"
                                            }`}
                                        >
                                            {row.was_saved ? "Saved" : "Skipped"}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {!error && total > 0 && (
                <div className="flex items-center justify-between mt-4">
                    <p className="text-xs text-gray-500">
                        Showing {showFromIndex}–{showToIndex} of {total}
                        {search && " (filtered)"}
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
                            onClick={() =>
                                setPage((p) => Math.min(totalPages, p + 1))
                            }
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
