"use client";

// The Ecofy leads table — laid out and styled like the ASM "My Visits" table
// (AsmQueueTable): uppercase grey head, emerald name link, row click opens the
// lead, loading / empty rows, "Showing x–y of N" with Prev / Next.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, Inbox as InboxIcon, Loader2, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OwnerIndicator } from "@/app/(dashboard)/inside-sales/_components/OwnerIndicator";
import { ECOFY_ROLE_LABEL } from "@/lib/ecofy/access";
import { ECOFY_TAB_EMPTY, type EcofyListRow, type EcofyListTab } from "@/lib/ecofy/listTypes";
import { formatIst, formatQueueAge, StageBadge, TemperatureBadge } from "./badges";

type Props = {
    tab: EcofyListTab;
    rows: EcofyListRow[];
    total: number;
    page: number;
    pageSize: number;
    loading: boolean;
    error: string | null;
    onPageChange: (p: number) => void;
    hrefBase: string;
    viewerId: string;
    /** Sales Head only: adds the Owner column. */
    showOwner: boolean;
    /** Sales Head only: adds the checkbox column for bulk assign. */
    selection?: {
        selected: Set<string>;
        onToggle: (id: string) => void;
        onToggleAll: () => void;
    };
};

export function EcofyLeadsTable({ tab, rows, total, page, pageSize, loading, error, onPageChange, hrefBase, viewerId, showOwner, selection }: Props) {
    const router = useRouter();
    const colCount = 7 + (showOwner ? 1 : 0) + (selection ? 1 : 0);
    const allOnPageTicked = !!selection && rows.length > 0 && rows.every((r) => selection.selected.has(r.id));
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    // Taken once per mount: "overdue" is judged against page load, which is
    // exact enough for a red follow-up and keeps the render pure.
    const [now] = useState(() => Date.now());

    return (
        <>
            {error && (
                <div className="flex items-center gap-2 bg-rose-50/50 px-4 py-6 text-sm text-rose-700">
                    <AlertTriangle className="h-4 w-4" />
                    {error}
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-gray-50/50 text-[11px] uppercase tracking-wide text-gray-500">
                        <tr>
                            {selection && (
                                <th className="w-10 px-4 py-3">
                                    <input
                                        type="checkbox"
                                        aria-label="Select all on this page"
                                        checked={allOnPageTicked}
                                        onChange={selection.onToggleAll}
                                        className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                    />
                                </th>
                            )}
                            <th className="px-4 py-3 text-left font-semibold">Customer / Case</th>
                            <th className="px-4 py-3 text-left font-semibold">Phone</th>
                            <th className="px-4 py-3 text-left font-semibold">Region</th>
                            <th className="px-4 py-3 text-left font-semibold">Stage</th>
                            <th className="px-4 py-3 text-left font-semibold">Temperature</th>
                            <th className="px-4 py-3 text-left font-semibold">Next</th>
                            <th className="px-4 py-3 text-left font-semibold">In queue</th>
                            {showOwner && <th className="px-4 py-3 text-left font-semibold">Owner</th>}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={colCount} className="px-4 py-12 text-center text-gray-400">
                                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                                    Loading leads…
                                </td>
                            </tr>
                        )}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={colCount} className="px-4 py-16 text-center text-gray-400">
                                    <InboxIcon className="mx-auto mb-2 h-8 w-8" />
                                    {ECOFY_TAB_EMPTY[tab]}
                                </td>
                            </tr>
                        )}
                        {rows.map((row) => {
                            const href = `${hrefBase}/${encodeURIComponent(row.id)}`;
                            const followUpOverdue = row.nextFollowUpAt ? new Date(row.nextFollowUpAt).getTime() <= now : false;
                            return (
                                <tr
                                    key={row.id}
                                    onClick={() => router.push(href)}
                                    className={`cursor-pointer transition hover:bg-emerald-50/40 ${selection?.selected.has(row.id) ? "bg-emerald-50/60" : ""}`}
                                >
                                    {selection && (
                                        <td className="px-4 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                                            <input
                                                type="checkbox"
                                                aria-label={`Select ${row.caseNo ?? row.customerName ?? "lead"}`}
                                                checked={selection.selected.has(row.id)}
                                                onChange={() => selection.onToggle(row.id)}
                                                className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                            />
                                        </td>
                                    )}
                                    <td className="px-4 py-3 align-top">
                                        <Link href={href} onClick={(e) => e.stopPropagation()} className="font-semibold text-emerald-700 hover:underline">
                                            {row.customerName || "(unnamed customer)"}
                                        </Link>
                                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
                                            <span className="font-medium text-gray-700">{row.caseNo ?? row.id.slice(0, 8)}</span>
                                            {row.segment && (
                                                <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 font-medium text-gray-600">
                                                    {row.segment === "CI" ? "C&I" : row.segment}
                                                </span>
                                            )}
                                            {row.productInterest && <span>{row.productInterest.replace(/_/g, " ").toLowerCase()}</span>}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-top text-gray-700 tabular-nums">
                                        <span className="inline-flex items-center gap-1">
                                            <Phone className="h-3 w-3 text-gray-400" />
                                            {row.customerMobile || "—"}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 align-top text-gray-700">
                                        {row.city || "—"}
                                        {row.state && <div className="text-[11px] text-gray-500">{row.state}</div>}
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <StageBadge value={row.stage} subStatus={row.subStatus} />
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <TemperatureBadge value={row.temperature} />
                                    </td>
                                    <td className="px-4 py-3 align-top text-xs text-gray-700">
                                        {row.nextAppointmentAt && (
                                            <div className="inline-flex items-center gap-1">
                                                <CalendarClock className="h-3 w-3 text-gray-400" />
                                                Meeting {formatIst(row.nextAppointmentAt)}
                                            </div>
                                        )}
                                        {row.nextFollowUpAt && (
                                            <div className={followUpOverdue ? "font-medium text-red-700" : ""}>Follow-up {formatIst(row.nextFollowUpAt)}</div>
                                        )}
                                        {!row.nextAppointmentAt && !row.nextFollowUpAt && <span className="text-gray-400">—</span>}
                                    </td>
                                    <td className="px-4 py-3 align-top text-gray-700">{formatQueueAge(row.queueEnteredAt)}</td>
                                    {showOwner && (
                                        <td className="px-4 py-3 align-top">
                                            <OwnerIndicator currentOwnerId={row.assignedTo} currentOwnerName={row.assigneeName} viewerId={viewerId} />
                                            {row.assignedTo && row.assignedRole && (
                                                <div className="mt-0.5 text-[11px] text-gray-500">{ECOFY_ROLE_LABEL[row.assignedRole] ?? row.assignedRole}</div>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
                <span className="text-xs text-gray-500">{total === 0 ? "0 results" : `Showing ${start}–${end} of ${total.toLocaleString("en-IN")}`}</span>
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
