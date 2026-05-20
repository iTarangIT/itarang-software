"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import {
    AlertTriangle,
    ChevronLeft,
    ChevronRight,
    Inbox,
    Loader2,
    MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EscalationQueueRow } from "@/lib/admin/types";
import { UrgencyChip, humanize } from "./escalationUi";

type Props = {
    rows: EscalationQueueRow[];
    total: number;
    page: number;
    pageSize: number;
    loading: boolean;
    error: string | null;
    onPageChange: (p: number) => void;
    viewerRole: string;
};

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

export function EscalationQueueTable({
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    onPageChange,
}: Props) {
    const router = useRouter();
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
                            <th className="text-left px-4 py-3 font-semibold">Dealer</th>
                            <th className="text-left px-4 py-3 font-semibold">Reason</th>
                            <th className="text-left px-4 py-3 font-semibold">Urgency</th>
                            <th className="text-left px-4 py-3 font-semibold">Raised by</th>
                            <th className="text-left px-4 py-3 font-semibold">Raised</th>
                            <th className="text-left px-4 py-3 font-semibold">Owner</th>
                            <th className="text-left px-4 py-3 font-semibold">Outcome</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-4 py-12 text-center text-ink-muted">
                                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                                    Loading escalations…
                                </td>
                            </tr>
                        )}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-4 py-16 text-center text-ink-muted">
                                    <Inbox className="h-8 w-8 mx-auto mb-2" />
                                    No escalations here.
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => {
                            const href = `/admin/escalations/${row.escalation_id}`;
                            return (
                                <tr
                                    key={row.escalation_id}
                                    onClick={() => router.push(href)}
                                    className="cursor-pointer hover:bg-warning-bg/40 transition"
                                >
                                    <td className="px-4 py-3 align-top">
                                        <Link
                                            href={href}
                                            onClick={(e) => e.stopPropagation()}
                                            className="font-semibold text-warning hover:underline"
                                        >
                                            {row.dealer_name || "(unnamed dealer)"}
                                        </Link>
                                        <div className="text-[11px] text-ink-muted mt-0.5">
                                            {row.phone || "—"}
                                            {row.city ? ` · ${row.city}` : ""}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-top text-ink capitalize">
                                        {humanize(row.escalation_reason)}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <UrgencyChip urgency={row.urgency} />
                                    </td>
                                    <td className="px-4 py-3 align-top text-ink">
                                        {row.raised_by_name || "—"}
                                    </td>
                                    <td className="px-4 py-3 align-top text-xs text-ink-muted">
                                        {fmt(row.raised_at)}
                                    </td>
                                    <td className="px-4 py-3 align-top text-ink">
                                        {row.current_owner_name || "—"}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        {row.status === "pending_review" ? (
                                            row.has_ceo_input ? (
                                                <span className="inline-flex items-center gap-1 text-[11px] text-violet-700">
                                                    <MessageSquare className="h-3 w-3" />
                                                    CEO input
                                                </span>
                                            ) : (
                                                <span className="text-[11px] text-warning">
                                                    Pending
                                                </span>
                                            )
                                        ) : (
                                            <span className="text-[11px] text-ink-muted capitalize">
                                                {humanize(row.resolution_action)}
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
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
