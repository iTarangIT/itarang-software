"use client";

// Accounts tab (P1-1 / P1-2) — pieces shared by the list and detail views:
// the owner dropdown data, a fetch helper, a plain modal, and the
// "assign owner" form used for one or many accounts.

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";

export type OwnerOption = { id: string; name: string; role: string };
export type CurrentOwner = OwnerOption & { is_active: boolean; account_count: number };

export const ROLE_LABEL: Record<string, string> = {
    inside_sales_rep: "ISR",
    asm: "ASM",
    sales_executive: "Sales Exec",
    sales_manager: "Sales Manager",
    sales_head: "Sales Head",
    business_head: "Business Head",
};

export const inputCls =
    "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-500";

/** IST calendar day, YYYY-MM-DD. */
export function todayIst(): string {
    return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

export function fmtDate(v: string | null | undefined): string {
    if (!v) return "—";
    return new Date(v).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
    });
}

/** fetch + unwrap the { success, data, error } envelope. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { cache: "no-store", ...init });
    let json: { success?: boolean; data?: T; error?: { message?: string; code?: string; details?: unknown } } = {};
    try {
        json = await res.json();
    } catch {
        // non-JSON (e.g. a proxy error page)
    }
    if (!res.ok || !json.success) {
        const err = new Error(json.error?.message ?? `Request failed (${res.status})`) as Error & {
            code?: string;
            status?: number;
            details?: unknown;
        };
        err.code = json.error?.code;
        err.status = res.status;
        err.details = json.error?.details;
        throw err;
    }
    return json.data as T;
}

export function useOwners() {
    return useQuery<{ assignable: OwnerOption[]; current: CurrentOwner[] }>({
        queryKey: ["admin-accounts-owners"],
        queryFn: () => api("/api/admin/accounts/owners"),
        staleTime: 60_000,
    });
}

export function Modal({
    title,
    onClose,
    children,
}: {
    title: string;
    onClose: () => void;
    children: ReactNode;
}) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
            <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-xl">
                <div className="flex items-center justify-between border-b border-border px-5 py-3">
                    <h2 className="text-base font-semibold text-ink">{title}</h2>
                    <button type="button" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-bg" aria-label="Close">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="px-5 py-4">{children}</div>
            </div>
        </div>
    );
}

export function OwnerSelect({
    value,
    onChange,
    options,
    allowNone,
    noneLabel = "No owner (unassign)",
    placeholder = "Select owner…",
}: {
    value: string;
    onChange: (v: string) => void;
    options: OwnerOption[];
    allowNone?: boolean;
    noneLabel?: string;
    placeholder?: string;
}) {
    return (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{placeholder}</option>
            {allowNone && <option value="__none__">{noneLabel}</option>}
            {options.map((o) => (
                <option key={o.id} value={o.id}>
                    {o.name} · {ROLE_LABEL[o.role] ?? o.role}
                </option>
            ))}
        </select>
    );
}

/**
 * Assign (or reassign) an owner to one or many accounts. `fixedOwner`
 * pre-fills and locks the owner (used by "Assign suggested", where each
 * account gets its own suggestion and only date + reason are asked for).
 */
export function AssignOwnerDialog({
    title,
    description,
    accountIds,
    initialOwnerId,
    onClose,
    onDone,
    submit,
}: {
    title: string;
    description?: ReactNode;
    accountIds: string[];
    initialOwnerId?: string;
    onClose: () => void;
    onDone: (msg: string) => void;
    /** Override the request (Assign suggested sends one request per owner). */
    submit?: (args: { effectiveFrom: string | null; reason: string }) => Promise<string>;
}) {
    const owners = useOwners();
    const [owner, setOwner] = useState(initialOwnerId ?? "");
    const [effectiveFrom, setEffectiveFrom] = useState("");
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const run = async () => {
        setErr(null);
        if (!submit && !owner) return setErr("Pick an owner (or 'No owner').");
        if (!reason.trim()) return setErr("A reason is required.");
        setBusy(true);
        try {
            if (submit) {
                onDone(await submit({ effectiveFrom: effectiveFrom || null, reason: reason.trim() }));
            } else {
                const r = await api<{ changed: string[]; unchanged: string[] }>("/api/admin/accounts/assign", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        account_ids: accountIds,
                        owner_user_id: owner === "__none__" ? null : owner,
                        effective_from: effectiveFrom || null,
                        reason: reason.trim(),
                    }),
                });
                onDone(
                    `Updated ${r.changed.length} account${r.changed.length === 1 ? "" : "s"}` +
                        (r.unchanged.length ? ` · ${r.unchanged.length} already had that owner` : ""),
                );
            }
        } catch (e) {
            setErr((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={title} onClose={onClose}>
            <div className="space-y-4 text-sm">
                {description && <div className="text-ink-muted">{description}</div>}
                {!submit && (
                    <label className="block space-y-1">
                        <span className="text-xs font-medium text-ink-muted">Owner</span>
                        {owners.isLoading ? (
                            <div className="flex items-center gap-2 text-ink-muted">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
                            </div>
                        ) : (
                            <OwnerSelect value={owner} onChange={setOwner} options={owners.data?.assignable ?? []} allowNone />
                        )}
                    </label>
                )}
                <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink-muted">
                        Effective from (optional — defaults to today, or onboarding date for a first owner)
                    </span>
                    <input type="date" className={inputCls} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
                </label>
                <label className="block space-y-1">
                    <span className="text-xs font-medium text-ink-muted">Reason</span>
                    <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Territory realignment" />
                </label>
                <p className="text-xs text-ink-muted">
                    Invoices are credited to whoever owned the account on the invoice date, so past revenue does not move.
                </p>
                {err && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>}
                <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={run} disabled={busy}>
                        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Save
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
