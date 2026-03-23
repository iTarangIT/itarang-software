'use client';

import React, { useState } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';

interface Column<T> {
    header: string;
    accessor: keyof T;
    render?: (value: unknown, row: T) => React.ReactNode;
    textRight?: boolean;
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

    // Filtering logic
    const filteredData = data.filter(row =>
        Object.values(row).some(val =>
            String(val).toLowerCase().includes(searchTerm.toLowerCase())
        )
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
                                <th
                                    key={i}
                                    className={`px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider ${col.textRight ? 'text-right' : ''}`}
                                >
                                    {col.header}
                                </th>
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
