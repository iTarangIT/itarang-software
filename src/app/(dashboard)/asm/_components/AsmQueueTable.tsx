"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    ChevronLeft,
    ChevronRight,
    Inbox as InboxIcon,
    Loader2,
    Phone,
    AlertTriangle,
    CalendarCheck2,
    CalendarX2,
    CalendarClock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/app/(dashboard)/inside-sales/_components/StatusChip";
import { IntentBadge } from "@/app/(dashboard)/inside-sales/_components/IntentBadge";
import { InterestChip } from "@/app/(dashboard)/inside-sales/_components/InterestChip";
import { OwnerIndicator } from "@/app/(dashboard)/inside-sales/_components/OwnerIndicator";
import type { AsmQueueRow, AsmQueueTab, VisitStatus } from "@/lib/asm/types";

type Props = {
    tab: AsmQueueTab;
    rows: AsmQueueRow[];
    total: number;
    page: number;
    pageSize: number;
    loading: boolean;
    error: string | null;
    onPageChange: (p: number) => void;
    viewerId: string;
};

const VISIT_STATUS_LABEL: Record<VisitStatus, { label: string; bg: string; text: string; border: string }> = {
    pending_scheduling: { label: "Needs scheduling", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },
    scheduled: { label: "Scheduled", bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-200" },
    visited: { label: "Visited", bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" },
    postponed: { label: "Postponed", bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200" },
    cancelled: { label: "Cancelled", bg: "bg-gray-50", text: "text-gray-600", border: "border-gray-200" },
    no_show: { label: "No show", bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200" },
};

function VisitStatusChip({ status }: { status: VisitStatus | null | undefined }) {
    if (!status) return <span className="text-xs text-gray-400">—</span>;
    const c = VISIT_STATUS_LABEL[status];
    return (
        <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${c.bg} ${c.text} ${c.border}`}>
            {c.label}
        </span>
    );
}

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "short", day: "2-digit" });
    } catch {
        return "—";
    }
}

export function AsmQueueTable({
    tab,
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    onPageChange,
    viewerId,
}: Props) {
    const router = useRouter();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);

    return (
        <>
            {error && (
                <div className="px-4 py-6 text-sm text-rose-700 bg-rose-50/50 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    {error}
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-gray-50/50 text-[11px] uppercase tracking-wide text-gray-500">
                        <tr>
                            <th className="text-left px-4 py-3 font-semibold">Dealer / Shop</th>
                            <th className="text-left px-4 py-3 font-semibold">Phone</th>
                            <th className="text-left px-4 py-3 font-semibold">Region</th>
                            <th className="text-left px-4 py-3 font-semibold">Lead Status</th>
                            <th className="text-left px-4 py-3 font-semibold">Visit</th>
                            <th className="text-left px-4 py-3 font-semibold">Scheduled</th>
                            <th className="text-left px-4 py-3 font-semibold">Interest / AI</th>
                            <th className="text-left px-4 py-3 font-semibold">Owner</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                                    Loading queue…
                                </td>
                            </tr>
                        )}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={8} className="px-4 py-16 text-center text-gray-400">
                                    <InboxIcon className="h-8 w-8 mx-auto mb-2" />
                                    {tab === "today"
                                        ? "No visits scheduled for today."
                                        : tab === "territory"
                                            ? "No leads in your territory yet."
                                            : tab === "my_closed"
                                                ? "No closed leads in the last 90 days."
                                                : "No active visits yet."}
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => {
                            const href = `/asm/lead/${encodeURIComponent(row.id)}`;
                            return (
                                <tr
                                    key={row.id}
                                    onClick={() => router.push(href)}
                                    className="cursor-pointer hover:bg-emerald-50/40 transition"
                                >
                                    <td className="px-4 py-3 align-top">
                                        <Link
                                            href={href}
                                            onClick={(e) => e.stopPropagation()}
                                            className="font-semibold text-emerald-700 hover:underline"
                                        >
                                            {row.dealer_name || row.shop_name || "(unnamed dealer)"}
                                        </Link>
                                        {row.shop_name && row.dealer_name && (
                                            <div className="text-[11px] text-gray-500 mt-0.5">{row.shop_name}</div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-gray-700 tabular-nums align-top">
                                        <span className="inline-flex items-center gap-1">
                                            <Phone className="h-3 w-3 text-gray-400" />
                                            {row.phone || "—"}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-gray-700 align-top">
                                        {row.city || "—"}
                                        {row.state && <div className="text-[11px] text-gray-500">{row.state}</div>}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <StatusChip status={row.lead_status} />
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <VisitStatusChip status={row.visit_status} />
                                    </td>
                                    <td className="px-4 py-3 align-top text-xs text-gray-700">
                                        {row.scheduled_date ? (
                                            <span className="inline-flex items-center gap-1">
                                                <CalendarClock className="h-3 w-3 text-gray-400" />
                                                {fmtDate(row.scheduled_date)}
                                            </span>
                                        ) : row.actual_visit_date ? (
                                            <span className="inline-flex items-center gap-1 text-emerald-700">
                                                <CalendarCheck2 className="h-3 w-3" />
                                                {fmtDate(row.actual_visit_date)}
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 text-gray-400">
                                                <CalendarX2 className="h-3 w-3" />
                                                —
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <div className="flex items-center gap-1.5">
                                            <InterestChip level={row.interest_level} />
                                            <IntentBadge score={row.final_intent_score} size="sm" />
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <OwnerIndicator
                                            currentOwnerId={row.current_owner_id}
                                            currentOwnerName={row.current_owner_name}
                                            viewerId={viewerId}
                                            asmName={row.asm_name}
                                        />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs text-gray-500">
                    {total === 0 ? "0 results" : `Showing ${start}–${end} of ${total.toLocaleString("en-IN")}`}
                </span>
                <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1 || loading}>
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs text-gray-600 tabular-nums">
                        Page {page} / {totalPages}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages || loading}>
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </>
    );
}
