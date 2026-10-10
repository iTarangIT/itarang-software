"use client";

// Tracker ID 155 — who reports to whom (users.reports_to, E-335). One row per
// staff login with a "Reports to" picker; the API refuses self and loops.
// Stored and shown only: no visibility or scoping rule reads these lines yet.

import { useMemo, useState } from "react";
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
};

const roleLabel = (r: string) => r.replace(/_/g, " ");

export function ReportingLinesManager() {
    const qc = useQueryClient();
    const [q, setQ] = useState("");
    const [savingId, setSavingId] = useState<string | null>(null);

    const query = useQuery<{ rows: Row[]; available: boolean }>({
        queryKey: ["admin-reporting-lines"],
        queryFn: async () => {
            const res = await fetch("/api/admin/reporting-lines", { cache: "no-store" });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Failed to load reporting lines");
            return json.data;
        },
    });
    const rows = query.data?.rows ?? [];
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
                body: JSON.stringify({ user_id: userId, reports_to: reportsTo || null }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? json?.message ?? "Could not save");
            toast.success("Reporting line saved.");
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
                Who each person reports to, e.g. two sales associates under their ASM. Used to show a manager&apos;s team; it does not
                change who can see which leads.
            </p>
            {!query.data?.available && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    Reporting lines cannot be saved on this database yet (migration E-335 is not applied).
                </p>
            )}
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, role or manager" className="h-9 w-72" />
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="min-w-full text-sm">
                    <thead className="bg-bg text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2">Person</th>
                            <th className="px-3 py-2">Role</th>
                            <th className="px-3 py-2">Reports to</th>
                            <th className="px-3 py-2 text-right">Team</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {shown.map((r) => (
                            <tr key={r.user_id} className={r.is_active ? "" : "opacity-60"}>
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
                                            disabled={!query.data?.available || savingId === r.user_id}
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
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{teamSize.get(r.user_id) ?? "—"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
