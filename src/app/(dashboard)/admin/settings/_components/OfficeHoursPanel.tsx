"use client";

// ID 85 #8 — the office hours every working-hour and working-day limit is
// counted on, as a dated setting (E-354): the hours in force today, a change
// scheduled for later, a form to set new hours from a chosen day (Admin only,
// reason required) and the change log the CEO reads. Lives on Admin ›
// Settings › Time limits beside the holidays.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WEEKDAY_SHORT, describeOfficeHours, officeHoursProblem, type OfficeHours } from "@/lib/calendar/officeHours";
import type { OfficeHoursChange } from "@/lib/calendar/officeHoursStore";

type Labelled = OfficeHours & { label: string };

type Payload = {
    today: string;
    available: boolean;
    can_edit: boolean;
    current: Labelled;
    default: Labelled;
    scheduled: (Labelled & { effective_from: string }) | null;
    log: OfficeHoursChange[];
};

export const OFFICE_HOURS_QUERY_KEY = ["office-hours"];
/** Monday-first, as people read a week. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOURS = Array.from({ length: 25 }, (_, i) => i);

function istDate(iso: string): string {
    return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

const hh = (n: number) => `${String(n).padStart(2, "0")}:00`;

function EditForm({ data, onSaved }: { data: Payload; onSaved: () => void }) {
    const [start, setStart] = useState(data.current.startHour);
    const [end, setEnd] = useState(data.current.endHour);
    const [days, setDays] = useState<number[]>([...data.current.weekdays]);
    const [from, setFrom] = useState(data.today);
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);
    const problem = officeHoursProblem({ startHour: start, endHour: end, weekdays: days });
    const valid = !problem && from >= data.today && note.trim().length >= 3;

    const toggle = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

    async function save() {
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/office-hours", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ start_hour: start, end_hour: end, working_weekdays: days, effective_from: from, note: note.trim() }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Save failed");
            toast.success(from === data.today ? "Saved — in force from today." : `Saved — takes effect on ${from}.`);
            onSaved();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="space-y-3 rounded-lg border border-border bg-bg/50 p-3">
            <div className="flex flex-wrap items-end gap-3">
                <fieldset className="text-xs font-medium text-ink-muted">
                    <legend>Working days</legend>
                    <div className="mt-1 flex flex-wrap gap-1">
                        {WEEK_ORDER.map((d) => (
                            <button
                                key={d}
                                type="button"
                                onClick={() => toggle(d)}
                                aria-pressed={days.includes(d)}
                                className={`h-9 rounded-md border px-2.5 text-sm ${
                                    days.includes(d) ? "border-brand-600 bg-brand-600 text-white" : "border-border bg-surface text-ink"
                                }`}
                            >
                                {WEEKDAY_SHORT[d]}
                            </button>
                        ))}
                    </div>
                </fieldset>
                <label className="text-xs font-medium text-ink-muted">
                    Opens
                    <select
                        value={start}
                        onChange={(e) => setStart(Number(e.target.value))}
                        className="mt-1 block h-9 rounded-md border border-border px-2 text-sm text-ink"
                    >
                        {HOURS.slice(0, 24).map((h) => (
                            <option key={h} value={h}>
                                {hh(h)}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="text-xs font-medium text-ink-muted">
                    Closes
                    <select
                        value={end}
                        onChange={(e) => setEnd(Number(e.target.value))}
                        className="mt-1 block h-9 rounded-md border border-border px-2 text-sm text-ink"
                    >
                        {HOURS.slice(1).map((h) => (
                            <option key={h} value={h}>
                                {hh(h)}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="text-xs font-medium text-ink-muted">
                    Takes effect on
                    <input
                        type="date"
                        min={data.today}
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                        className="mt-1 block h-9 rounded-md border border-border px-2 text-sm text-ink"
                    />
                </label>
            </div>
            <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-[240px] flex-1 text-xs font-medium text-ink-muted">
                    Why (required — shown in the log the CEO reads)
                    <input
                        value={note}
                        maxLength={500}
                        onChange={(e) => setNote(e.target.value)}
                        className="mt-1 block h-9 w-full rounded-md border border-border px-2 text-sm text-ink"
                    />
                </label>
                <Button type="button" size="sm" onClick={save} disabled={!valid || saving}>
                    {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Save change
                </Button>
            </div>
            <p className="text-xs text-ink-muted">
                {problem ?? `New hours: ${describeOfficeHours({ startHour: start, endHour: end, weekdays: days })}.`} Days before the
                date you choose keep the hours they had.
            </p>
        </div>
    );
}

export function OfficeHoursPanel() {
    const qc = useQueryClient();
    const [editing, setEditing] = useState(false);

    const { data, isLoading, error } = useQuery({
        queryKey: OFFICE_HOURS_QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/office-hours", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load the office hours");
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

    const saved = () => {
        setEditing(false);
        qc.invalidateQueries({ queryKey: OFFICE_HOURS_QUERY_KEY });
    };

    return (
        <div className="space-y-3">
            {!data.available && (
                <p className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-ink">
                    Office hours are not set up on this server yet (migration E-354). Every limit counts on the default,{" "}
                    {data.default.label}, which cannot be changed until it is applied.
                </p>
            )}
            <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="text-sm text-ink-muted">In force today</div>
                        <div className="text-base font-medium text-ink">{data.current.label} IST</div>
                        {data.scheduled && (
                            <div className="mt-1 text-xs text-ink-muted">
                                Scheduled: {data.scheduled.label} from {data.scheduled.effective_from}
                            </div>
                        )}
                    </div>
                    {data.can_edit && (
                        <button
                            type="button"
                            onClick={() => setEditing((v) => !v)}
                            className="text-xs font-medium text-brand-600 hover:underline"
                        >
                            {editing ? "Cancel" : "Change"}
                        </button>
                    )}
                </div>
                {editing && (
                    <div className="mt-3">
                        <EditForm data={data} onSaved={saved} />
                    </div>
                )}
            </div>

            <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
                <table className="w-full text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-4 py-2.5 text-left font-semibold">Changed</th>
                            <th className="px-4 py-2.5 text-left font-semibold">From → to</th>
                            <th className="px-4 py-2.5 text-left font-semibold">Takes effect</th>
                            <th className="px-4 py-2.5 text-left font-semibold">By · why</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {data.log.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-4 py-6 text-center text-ink-muted">
                                    No changes yet — the office keeps the default hours.
                                </td>
                            </tr>
                        )}
                        {data.log.map((c) => (
                            <tr key={c.id}>
                                <td className="whitespace-nowrap px-4 py-2.5 text-ink-muted">{istDate(c.created_at)}</td>
                                <td className="px-4 py-2.5 text-ink">
                                    {describeOfficeHours(c.previous)} →{" "}
                                    {describeOfficeHours({ startHour: c.start_hour, endHour: c.end_hour, weekdays: c.working_weekdays })}
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5 text-ink">{c.effective_from}</td>
                                <td className="px-4 py-2.5 text-ink-muted">
                                    {c.set_by_name ?? "—"} · {c.note}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
