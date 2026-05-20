"use client";

import Link from "next/link";
import {
    AlertTriangle,
    ChevronLeft,
    ChevronRight,
    GitMerge,
    Inbox,
    Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MERGE_ACTION_LABELS, type MergeRequestRow } from "@/lib/admin/types";

type Props = {
    rows: MergeRequestRow[];
    total: number;
    page: number;
    pageSize: number;
    loading: boolean;
    error: string | null;
    onPageChange: (p: number) => void;
    canResolve: boolean;
    onResolve: (row: MergeRequestRow) => void;
};

const humanize = (s: string | null | undefined) =>
    s ? s.replace(/_/g, " ") : "—";

function fmt(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleDateString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "short",
            year: "numeric",
        });
    } catch {
        return "—";
    }
}

export function MergeRequestTable({
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    onPageChange,
    canResolve,
    onResolve,
}: Props) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);

    return (
        <>
            {error && (
                <div className="px-4 py-6 text-sm text-danger bg-danger-bg/50 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    {error}
                </div>
            )}
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="text-left px-4 py-3 font-semibold">Target Lead</th>
                            <th className="text-left px-4 py-3 font-semibold">Type</th>
                            <th className="text-left px-4 py-3 font-semibold">Context</th>
                            <th className="text-left px-4 py-3 font-semibold">Created</th>
                            <th className="text-left px-4 py-3 font-semibold">Outcome</th>
                            <th className="px-4 py-3"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-4 py-12 text-center text-ink-muted">
                                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                                    Loading…
                                </td>
                            </tr>
                        )}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-4 py-16 text-center text-ink-muted">
                                    <Inbox className="h-8 w-8 mx-auto mb-2" />
                                    No merge requests here.
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => (
                            <tr key={row.id} className="hover:bg-bg/60">
                                <td className="px-4 py-3 align-top">
                                    <Link
                                        href={`/inside-sales/lead/${row.target_lead_id}`}
                                        className="font-semibold text-brand-700 hover:underline"
                                    >
                                        {row.target_dealer_name || "(unnamed)"}
                                    </Link>
                                    <div className="text-[11px] text-ink-muted mt-0.5">
                                        {row.target_phone || "—"}
                                    </div>
                                </td>
                                <td className="px-4 py-3 align-top">
                                    <span className="inline-flex items-center gap-1 text-xs text-ink capitalize">
                                        <GitMerge className="h-3 w-3 text-ink-muted" />
                                        {humanize(row.request_type)}
                                    </span>
                                </td>
                                <td className="px-4 py-3 align-top text-xs text-ink-muted max-w-sm">
                                    {row.request_notes || "—"}
                                </td>
                                <td className="px-4 py-3 align-top text-xs text-ink-muted">
                                    {fmt(row.created_at)}
                                </td>
                                <td className="px-4 py-3 align-top">
                                    {row.status === "pending" ? (
                                        <span className="text-[11px] text-warning">
                                            Pending
                                        </span>
                                    ) : (
                                        <span className="text-[11px] text-ink-muted capitalize">
                                            {MERGE_ACTION_LABELS[
                                                row.resolution_action ?? ""
                                            ] ?? humanize(row.status)}
                                        </span>
                                    )}
                                </td>
                                <td className="px-4 py-3 align-top text-right">
                                    {canResolve && row.status === "pending" && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => onResolve(row)}
                                        >
                                            Resolve
                                        </Button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="px-4 py-3 border-t border-border flex items-center justify-between">
                <span className="text-xs text-ink-muted">
                    {total === 0
                        ? "0 results"
                        : `Showing ${start}–${end} of ${total.toLocaleString("en-IN")}`}
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
                    <span className="text-xs text-ink-muted tabular-nums">
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
        </>
    );
}
