"use client";

// Free-text search is debounced by 300ms so each keystroke doesn't trigger
// a re-fetch; date/region/dealer inputs commit on change. All filters
// share a single onChange callback to keep state-ownership in the parent.

import { useEffect, useState } from "react";
import { Search, Download, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ConvertedFilters } from "@/lib/sales-insight/types";

type Props = {
    filters: ConvertedFilters;
    onChange: (filters: ConvertedFilters) => void;
    onExport: () => void;
    disabled?: boolean;
};

export function FiltersBar({ filters, onChange, onExport, disabled }: Props) {
    const [searchDraft, setSearchDraft] = useState(filters.search ?? "");

    useEffect(() => {
        const handle = window.setTimeout(() => {
            if ((filters.search ?? "") !== searchDraft) {
                onChange({ ...filters, search: searchDraft || null });
            }
        }, 300);
        return () => window.clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchDraft]);

    const setField = <K extends keyof ConvertedFilters>(key: K, value: ConvertedFilters[K]) => {
        onChange({ ...filters, [key]: value });
    };

    const reset = () => {
        setSearchDraft("");
        onChange({
            ...filters,
            from_date: null,
            to_date: null,
            region: null,
            dealer_id: null,
            search: null,
        });
    };

    const hasAny = Boolean(
        filters.from_date || filters.to_date || filters.region || filters.dealer_id || filters.search,
    );

    return (
        <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
            <div className="grid gap-3 md:grid-cols-12 items-end">
                <div className="md:col-span-3">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Search</label>
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <Input
                            type="text"
                            value={searchDraft}
                            onChange={(e) => setSearchDraft(e.target.value)}
                            placeholder="Name or phone"
                            disabled={disabled}
                            className="pl-9"
                        />
                    </div>
                </div>

                <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
                    <Input
                        type="date"
                        value={filters.from_date ?? ""}
                        onChange={(e) => setField("from_date", e.target.value || null)}
                        disabled={disabled}
                    />
                </div>

                <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
                    <Input
                        type="date"
                        value={filters.to_date ?? ""}
                        onChange={(e) => setField("to_date", e.target.value || null)}
                        disabled={disabled}
                    />
                </div>

                <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Region</label>
                    <Input
                        type="text"
                        value={filters.region ?? ""}
                        onChange={(e) => setField("region", e.target.value || null)}
                        placeholder="e.g. Maharashtra"
                        disabled={disabled}
                    />
                </div>

                <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Dealer ID</label>
                    <Input
                        type="text"
                        value={filters.dealer_id ?? ""}
                        onChange={(e) => setField("dealer_id", e.target.value || null)}
                        placeholder="Exact match"
                        disabled={disabled}
                    />
                </div>

                <div className="md:col-span-1 flex gap-2 justify-end">
                    <Button
                        type="button"
                        variant="outline"
                        size="md"
                        onClick={onExport}
                        disabled={disabled}
                        className="whitespace-nowrap"
                    >
                        <Download className="h-4 w-4 mr-1" />
                        CSV
                    </Button>
                </div>
            </div>

            {hasAny && (
                <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between">
                    <span className="text-xs text-gray-500">Filters active</span>
                    <button
                        type="button"
                        onClick={reset}
                        className="text-xs text-gray-600 hover:text-gray-900 inline-flex items-center gap-1"
                    >
                        <X className="h-3 w-3" />
                        Clear all
                    </button>
                </div>
            )}
        </div>
    );
}
