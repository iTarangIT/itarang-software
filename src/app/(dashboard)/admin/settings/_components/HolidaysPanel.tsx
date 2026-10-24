"use client";

// ID 85 Decision 4 — the office calendar every time limit and clock counts
// working days and hours on, with the log of every change (E-350). It lives on
// Admin › Settings › Time limits; there is no separate Holidays tab.

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import type { HolidayRow } from "@/lib/admin/types";
import type { HolidayLogEntry } from "@/lib/calendar/holidays";
import { HolidayCalendarManager } from "./HolidayCalendarManager";

const QUERY_KEY = ["holidays"];

type Payload = { holidays: HolidayRow[]; log: HolidayLogEntry[]; can_edit: boolean };

function istDate(iso: string): string {
    return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

const ACTION_WORD: Record<HolidayLogEntry["action"], string> = { add: "Added", remove: "Removed", rename: "Renamed" };

export function HolidaysPanel({ readOnly = false }: { readOnly?: boolean }) {
    const { data, isLoading, error } = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/holidays", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load the holidays");
            return json.data as Payload;
        },
    });

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
        );
    }
    if (error || !data) return <p className="text-sm text-danger">{(error as Error)?.message ?? "Failed to load"}</p>;

    const canEdit = data.can_edit && !readOnly;

    return (
        <div className="space-y-4">
            <p className="text-sm text-ink-muted">
                Entered each December for the coming year. A holiday is not a working day for any limit or clock. It
                counts only for clocks still running when it is added, and for waits and periods that had not ended
                by then (field visit waits, quote answers, the turnaround analysis), so adding a past date never
                changes those results. Counts of days up to today (idle days, days waiting) use today&rsquo;s list.
            </p>
            <HolidayCalendarManager holidays={data.holidays} queryKey={QUERY_KEY} readOnly={!canEdit} />
            <div className="space-y-2">
                <h3 className="text-sm font-semibold text-ink">Change log</h3>
                <div className="overflow-hidden rounded-xl border border-border bg-surface">
                    <table className="w-full text-sm">
                        <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                            <tr>
                                <th className="px-4 py-2.5 text-left font-semibold">Changed</th>
                                <th className="px-4 py-2.5 text-left font-semibold">Holiday</th>
                                <th className="px-4 py-2.5 text-left font-semibold">Change</th>
                                <th className="px-4 py-2.5 text-left font-semibold">By</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {data.log.length === 0 && (
                                <tr>
                                    <td colSpan={4} className="px-4 py-6 text-center text-ink-muted">
                                        No changes logged yet.
                                    </td>
                                </tr>
                            )}
                            {data.log.map((h) => (
                                <tr key={h.id}>
                                    <td className="whitespace-nowrap px-4 py-2.5 text-ink-muted">{istDate(h.changed_at)}</td>
                                    <td className="px-4 py-2.5 text-ink">
                                        {h.holiday_date}
                                        {h.holiday_name ? ` · ${h.holiday_name}` : ""}
                                    </td>
                                    <td className="px-4 py-2.5 text-ink">{ACTION_WORD[h.action]}</td>
                                    <td className="px-4 py-2.5 text-ink-muted">{h.changed_by_name ?? "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
