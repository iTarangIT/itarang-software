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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusChip } from "./StatusChip";
import { IntentBadge } from "./IntentBadge";
import { InterestChip } from "./InterestChip";
import { OwnerIndicator } from "./OwnerIndicator";
import { NeodoveTag } from "@/components/leads/neodove-tag";
import { SentByStamp } from "@/components/leads/sent-by-stamp";
import { staleSeverity, workingDaysSince } from "@/lib/inside-sales/staleness";
import type { QueueRow, QueueTab } from "@/lib/inside-sales/types";

type Props = {
    tab: QueueTab;
    rows: QueueRow[];
    total: number;
    page: number;
    pageSize: number;
    loading: boolean;
    error: string | null;
    onPageChange: (p: number) => void;
    viewerId: string;
    holidaySet: Set<string>;
};

const STALE_ROW_BG: Record<ReturnType<typeof staleSeverity>, string> = {
    normal: "",
    yellow: "bg-amber-50/40",
    red: "bg-rose-50/50",
    critical: "bg-rose-100/70 font-medium",
};

const STALE_DAY_CHIP: Record<ReturnType<typeof staleSeverity>, string> = {
    normal: "text-gray-600",
    yellow: "text-amber-700 font-semibold",
    red: "text-rose-700 font-semibold",
    critical: "text-rose-900 font-bold",
};

function formatRelative(iso: string | null): string {
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

export function LeadQueueTable({
    tab,
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    onPageChange,
    viewerId,
    holidaySet,
}: Props) {
    const router = useRouter();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    // Pin "now" once per render so the follow-up-overdue test is pure inside
    // the map callback (react-hooks/purity).
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();

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
                            <th className="text-left px-4 py-3 font-semibold">Status</th>
                            <th className="text-left px-4 py-3 font-semibold">Interest / AI</th>
                            <th className="text-left px-4 py-3 font-semibold">Owner</th>
                            <th className="text-left px-4 py-3 font-semibold">Last Touch</th>
                            <th className="text-left px-4 py-3 font-semibold">Follow-up</th>
                            <th className="text-right px-4 py-3 font-semibold">Days Idle</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                                    Loading queue…
                                </td>
                            </tr>
                        )}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={9} className="px-4 py-16 text-center text-gray-400">
                                    <InboxIcon className="h-8 w-8 mx-auto mb-2" />
                                    {tab === "unassigned"
                                        ? "No leads waiting to be claimed."
                                        : tab === "follow_ups"
                                            ? "No follow-ups due today. Nicely done."
                                            : tab === "my_closed"
                                                ? "No closed leads in the last 90 days."
                                                : "No leads in this view."}
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => {
                            const days = workingDaysSince(row.last_touchpoint_at ?? row.assigned_at, holidaySet);
                            const sev = staleSeverity(days);
                            const followUpOverdue =
                                row.next_follow_up_at && new Date(row.next_follow_up_at).getTime() < nowMs;
                            const href = `/inside-sales/lead/${encodeURIComponent(row.id)}`;
                            return (
                                <tr
                                    key={row.id}
                                    onClick={() => router.push(href)}
                                    className={`cursor-pointer hover:bg-blue-50/40 transition ${STALE_ROW_BG[sev]}`}
                                >
                                    <td className="px-4 py-3 align-top">
                                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                            <Link
                                                href={href}
                                                onClick={(e) => e.stopPropagation()}
                                                className="font-semibold text-blue-700 hover:underline"
                                            >
                                                {row.dealer_name || row.shop_name || "(unnamed dealer)"}
                                            </Link>
                                            {/* Renders nothing unless the lead is actually with the
                                                calling team — see NeodoveTag. */}
                                            <NeodoveTag syncStatus={row.neodove_sync_status} />
                                        </div>
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
                                        {row.state && (
                                            <div className="text-[11px] text-gray-500">{row.state}</div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <StatusChip status={row.lead_status} />
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
                                        />
                                        {/* Under the owner, because the pair is the
                                            sentence: recipient above, sender below. */}
                                        <SentByStamp
                                            assignedBy={row.assigned_by}
                                            currentOwnerId={row.current_owner_id}
                                        />
                                    </td>
                                    <td className="px-4 py-3 text-gray-700 align-top text-xs">
                                        {formatRelative(row.last_touchpoint_at)}
                                    </td>
                                    <td className="px-4 py-3 align-top text-xs">
                                        <span className={followUpOverdue ? "text-rose-700 font-semibold" : "text-gray-700"}>
                                            {formatRelative(row.next_follow_up_at)}
                                        </span>
                                    </td>
                                    <td className={`px-4 py-3 align-top text-right text-xs tabular-nums ${STALE_DAY_CHIP[sev]}`}>
                                        {days === null ? "—" : days}
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
