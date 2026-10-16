"use client";

// A39 — Admin › Settings › Logins: who can sign in. Deactivate a leaver (every
// page and API refuses them from the next request; their Supabase login is
// banned), or force a password change at the next page load. Passwords older
// than 90 days must be changed (dated from E-345 — "not recorded" until the
// person next sets one).

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { PASSWORD_MAX_AGE_DAYS } from "@/lib/auth/accountGate";

type Row = {
    id: string;
    name: string | null;
    email: string | null;
    role: string;
    is_active: boolean;
    must_change_password: boolean;
    password_changed_at: string | null;
    last_download_at: string | null;
};

const KEY = ["admin-logins"];

const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) : "—";

export function LoginsManager() {
    const qc = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const [q, setQ] = useState("");
    const { data, isLoading, error } = useQuery({
        queryKey: KEY,
        queryFn: async () => {
            const r = await fetch("/api/admin/users/access", { cache: "no-store" });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Could not load the logins");
            return j.data as { rows: Row[]; can_edit: boolean };
        },
    });
    const rows = useMemo(
        () =>
            (data?.rows ?? []).filter(
                (r) => !q.trim() || `${r.name} ${r.email} ${r.role}`.toLowerCase().includes(q.trim().toLowerCase()),
            ),
        [data, q],
    );

    async function act(r: Row, action: "deactivate" | "activate" | "force_reset") {
        const ask =
            action === "deactivate"
                ? `Deactivate ${r.name ?? r.email}? They are signed out and cannot log in again until reactivated.`
                : action === "force_reset"
                  ? `Make ${r.name ?? r.email} choose a new password at their next page load?`
                  : null;
        if (ask && !window.confirm(ask)) return;
        setBusy(r.id + action);
        try {
            const res = await fetch("/api/admin/users/access", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_id: r.id, action }),
            });
            const j = await res.json();
            if (!res.ok || !j.success) throw new Error(j?.error?.message ?? "Could not save");
            toast.success(
                action === "deactivate" ? "Deactivated." : action === "activate" ? "Reactivated." : "They will be asked for a new password.",
            );
            if (j.data.auth_note) toast.warning(`Saved in the CRM; the sign-in block said: ${j.data.auth_note}`);
            qc.invalidateQueries({ queryKey: KEY });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(null);
        }
    }

    if (isLoading) return <p className="text-sm text-ink-muted">Loading…</p>;
    if (error || !data) return <p className="text-sm text-danger">{(error as Error)?.message}</p>;
    const now = Date.now();

    return (
        <div className="space-y-3">
            <p className="text-sm text-ink-muted">
                Deactivate anyone who has left — they are signed out at their next page load and cannot log in again. A forced
                reset makes the person choose a new password before they can continue. Passwords older than{" "}
                {PASSWORD_MAX_AGE_DAYS} days must be changed. Every download is logged with the person&apos;s name (Reports › Data
                downloads).
            </p>
            <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email or role"
                aria-label="Search logins"
                className="w-72 rounded-lg border border-border px-3 py-1.5 text-sm"
            />
            <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                    <thead className="text-left text-xs text-ink-muted">
                        <tr>
                            <th className="py-2 pr-3">Person</th>
                            <th className="py-2 pr-3">Role</th>
                            <th className="py-2 pr-3">Password set</th>
                            <th className="py-2 pr-3">Last download</th>
                            <th className="py-2 pr-3">Status</th>
                            <th className="py-2" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.map((r) => {
                            const age = r.password_changed_at ? Math.floor((now - Date.parse(r.password_changed_at)) / 86_400_000) : null;
                            return (
                                <tr key={r.id} className={r.is_active ? "" : "opacity-60"}>
                                    <td className="py-2 pr-3">
                                        <div className="text-ink">{r.name ?? "—"}</div>
                                        <div className="text-xs text-ink-muted">{r.email}</div>
                                    </td>
                                    <td className="py-2 pr-3 text-ink-muted">{r.role.replace(/_/g, " ")}</td>
                                    <td className={`py-2 pr-3 ${age != null && age > PASSWORD_MAX_AGE_DAYS ? "text-danger" : "text-ink-muted"}`}>
                                        {r.password_changed_at ? `${day(r.password_changed_at)} (${age} d)` : "not recorded"}
                                    </td>
                                    <td className="py-2 pr-3 text-ink-muted">{day(r.last_download_at)}</td>
                                    <td className="py-2 pr-3">
                                        {!r.is_active ? (
                                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">Deactivated</span>
                                        ) : r.must_change_password ? (
                                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">Reset pending</span>
                                        ) : (
                                            <span className="text-xs text-emerald-700">Active</span>
                                        )}
                                    </td>
                                    <td className="py-2 text-right whitespace-nowrap">
                                        {data.can_edit &&
                                            (r.is_active ? (
                                                <>
                                                    <button
                                                        type="button"
                                                        disabled={busy !== null || r.must_change_password}
                                                        onClick={() => act(r, "force_reset")}
                                                        className="mr-2 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50"
                                                    >
                                                        {busy === r.id + "force_reset" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Force new password"}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={busy !== null}
                                                        onClick={() => act(r, "deactivate")}
                                                        className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 disabled:opacity-50"
                                                    >
                                                        {busy === r.id + "deactivate" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Deactivate"}
                                                    </button>
                                                </>
                                            ) : (
                                                <button
                                                    type="button"
                                                    disabled={busy !== null}
                                                    onClick={() => act(r, "activate")}
                                                    className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50"
                                                >
                                                    Reactivate
                                                </button>
                                            ))}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
