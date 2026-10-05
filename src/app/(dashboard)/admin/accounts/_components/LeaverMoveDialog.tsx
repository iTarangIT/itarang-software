"use client";

// Leaver bulk move — every account currently owned by user X moves to user Y
// (or to unowned) from a date. Past invoices stay credited to X.

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, inputCls, Modal, OwnerSelect, ROLE_LABEL, todayIst, useOwners } from "./shared";

export function LeaverMoveDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
    const owners = useOwners();
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [effectiveFrom, setEffectiveFrom] = useState(todayIst());
    const [reason, setReason] = useState("Owner left the company");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const current = owners.data?.current ?? [];
    const fromOwner = current.find((c) => c.id === from);

    const run = async () => {
        setErr(null);
        if (!from) return setErr("Pick whose accounts to move.");
        if (!to) return setErr("Pick the new owner (or 'No owner').");
        if (to === from) return setErr("Pick a different new owner.");
        if (!reason.trim()) return setErr("A reason is required.");
        setBusy(true);
        try {
            const r = await api<{ changed: string[]; unchanged: string[] }>("/api/admin/accounts/leaver-move", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    from_user_id: from,
                    to_user_id: to === "__none__" ? null : to,
                    effective_from: effectiveFrom || null,
                    reason: reason.trim(),
                }),
            });
            onDone(`Moved ${r.changed.length} account${r.changed.length === 1 ? "" : "s"}`);
        } catch (e) {
            setErr((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="Move a leaver's accounts" onClose={onClose}>
            <div className="space-y-4 text-sm">
                <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink-muted">From (current owner)</span>
                    <select className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)}>
                        <option value="">Select…</option>
                        {current.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name} · {ROLE_LABEL[c.role] ?? c.role} · {c.account_count} account
                                {c.account_count === 1 ? "" : "s"}
                                {c.is_active ? "" : " · inactive"}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink-muted">To (new owner)</span>
                    <OwnerSelect
                        value={to}
                        onChange={setTo}
                        options={(owners.data?.assignable ?? []).filter((o) => o.id !== from)}
                        allowNone
                        noneLabel="No owner (back to the queue)"
                    />
                </label>
                <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink-muted">Effective from</span>
                    <input type="date" className={inputCls} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
                </label>
                <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink-muted">Reason</span>
                    <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                {fromOwner && (
                    <p className="text-xs text-ink-muted">
                        {fromOwner.account_count} account{fromOwner.account_count === 1 ? "" : "s"} will move. Invoices before the
                        effective date stay credited to {fromOwner.name}.
                    </p>
                )}
                {err && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>}
                <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={run} disabled={busy || owners.isLoading}>
                        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Move accounts
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
