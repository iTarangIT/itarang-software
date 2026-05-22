"use client";

import { ChevronLeft, ChevronRight, Loader2, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConvertedRow } from "@/lib/sales-insight/types";

type Props = {
    rows: ConvertedRow[];
    total: number;
    page: number;
    pageSize: number;
    loading: boolean;
    error: string | null;
    onPageChange: (page: number) => void;
    onRowClick: (row: ConvertedRow) => void;
};

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function SourceBadge({ source }: { source: ConvertedRow["source"] }) {
    const isAi = source === "ai_dialer";
    return (
        <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                isAi
                    ? "bg-purple-50 text-purple-700 border border-purple-200"
                    : "bg-blue-50 text-blue-700 border border-blue-200"
            }`}
        >
            {isAi ? "AI Dialer" : "B2B"}
        </span>
    );
}

function IntentChip({ score }: { score: number | null }) {
    if (score === null || score === undefined) return <span className="text-gray-400">—</span>;
    const color =
        score >= 85
            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
            : score >= 75
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : "bg-gray-50 text-gray-600 border-gray-200";
    return (
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium border ${color}`}>
            {score}
        </span>
    );
}

export function ConvertedTable({
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    onPageChange,
    onRowClick,
}: Props) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);

    return (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-800">
                    Converted Leads
                    <span className="ml-2 text-gray-400 font-normal">
                        {loading ? "loading…" : `${total.toLocaleString("en-IN")} total`}
                    </span>
                </h2>
                {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
            </div>

            {error && (
                <div className="px-4 py-6 text-sm text-red-600">{error}</div>
            )}

            {!error && (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50/50 text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Source</th>
                                <th className="text-left px-4 py-3 font-medium">Name</th>
                                <th className="text-left px-4 py-3 font-medium">Phone</th>
                                <th className="text-left px-4 py-3 font-medium">Region</th>
                                <th className="text-left px-4 py-3 font-medium">Dealer</th>
                                <th className="text-left px-4 py-3 font-medium">Converted</th>
                                <th className="text-left px-4 py-3 font-medium">Intent</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.length === 0 && !loading ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-16 text-center text-gray-400">
                                        <Inbox className="h-8 w-8 mx-auto mb-2" />
                                        No converted leads match these filters.
                                    </td>
                                </tr>
                            ) : (
                                rows.map((row) => (
                                    <tr
                                        key={row.id}
                                        className="hover:bg-blue-50/30 cursor-pointer transition-colors"
                                        onClick={() => onRowClick(row)}
                                    >
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-1.5">
                                                <SourceBadge source={row.source} />
                                                {row.also_in.length > 0 && (
                                                    <span
                                                        className="text-[10px] uppercase tracking-wider text-gray-400"
                                                        title={`Also present in: ${row.also_in.join(", ")}`}
                                                    >
                                                        +{row.also_in.length}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 font-medium text-gray-900">{row.display_name}</td>
                                        <td className="px-4 py-3 text-gray-700 tabular-nums">{row.phone || "—"}</td>
                                        <td className="px-4 py-3 text-gray-700">{row.region ?? "—"}</td>
                                        <td className="px-4 py-3 text-gray-700">{row.dealer_id ?? "—"}</td>
                                        <td className="px-4 py-3 text-gray-700 tabular-nums">{formatDate(row.converted_at)}</td>
                                        <td className="px-4 py-3"><IntentChip score={row.intent_score} /></td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs text-gray-500">
                    {total === 0 ? "0 results" : `Showing ${start}–${end} of ${total.toLocaleString("en-IN")}`}
                </span>
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onPageChange(page - 1)}
                        disabled={page <= 1 || loading}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs text-gray-600 tabular-nums">
                        Page {page} / {totalPages}
                    </span>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onPageChange(page + 1)}
                        disabled={page >= totalPages || loading}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
}
