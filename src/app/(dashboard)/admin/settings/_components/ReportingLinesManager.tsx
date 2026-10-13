"use client";

// Tracker ID 155 — who reports to whom (users.reports_to, E-335; dated
// history, E-338). One row per staff login with a "Reports to" picker; the
// API refuses self and loops. A change starts on the chosen date (default
// today, never in the future) and is kept as history, so past numbers stay
// with the manager of that time. Sales Head and Admin change it; the CEO
// reads it. A manager sees their team's leads and can reassign within it.

import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

type Row = {
    user_id: string;
    name: string | null;
    email: string;
    role: string;
    is_active: boolean;
    reports_to: string | null;
    reports_to_name: string | null;
    reports_since: string | null;
};

type HistoryRow = {
    id: string;
    manager_id: string;
    manager_name: string | null;
    effective_from: string;
    effective_to: string | null;
    changed_by_name: string | null;
    reason: string | null;
};

type ListData = { rows: Row[]; available: boolean; history_available?: boolean; can_edit?: boolean };

const roleLabel = (r: string) => r.replace(/_/g, " ");

/** Today as YYYY-MM-DD on the viewer's calendar (the server re-checks). */
function localToday(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ReportingHistory({ userId }: { userId: string }) {
    const query = useQuery<{ history: HistoryRow[]; history_available: boolean }>({
        queryKey: ["admin-reporting-lines", "history", userId],
        queryFn: async () => {
            const res = await fetch(`/api/admin/reporting-lines?user_id=${encodeURIComponent(userId)}`, { cache: "no-store" });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Failed to load history");
            return json.data;
        },
    });
    if (query.isLoading) return <p className="text-xs text-ink-muted">Loading history…</p>;
    if (query.error) return <p className="text-xs text-danger">{(query.error as Error).message}</p>;
    if (!query.data?.history_available) {
        return <p className="text-xs text-ink-muted">History is not kept on this database yet (migration E-338 is not applied).</p>;
    }
    const rows = query.data.history;
    if (rows.length === 0) return <p className="text-xs text-ink-muted">No reporting lines recorded.</p>;
    return (
        <ul className="space-y-1 text-xs text-ink-muted">
            {rows.map((h) => (
                <li key={h.id}>
                    <span className="font-medium text-ink">{h.manager_name ?? "Unknown user"}</span> · from {h.effective_from}
                    {h.effective_to ? ` to ${h.effective_to}` : " (current)"}
                    {h.changed_by_name ? ` · set by ${h.changed_by_name}` : ""}
                    {h.reason ? ` · ${h.reason}` : ""}
                </li>
            ))}
        </ul>
    );
}

export function ReportingLinesManager() {
    const qc = useQueryClient();
    const [q, setQ] = useState("");
    const [savingId, setSavingId] = useState<string | null>(null);
    const [startDate, setStartDate] = useState(localToday);
    const [reason, setReason] = useState("");
    const [openHistory, setOpenHistory] = useState<string | null>(null);

    const query = useQuery<ListData>({
        queryKey: ["admin-reporting-lines"],
        queryFn: async () => {
            const res = await fetch("/api/admin/reporting-lines", { cache: "no-store" });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Failed to load reporting lines");
            return json.data;
        },
    });
    const rows = query.data?.rows ?? [];
    const canEdit = Boolean(query.data?.available && query.data?.can_edit);
    const managers = useMemo(() => rows.filter((r) => r.is_active), [rows]);
    const teamSize = useMemo(() => {
        const m = new Map<string, number>();
        for (const r of rows) if (r.reports_to && r.is_active) m.set(r.reports_to, (m.get(r.reports_to) ?? 0) + 1);
        return m;
    }, [rows]);
    const needle = q.trim().toLowerCase();
    const shown = needle
        ? rows.filter((r) => `${r.name ?? ""} ${r.email} ${r.role} ${r.reports_to_name ?? ""}`.toLowerCase().includes(needle))
        : rows;

    async function save(userId: string, reportsTo: string) {
        setSavingId(userId);
        try {
            const res = await fetch("/api/admin/reporting-lines", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    user_id: userId,
                    reports_to: reportsTo || null,
                    effective_from: startDate || null,
                    reason: reason.trim() || null,
                }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? json?.message ?? "Could not save");
            toast.success(json?.data?.unchanged ? "No change." : `Reporting line saved, from ${startDate}.`);
            await qc.invalidateQueries({ queryKey: ["admin-reporting-lines"] });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSavingId(null);
        }
    }

    if (query.isLoading) {
        return (
            <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading reporting lines…
            </div>
        );
    }
    if (query.error) return <p className="py-8 text-sm text-danger">{(query.error as Error).message}</p>;

    return (
        <div className="space-y-4">
            <p className="text-sm text-ink-muted">
                Who each person reports to, e.g. two sales associates under their ASM. A manager sees their team&apos;s leads and can
                move a lead between themself and their team, with a reason. Team members still see only their own leads.
            </p>
            {!query.data?.available && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    Reporting lines cannot be saved on this database yet (migration E-335 is not applied).
                </p>
            )}
            {query.data?.available && !query.data?.can_edit && (
                <p className="text-sm text-ink-muted">Only Sales Head and Admin can change reporting lines.</p>
            )}
            <div className="flex flex-wrap items-end gap-3">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, role or manager" className="h-9 w-72" />
                {canEdit && (
                    <>
                        <label className="text-xs text-ink-muted">
                            <span className="mb-1 block">Change starts on</span>
                            <Input
                                type="date"
                                value={startDate}
                                max={localToday()}
                                onChange={(e) => setStartDate(e.target.value)}
                                className="h-9 w-44"
                                aria-label="Date the new reporting line starts"
                            />
                        </label>
                        <label className="text-xs text-ink-muted">
                            <span className="mb-1 block">Note (optional)</span>
                            <Input
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                maxLength={500}
                                placeholder="e.g. joined Sonu's team"
                                className="h-9 w-64"
                            />
                        </label>
                    </>
                )}
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="min-w-full text-sm">
                    <thead className="bg-bg text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2">Person</th>
                            <th className="px-3 py-2">Role</th>
                            <th className="px-3 py-2">Reports to</th>
                            <th className="px-3 py-2 text-right">Team</th>
                            <th className="px-3 py-2 text-right">History</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {shown.map((r) => (
                            <Fragment key={r.user_id}>
                                <tr className={r.is_active ? "" : "opacity-60"}>
                                    <td className="px-3 py-2">
                                        <div className="font-medium text-ink">{r.name ?? r.email}</div>
                                        <div className="text-xs text-ink-muted">
                                            {r.email}
                                            {r.is_active ? "" : " · inactive"}
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 capitalize text-ink-muted">{roleLabel(r.role)}</td>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-2">
                                            <select
                                                aria-label={`Reports to, for ${r.name ?? r.email}`}
                                                value={r.reports_to ?? ""}
                                                disabled={!canEdit || savingId === r.user_id}
                                                onChange={(e) => save(r.user_id, e.target.value)}
                                                className="h-9 min-w-[220px] rounded-md border border-border bg-surface px-2 text-sm"
                                            >
                                                <option value="">Nobody</option>
                                                {/* Keep a current manager who has since been deactivated visible. */}
                                                {r.reports_to && !managers.some((m) => m.user_id === r.reports_to) && (
                                                    <option value={r.reports_to}>{r.reports_to_name ?? "Unknown user"} (inactive)</option>
                                                )}
                                                {managers
                                                    .filter((m) => m.user_id !== r.user_id)
                                                    .map((m) => (
                                                        <option key={m.user_id} value={m.user_id}>
                                                            {m.name ?? m.email} · {roleLabel(m.role)}
                                                        </option>
                                                    ))}
                                            </select>
                                            {savingId === r.user_id && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
                                        </div>
                                        {r.reports_to && r.reports_since && (
                                            <div className="mt-1 text-xs text-ink-muted">since {r.reports_since}</div>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{teamSize.get(r.user_id) ?? "—"}</td>
                                    <td className="px-3 py-2 text-right">
                                        <button
                                            type="button"
                                            className="text-xs font-medium text-brand-600 hover:underline"
                                            onClick={() => setOpenHistory((cur) => (cur === r.user_id ? null : r.user_id))}
                                        >
                                            {openHistory === r.user_id ? "Hide" : "Show"}
                                        </button>
                                    </td>
                                </tr>
                                {openHistory === r.user_id && (
                                    <tr>
                                        <td colSpan={5} className="bg-bg px-3 py-2">
                                            <ReportingHistory userId={r.user_id} />
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
