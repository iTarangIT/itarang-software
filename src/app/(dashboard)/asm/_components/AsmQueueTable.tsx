"use client";

// ID 244 (11 Nov mock-up "ASM My visits: cleaned-up screen") — the My visits table.
// Labels and layout only: every row still opens the same lead page, every button keeps its
// route, and the claim / bulk-claim / review behaviour is unchanged (tab "244-246 workflows").
//
// Columns: Dealer / Shop · Phone · Status · Visit · Interest · Owner · Last action, and one
// action button. On Open leads in the default order the rows are grouped Overdue visits →
// Today's visits → Upcoming visits → No visit planned (the server orders them so; ID 247 one
// open booking). A header click sorts on the server (ID 243) and drops the groups.

import { PastLimitChip } from "@/components/leads/past-limit-chip";
import { IvrTag } from "@/components/leads/ivr-tag";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, Inbox as InboxIcon, Loader2, UserPlus2 } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/app/(dashboard)/inside-sales/_components/StatusChip";
import { InterestChip } from "@/app/(dashboard)/inside-sales/_components/InterestChip";
import { OwnerIndicator } from "@/app/(dashboard)/inside-sales/_components/OwnerIndicator";
import { SentByStamp } from "@/components/leads/sent-by-stamp";
import { TEAM_REVIEW_COLUMN_COUNT, TeamReviewCells, TeamReviewHeaders } from "@/components/leads/TeamReviewColumns";
import { VISIT_OUTCOME_LABELS } from "@/lib/asm/types";
import type { AsmQueueRow, AsmQueueTab, VisitOutcome } from "@/lib/asm/types";
import type { QueueSort, QueueSortKey } from "@/lib/leads/queueSort";

type Props = {
    tab: AsmQueueTab;
    /** ID 199: a manager's team view — adds the review columns. */
    showReview?: boolean;
    rows: AsmQueueRow[];
    total: number;
    page: number;
    pageSize: number;
    loading: boolean;
    error: string | null;
    onPageChange: (p: number) => void;
    viewerId: string;
    /** B3: opens the claim confirm for an unowned row. Absent = no Claim button. */
    onClaim?: (row: AsmQueueRow) => void;
    /** B3: bulk-claim ticking on the Unclaimed and Territory Feed tabs. */
    selection?: {
        selected: Set<string>;
        onToggle: (id: string) => void;
        onToggleAll: () => void;
    };
    /** ID 243 / 244: the header sort (server-side; kept in the page link). */
    sort: QueueSort;
    onSort: (key: QueueSortKey) => void;
};

const BUCKETS: Record<number, { label: string; className: string }> = {
    0: { label: "Overdue visits", className: "bg-rose-50 text-rose-700" },
    1: { label: "Today's visits", className: "bg-sky-50 text-sky-700" },
    2: { label: "Upcoming visits", className: "bg-gray-50 text-gray-600" },
    3: { label: "No visit planned", className: "bg-gray-50 text-gray-600" },
};

const DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const DAY_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** "2026-11-13" → "Fri 13 Nov" (a calendar date, no time zone shift). */
function dayLabel(d: string | null | undefined, withWeekday = true): string {
    if (!d) return "";
    const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(t.getTime()) ? d : (withWeekday ? DAY : DAY_MONTH).format(t);
}

/** "3 days ago", "today", "4 months ago". */
function ago(iso: string | null | undefined): string {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return "";
    const days = Math.floor(ms / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 60) return `${days} days ago`;
    return `${Math.round(days / 30)} months ago`;
}

