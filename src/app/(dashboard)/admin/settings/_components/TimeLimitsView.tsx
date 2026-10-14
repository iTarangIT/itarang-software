"use client";

// ID 85 — Admin › Settings › Time limits. One row per limit (registry.ts):
// the value in force today, a change already scheduled for later, and an Edit
// that records a dated change. Below: the change log (what the CEO reads) and
// the office calendar's holidays.

import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatLimit, type LimitUnit, type TimeLimitDef } from "@/lib/timeLimits/registry";
import type { TimeLimitChange } from "@/lib/timeLimits/store";
import type { HolidayRow } from "@/lib/admin/types";
import { HolidayCalendarManager } from "./HolidayCalendarManager";

type LimitRow = TimeLimitDef & { value: number; scheduled: { value: number; effective_from: string } | null };

type Payload = {
    today: string;
    available: boolean;
    can_edit: boolean;
    limits: LimitRow[];
    log: TimeLimitChange[];
    holidays: HolidayRow[];
};

const QUERY_KEY = ["time-limits"];
const GROUPS = ["Lead clocks", "Follow-up", "Onboarding", "Invoices"] as const;

function istDate(iso: string): string {
    return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

function EditRow({ row, today, onSaved }: { row: LimitRow; today: string; onSaved: () => void }) {
    const [value, setValue] = useState(String(row.value));
    const [from, setFrom] = useState(today);
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);
    const n = Number(value);
    const valid = Number.isInteger(n) && n >= row.min && n <= row.max && from >= today;

    async function save() {
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/time-limits", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: row.key, value: n, effective_from: from, note: note.trim() || null }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Save failed");
            toast.success(from === today ? "Saved — in force from today." : `Saved — takes effect on ${from}.`);
            onSaved();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-bg/50 p-3">
            <label className="text-xs font-medium text-ink-muted">
                New value ({row.min}–{row.max})
                <input
                    type="number"
                    min={row.min}
                    max={row.max}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="mt-1 block h-9 w-24 rounded-md border border-border px-2 text-sm text-ink"
                />
            </label>
            <label className="text-xs font-medium text-ink-muted">
                Takes effect on
                <input
                    type="date"
                    min={today}
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="mt-1 block h-9 rounded-md border border-border px-2 text-sm text-ink"
                />
            </label>
            <label className="min-w-[200px] flex-1 text-xs font-medium text-ink-muted">
                Why (shown in the log)
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
    );
}

export function TimeLimitsView({ canEditHolidays }: { canEditHolidays: boolean }) {
    const qc = useQueryClient();
    const [editing, setEditing] = useState<string | null>(null);

    const { data, isLoading, error } = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/time-limits", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load the time limits");
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
        setEditing(null);
        qc.invalidateQueries({ queryKey: QUERY_KEY });
    };
    const unitOf = (key: string) => data.limits.find((l) => l.key === key)?.unit as LimitUnit | undefined;

    return (
        <div className="space-y-6">
            {!data.available && (
                <p className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-ink">
                    Time limits are not set up on this server yet (migration E-337). The values below are the defaults
                    and cannot be changed until it is applied.
                </p>
            )}

            <section className="rounded-xl border border-border bg-surface shadow-card">
                <table className="w-full text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-4 py-2.5 text-left font-semibold">Limit</th>
                            <th className="px-4 py-2.5 text-left font-semibold">In force today</th>
                            <th className="px-4 py-2.5 text-left font-semibold">Scheduled</th>
                            <th className="px-4 py-2.5" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {GROUPS.map((g) => (
                            <Fragment key={g}>
                                <tr className="bg-bg/40">
                                    <td colSpan={4} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                                        {g}
                                    </td>
                                </tr>
                                {data.limits
                                    .filter((l) => l.group === g)
                                    .map((l) => (
                                        <Fragment key={l.key}>
                                            <tr>
                                                <td className="px-4 py-2.5">
                                                    <div className="text-ink">{l.label}</div>
                                                    <div className="text-xs text-ink-muted">{l.help}</div>
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-2.5 font-medium text-ink">
                                                    {formatLimit(l.value, l.unit)}
                                                    {l.value !== l.default && (
                                                        <span className="ml-1 text-xs font-normal text-ink-muted">
                                                            (default {l.default})
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-2.5 text-ink-muted">
                                                    {l.scheduled
                                                        ? `${formatLimit(l.scheduled.value, l.unit)} from ${l.scheduled.effective_from}`
                                                        : "—"}
                                                </td>
                                                <td className="px-4 py-2.5 text-right">
                                                    {data.can_edit && (
                                                        <button
                                                            type="button"
                                                            onClick={() => setEditing(editing === l.key ? null : l.key)}
                                                            className="text-xs font-medium text-brand-600 hover:underline"
                                                        >
                                                            {editing === l.key ? "Cancel" : "Change"}
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                            {editing === l.key && (
                                                <tr>
                                                    <td colSpan={4} className="px-4 pb-3">
                                                        <EditRow row={l} today={data.today} onSaved={saved} />
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
                                    ))}
                            </Fragment>
                        ))}
                    </tbody>
                </table>
            </section>

            <section className="space-y-2">
                <h2 className="text-base font-semibold text-ink">Change log</h2>
                <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
                    <table className="w-full text-sm">
                        <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                            <tr>
                                <th className="px-4 py-2.5 text-left font-semibold">Changed</th>
                                <th className="px-4 py-2.5 text-left font-semibold">Limit</th>
                                <th className="px-4 py-2.5 text-left font-semibold">From → to</th>
                                <th className="px-4 py-2.5 text-left font-semibold">Takes effect</th>
                                <th className="px-4 py-2.5 text-left font-semibold">By · why</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {data.log.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-4 py-6 text-center text-ink-muted">
                                        No changes yet — every limit is at its default.
                                    </td>
                                </tr>
                            )}
                            {data.log.map((c) => {
                                const unit = unitOf(c.limit_key);
                                return (
                                    <tr key={c.id}>
                                        <td className="whitespace-nowrap px-4 py-2.5 text-ink-muted">{istDate(c.changed_at)}</td>
                                        <td className="px-4 py-2.5 text-ink">{c.label}</td>
                                        <td className="whitespace-nowrap px-4 py-2.5 text-ink">
                                            {unit ? `${formatLimit(c.previous, unit)} → ${formatLimit(c.value, unit)}` : `${c.previous} → ${c.value}`}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-2.5 text-ink">{c.effective_from}</td>
                                        <td className="px-4 py-2.5 text-ink-muted">
                                            {c.changed_by_name ?? "—"}
                                            {c.note ? ` · ${c.note}` : ""}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="space-y-2">
                <h2 className="text-base font-semibold text-ink">Office calendar — holidays</h2>
                <p className="text-sm text-ink-muted">
                    Entered each December for the coming year. A holiday is not a working day for any limit or clock.
                </p>
                <HolidayCalendarManager holidays={data.holidays} queryKey={QUERY_KEY} readOnly={!canEditHolidays} />
            </section>
        </div>
    );
}
