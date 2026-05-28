"use client";

// BRD §0.1 — admin-maintained holiday calendar. Drives working-day SLA math.
// Soft delete via the is_active toggle.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarDays, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HolidayRow } from "@/lib/admin/types";

export function HolidayCalendarManager({
    holidays,
}: {
    holidays: HolidayRow[];
}) {
    const qc = useQueryClient();
    const [date, setDate] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);

    function refresh() {
        qc.invalidateQueries({ queryKey: ["admin-settings"] });
    }

    async function add() {
        if (!date || name.trim().length < 2) {
            toast.error("Pick a date and enter a holiday name.");
            return;
        }
        setBusy(true);
        try {
            const res = await fetch("/api/admin/settings/holidays", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ holiday_date: date, holiday_name: name.trim() }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to add");
            }
            toast.success("Holiday added.");
            setDate("");
            setName("");
            refresh();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function toggle(h: HolidayRow) {
        try {
            const res = await fetch(
                `/api/admin/settings/holidays/${h.holiday_id}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ is_active: !h.is_active }),
                },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed");
            }
            refresh();
        } catch (e) {
            toast.error((e as Error).message);
        }
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-bg/50 p-3">
                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        Date
                    </label>
                    <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        className="h-9 rounded-md border border-border px-2 text-sm"
                    />
                </div>
                <div className="flex-1 min-w-[200px]">
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        Holiday name
                    </label>
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Republic Day"
                        className="h-9"
                    />
                </div>
                <Button type="button" size="sm" onClick={add} disabled={busy}>
                    {busy ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                        <Plus className="h-3.5 w-3.5 mr-1" />
                    )}
                    Add Holiday
                </Button>
            </div>

            <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="text-left px-4 py-2.5 font-semibold">Date</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Holiday</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                            <th className="px-4 py-2.5"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {holidays.length === 0 && (
                            <tr>
                                <td
                                    colSpan={4}
                                    className="px-4 py-8 text-center text-ink-muted"
                                >
                                    <CalendarDays className="h-6 w-6 mx-auto mb-1.5" />
                                    No holidays configured.
                                </td>
                            </tr>
                        )}
                        {holidays.map((h) => (
                            <tr key={h.holiday_id}>
                                <td className="px-4 py-2.5 tabular-nums text-ink">
                                    {h.holiday_date}
                                </td>
                                <td className="px-4 py-2.5 text-ink">
                                    {h.holiday_name}
                                </td>
                                <td className="px-4 py-2.5">
                                    {h.is_active ? (
                                        <span className="text-xs text-success">
                                            Active
                                        </span>
                                    ) : (
                                        <span className="text-xs text-ink-muted">
                                            Disabled
                                        </span>
                                    )}
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                    <button
                                        type="button"
                                        onClick={() => toggle(h)}
                                        className="text-xs font-medium text-brand-600 hover:underline"
                                    >
                                        {h.is_active ? "Disable" : "Enable"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