function VisitCell({ row }: { row: AsmQueueRow }) {
    const bucket = row.visit_bucket ?? 3;
    if (bucket === 0) {
        return (
            <>
                <div className="font-semibold text-rose-700">
                    Overdue {row.visit_overdue_days} day{row.visit_overdue_days === 1 ? "" : "s"}
                </div>
                <div className="text-xs text-gray-600">Booked for {dayLabel(row.next_booking_date, false)}, never logged</div>
            </>
        );
    }
    if (bucket === 1) {
        return (
            <>
                <div className="font-semibold text-sky-700">Today</div>
                <div className="text-xs text-gray-600">Booked visit</div>
            </>
        );
    }
    if (bucket === 2) {
        return (
            <>
                <div className="font-medium text-gray-900">{dayLabel(row.next_booking_date)}</div>
                <div className="text-xs text-gray-600">Booked visit</div>
            </>
        );
    }
    if (row.actual_visit_date) {
        return (
            <>
                <div className="font-medium text-emerald-700">
                    Visited {dayLabel(row.actual_visit_date, false)}
                    {row.visit_outcome ? ` · ${VISIT_OUTCOME_LABELS[row.visit_outcome as VisitOutcome] ?? row.visit_outcome}` : ""}
                </div>
                <div className="text-xs text-gray-600">No next visit booked</div>
            </>
        );
    }
    return (
        <>
            <div className="text-gray-700">No visit yet</div>
            {row.assigned_at ? <div className="text-xs text-gray-500">Assigned {dayLabel(String(row.assigned_at).slice(0, 10), false)}</div> : null}
        </>
    );
}

function LastActionCell({ row }: { row: AsmQueueRow }) {
    if (!row.last_action_at) {
        return (
            <>
                <div className="text-gray-700">No action yet</div>
                {row.assigned_at ? (
                    <div className={`text-xs ${row.past_limit ? "text-rose-700" : "text-gray-500"}`}>
                        assigned {ago(String(row.assigned_at))}
                        {row.past_limit ? " · past limit" : ""}
                    </div>
                ) : null}
            </>
        );
    }
    const what = row.last_action ? row.last_action.replace(/_/g, " ") : "Worked";
    return (
        <>
            <div className="text-gray-900">
                {what} · {WHEN.format(new Date(row.last_action_at))}
            </div>
            <div className={`text-xs ${row.past_limit ? "text-rose-700" : "text-gray-500"}`}>
                {ago(row.last_action_at)}
                {row.past_limit ? " · past limit" : ""}
            </div>
        </>
    );
}

