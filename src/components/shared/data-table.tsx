'use client';

import React, { useMemo, useState } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { SortableTh, sortRows, useTableSort, type SortSpec, type SortType } from './TableSort';

interface Column<T> {
    header: string;
    accessor: keyof T;
    render?: (value: unknown, row: T) => React.ReactNode;
    textRight?: boolean;
    /** ID 243 — false for a column whose value is not worth ordering by. */
    sortable?: boolean;
    /** ID 243 — how to compare; guessed from the first filled value when left out. */
    sortType?: SortType;
}

// ID 243 — a number column opens largest first, a date newest first, text A to Z.
function guessSortType<T>(data: T[], key: keyof T): SortType {
    const v = data.map((r) => r[key]).find((x) => x != null && x !== '');
    if (typeof v === 'number') return 'number';
    if (v instanceof Date) return 'date';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
    return 'text';
}

interface DataTableProps<T> {
    title?: string;
    description?: string;
    columns: Column<T>[];
    data: T[];
    searchPlaceholder?: string;
    icon?: React.ReactNode;
    pageSize?: number;
}

export function DataTable<T extends Record<string, unknown>>({
    title,
    description,
    columns,
    data,
    searchPlaceholder = "Search...",
    icon,
    pageSize = 10
}: DataTableProps<T>) {
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);

    // ID 243 — click a header to sort, again to reverse, a third time for the
    // list's own order. The rows are all in hand (paged here), so the sort is
    // applied before paging: page 2 carries on the same order. Blanks stay last.
    const sortSpecs = useMemo<SortSpec<T>[]>(
        () =>
            columns
                .filter((c) => c.sortable !== false)
                .map((c) => ({
                    key: String(c.accessor),
                    type: c.sortType ?? guessSortType(data, c.accessor),
                    value: (row: T) => row[c.accessor],
                })),
        [columns, data],
    );
    const { sort, toggle, comparator } = useTableSort(sortSpecs);
    const onSort = (key: string) => {
        toggle(key);
        setCurrentPage(1);
    };

    // Filtering logic
    const filteredData = sortRows(
        data.filter(row =>
            Object.values(row).some(val =>
                String(val).toLowerCase().includes(searchTerm.toLowerCase())
            )
        ),
        comparator,
    );

    // Pagination logic
    const totalPages = Math.ceil(filteredData.length / pageSize);
    const startIndex = (currentPage - 1) * pageSize;
    const paginatedData = filteredData.slice(startIndex, startIndex + pageSize);

    return (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden h-full flex flex-col">
            <div className="p-6 border-b border-slate-100 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                        <h3 className="text-lg font-semibold flex items-center gap-2">
                            {icon}
                            {title}
                        </h3>
                        {description && <p className="text-sm text-slate-500">{description}</p>}
                    </div>

                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                            type="text"
                            placeholder={searchPlaceholder}
                            className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 w-full sm:w-64 transition-all"
                            value={searchTerm}
                            onChange={(e) => {
                                setSearchTerm(e.target.value);
                                setCurrentPage(1);
                            }}
                        />
                    </div>
                </div>
            </div>

            <div className="overflow-x-auto flex-1">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                            {columns.map((col, i) => (
                                <SortableTh
                                    key={i}
                                    label={col.header}
                                    sortKey={col.sortable === false ? undefined : String(col.accessor)}
                                    sort={sort}
                                    onToggle={onSort}
                                    align={col.textRight ? 'right' : undefined}
                                    className={`px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider ${col.textRight ? 'text-right' : ''}`}
                                />
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {paginatedData.length > 0 ? (
                            paginatedData.map((row, rowIndex) => (
                                <tr key={rowIndex} className="hover:bg-slate-50 transition-colors group">
                                    {columns.map((col, colIndex) => (
                                        <td
                                            key={colIndex}
                                            className={`px-6 py-4 text-sm text-slate-600 ${col.textRight ? 'text-right' : ''}`}
                                        >
                                            {col.render ? col.render(row[col.accessor], row) : String(row[col.accessor] ?? '')}
                                        </td>
                                    ))}
                                </tr>
                            ))
                        ) : (
                            <tr>
                                <td colSpan={columns.length} className="px-6 py-12 text-center text-slate-400 italic">
                                    No records found matching your search.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {totalPages > 1 && (
                <div className="p-4 border-t border-slate-100 flex items-center justify-between bg-slate-50/50">
                    <p className="text-sm text-slate-500">
                        Showing <span className="font-medium">{startIndex + 1}</span> to <span className="font-medium">{Math.min(startIndex + pageSize, filteredData.length)}</span> of <span className="font-medium">{filteredData.length}</span> results
                    </p>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                            disabled={currentPage === 1}
                            className="p-2 border border-slate-200 rounded-lg hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                            disabled={currentPage === totalPages}
                            className="p-2 border border-slate-200 rounded-lg hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