function SortTh({
    label,
    sortKey,
    sort,
    onSort,
}: {
    label: string;
    sortKey?: QueueSortKey;
    sort: QueueSort;
    onSort: (k: QueueSortKey) => void;
}) {
    if (!sortKey) return <th className="text-left px-4 py-3 font-semibold">{label}</th>;
    const active = sort.sort === sortKey;
    return (
        <th className="text-left px-4 py-3 font-semibold" aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}>
            <button
                type="button"
                onClick={() => onSort(sortKey)}
                title={`Sort by ${label.toLowerCase()}`}
                className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-gray-800 ${active ? "text-emerald-700" : ""}`}
            >
                {label}
                {active ? (
                    sort.dir === "desc" ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />
                ) : (
                    <ChevronsUpDown className="h-3 w-3 text-gray-300" />
                )}
            </button>
        </th>
    );
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
    onClaim,
    selection,
    showReview = false,
    sort,
    onSort,
}: Props) {
    const router = useRouter();
    const colCount = (selection ? 9 : 8) + (showReview ? TEAM_REVIEW_COLUMN_COUNT : 0);
    const claimableRows = rows.filter((r) => !r.current_owner_id);
    const allOnPageTicked = !!selection && claimableRows.length > 0 && claimableRows.every((r) => selection.selected.has(r.id));
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    // Groups only in the default order of Open leads (a header sort mixes them).
    const grouped = tab === "my_visits" && !sort.sort;

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
                            <SortTh label="Dealer / Shop" sortKey="dealer" sort={sort} onSort={onSort} />
                            <SortTh label="Phone" sort={sort} onSort={onSort} />
                            <SortTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
                            <SortTh label="Visit" sortKey="visit" sort={sort} onSort={onSort} />
                            <SortTh label="Interest" sortKey="interest" sort={sort} onSort={onSort} />
                            <SortTh label="Owner" sortKey="owner" sort={sort} onSort={onSort} />
                            <SortTh label="Last action" sortKey="last_action" sort={sort} onSort={onSort} />
                            <th className="px-4 py-3" aria-label="Action" />
                            {showReview && <TeamReviewHeaders />}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={colCount} className="px-4 py-12 text-center text-gray-400">
                                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                                    Loading…
                                </td>
                            </tr>
                        )}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={colCount} className="px-4 py-16 text-center text-gray-400">
                                    <InboxIcon className="h-8 w-8 mx-auto mb-2" />
                                    {tab === "today"
                                        ? "No visits booked for today."
                                        : tab === "territory"
                                          ? "No leads in your territory yet."
                                          : tab === "unclaimed"
                                            ? "No unclaimed leads in your territory right now."
                                            : tab === "my_closed"
                                              ? "No leads closed in the last 90 days."
                                              : "No open leads."}
                                </td>
                            </tr>
                        )}
                        {rows.map((row, i) => {
                            const href = `/asm/lead/${encodeURIComponent(row.id)}`;
                            const unowned = !row.current_owner_id;
                            const bucket = row.visit_bucket ?? 3;
                            const groupStart = grouped && (i === 0 || (rows[i - 1]?.visit_bucket ?? 3) !== bucket);
                            const action = bucket <= 1 ? "Log visit" : bucket === 2 ? "Open" : "Plan visit";
                            return (
                                <Fragment key={row.id}>
                                    {groupStart && (
                                        <tr className={BUCKETS[bucket]?.className}>
                                            <td colSpan={colCount} className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide">
                                                {BUCKETS[bucket]?.label}
                                            </td>
                                        </tr>
                                    )}
                                    <tr
                                        onClick={() => router.push(href)}
                                        className={`cursor-pointer hover:bg-emerald-50/40 transition ${selection?.selected.has(row.id) ? "bg-emerald-50/60" : ""}`}
                                    >
                                        {selection && (
                                            <td className="px-4 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                                                {unowned && (
                                                    <input
                                                        type="checkbox"
                                                        aria-label={`Select ${row.dealer_name || row.shop_name || "lead"}`}
                                                        checked={selection.selected.has(row.id)}
                                                        onChange={() => selection.onToggle(row.id)}
                                                        className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                                    />
                                                )}
                                            </td>
                                        )}
                                        <td className="px-4 py-3 align-top">
                                            <Link href={href} onClick={(e) => e.stopPropagation()} className="font-semibold text-emerald-700 hover:underline">
                                                {row.dealer_name || row.shop_name || "(unnamed dealer)"}
                                            </Link>
                                            <IvrTag className="ml-1.5" isIvr={row.is_ivr} />
                                            <div className="text-xs text-gray-500 mt-0.5">
                                                {[row.shop_name && row.dealer_name ? row.shop_name : null, row.city].filter(Boolean).join(" · ") || "—"}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-gray-700 tabular-nums align-top whitespace-nowrap">{row.phone || "—"}</td>
                                        <td className="px-4 py-3 align-top">
                                            <StatusChip status={row.lead_status} />
                                        </td>
                                        <td className="px-4 py-3 align-top">
                                            <VisitCell row={row} />
                                        </td>
                                        <td className="px-4 py-3 align-top">
                                            <InterestChip level={row.interest_level} />
                                        </td>
                                        <td className="px-4 py-3 align-top">
                                            <OwnerIndicator
                                                currentOwnerId={row.current_owner_id}
                                                currentOwnerName={row.current_owner_name}
                                                viewerId={viewerId}
                                                asmName={row.asm_name}
                                            />
                                            <SentByStamp assignedBy={row.assigned_by} currentOwnerId={row.current_owner_id} />
                                        </td>
                                        <td className="px-4 py-3 align-top">
                                            <LastActionCell row={row} />
                                            {row.past_limit && <PastLimitChip className="mt-1" limits={row.past_limits} />}
                                        </td>
                                        <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                                            {unowned && onClaim ? (
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 gap-1 px-2 text-xs"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onClaim(row);
                                                    }}
                                                >
                                                    <UserPlus2 className="h-3.5 w-3.5" />
                                                    Claim
                                                </Button>
                                            ) : tab === "my_closed" ? null : (
                                                <Link
                                                    href={href}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className={`inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium ${
                                                        action === "Open"
                                                            ? "border-gray-300 text-gray-700 hover:bg-gray-50"
                                                            : "border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                                                    }`}
                                                >
                                                    {action}
                                                </Link>
                                            )}
                                        </td>
                                        {showReview && (
                                            <TeamReviewCells row={row} outcomeLabel={(o) => VISIT_OUTCOME_LABELS[o as VisitOutcome] ?? o} />
                                        )}
                                    </tr>
                                </Fragment>
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
