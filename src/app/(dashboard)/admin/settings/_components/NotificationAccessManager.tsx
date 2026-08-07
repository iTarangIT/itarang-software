"use client";

// Settings → Notification Access (E-231).
//
// One accordion row per dashboard; inside, one row per notification category
// with a tri-state master checkbox, expanding to the individual types.
//
// STATE IS A DIFF, NOT A MATRIX. `pending` holds only the boxes the admin has
// actually moved, keyed exactly as the wire format, so Save sends the smallest
// possible payload and "N changes" is free to compute. The full matrix (17 x
// ~130) is never materialised in memory or over the network — the type list and
// every label come from the registry the client already bundles, and the server
// sends only the denials.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellOff, ChevronRight, Loader2 } from "lucide-react";

import { TriStateCheckbox, type TriState } from "@/components/ui/tri-state-checkbox";
import { typeGroups, type DashboardMeta } from "@/lib/notifications/registry";

interface DeniedRow {
    dashboard: string;
    notification_type: string;
}

interface Payload {
    dashboards: DashboardMeta[];
    denied: DeniedRow[];
    last_change: { updated_at: string; updated_by_name: string | null } | null;
    unknown_roles: string[];
}

const key = (dashboard: string, type: string) => `${dashboard}|${type}`;

export function NotificationAccessManager() {
    const qc = useQueryClient();
    const groups = useMemo(() => typeGroups(), []);
    const totalTypes = useMemo(
        () => groups.reduce((n, g) => n + g.types.length, 0),
        [groups],
    );

    const [pending, setPending] = useState<Map<string, boolean>>(new Map());
    const [openDashboard, setOpenDashboard] = useState<string | null>(null);
    const [openCategory, setOpenCategory] = useState<string | null>(null);
    const [savedAt, setSavedAt] = useState<string | null>(null);

    const query = useQuery<{ success: true; data: Payload }>({
        queryKey: ["notification-access"],
        queryFn: async () => {
            const res = await fetch("/api/admin/notification-access", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load notification access");
            return res.json();
        },
    });
    const data = query.data?.data;

    // The saved answer: absent from `denied` means enabled (E-231).
    const deniedSet = useMemo(
        () => new Set((data?.denied ?? []).map((d) => key(d.dashboard, d.notification_type))),
        [data],
    );

    const isOn = (dashboard: string, type: string) => {
        const k = key(dashboard, type);
        if (pending.has(k)) return pending.get(k) as boolean;
        return !deniedSet.has(k);
    };

    const setOne = (dashboard: string, type: string, next: boolean) => {
        const k = key(dashboard, type);
        setPending((prev) => {
            const copy = new Map(prev);
            // Moving a box back to its saved value removes it from the diff
            // entirely, so "3 changes" never counts a no-op.
            if (!deniedSet.has(k) === next) copy.delete(k);
            else copy.set(k, next);
            return copy;
        });
    };

    const setMany = (dashboard: string, types: string[], next: boolean) => {
        setPending((prev) => {
            const copy = new Map(prev);
            for (const type of types) {
                const k = key(dashboard, type);
                if (!deniedSet.has(k) === next) copy.delete(k);
                else copy.set(k, next);
            }
            return copy;
        });
    };

    const save = useMutation({
        mutationFn: async () => {
            const changes = [...pending.entries()].map(([k, enabled]) => {
                const sep = k.indexOf("|");
                return {
                    dashboard: k.slice(0, sep),
                    notification_type: k.slice(sep + 1),
                    enabled,
                };
            });
            const res = await fetch("/api/admin/notification-access", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ changes }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(body?.error?.message ?? "Could not save notification access");
            }
            return body;
        },
        onSuccess: async () => {
            setPending(new Map());
            setSavedAt(new Date().toLocaleTimeString());
            await qc.invalidateQueries({ queryKey: ["notification-access"] });
        },
    });

    if (query.isLoading) {
        return (
            <div className="flex items-center justify-center py-10 text-ink-muted">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading notification access…
            </div>
        );
    }
    if (query.error || !data) {
        return (
            <div className="flex items-center gap-2 text-sm text-danger">
                <AlertTriangle className="h-4 w-4" />
                {(query.error as Error)?.message ?? "Could not load notification access"}
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <header className="space-y-1">
                <h3 className="text-sm font-semibold text-ink">Notification Access</h3>
                <p className="max-w-3xl text-xs text-ink-muted">
                    Untick a notification to keep it out of that dashboard&apos;s bell. This
                    controls the <strong>in-app bell only</strong> — email, WhatsApp and SMS are
                    unaffected, so an agreement link or a password reset can never be silenced
                    here. Changes apply to new notifications; anything already in the bell stays.
                </p>
                {data.last_change && (
                    <p className="text-xs text-ink-muted">
                        Last changed by {data.last_change.updated_by_name ?? "someone"} on{" "}
                        {new Date(data.last_change.updated_at).toLocaleString()}
                    </p>
                )}
            </header>

            {data.unknown_roles.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-bg p-3 text-xs text-ink-muted">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                        {data.unknown_roles.length} active role
                        {data.unknown_roles.length === 1 ? "" : "s"} not listed below —{" "}
                        <code className="font-mono">{data.unknown_roles.join(", ")}</code>. Users
                        holding these receive every notification, because no dashboard here governs
                        them.
                    </span>
                </div>
            )}

            <div className="divide-y divide-border rounded-lg border border-border">
                {data.dashboards.map((dash) => {
                    const mutedCount = groups.reduce(
                        (n, g) => n + g.types.filter((t) => !isOn(dash.value, t.value)).length,
                        0,
                    );
                    const open = openDashboard === dash.value;

                    return (
                        <div key={dash.value}>
                            <button
                                type="button"
                                onClick={() => setOpenDashboard(open ? null : dash.value)}
                                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg"
                            >
                                <ChevronRight
                                    className={`h-4 w-4 shrink-0 text-ink-muted transition-transform ${open ? "rotate-90" : ""}`}
                                />
                                <span className="flex-1">
                                    <span className="block text-sm font-medium text-ink">
                                        {dash.label}
                                    </span>
                                    {dash.note && (
                                        <span className="block text-xs text-ink-muted">
                                            {dash.note}
                                        </span>
                                    )}
                                </span>
                                <span className="shrink-0 text-xs text-ink-muted">
                                    {mutedCount === 0 ? (
                                        `all ${totalTypes} on`
                                    ) : (
                                        <span className="inline-flex items-center gap-1">
                                            <BellOff className="h-3 w-3" />
                                            {mutedCount} of {totalTypes} muted
                                        </span>
                                    )}
                                </span>
                            </button>

                            {open && (
                                <div className="border-t border-border bg-bg/40 px-4 pb-3">
                                    {groups.map((group) => {
                                        const values = group.types.map((t) => t.value);
                                        const onCount = values.filter((v) =>
                                            isOn(dash.value, v),
                                        ).length;
                                        const state: TriState =
                                            onCount === values.length
                                                ? "on"
                                                : onCount === 0
                                                  ? "off"
                                                  : "mixed";
                                        const catKey = `${dash.value}|${group.category}`;
                                        const catOpen = openCategory === catKey;

                                        return (
                                            <div key={group.category} className="border-b border-border last:border-0">
                                                <div className="flex items-center gap-3 py-2">
                                                    <TriStateCheckbox
                                                        state={state}
                                                        ariaLabel={`${group.category} for ${dash.label}`}
                                                        onToggle={(next) =>
                                                            setMany(dash.value, values, next)
                                                        }
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setOpenCategory(catOpen ? null : catKey)
                                                        }
                                                        className="flex flex-1 items-center gap-2 text-left"
                                                    >
                                                        <ChevronRight
                                                            className={`h-3.5 w-3.5 text-ink-muted transition-transform ${catOpen ? "rotate-90" : ""}`}
                                                        />
                                                        <span className="text-sm text-ink">
                                                            {group.category}
                                                        </span>
                                                        <span className="text-xs text-ink-muted">
                                                            {onCount}/{values.length}
                                                        </span>
                                                    </button>
                                                </div>

                                                {catOpen && (
                                                    <ul className="space-y-1 pb-2 pl-10">
                                                        {group.types.map((t) => (
                                                            <li
                                                                key={t.value}
                                                                className="flex items-center gap-3"
                                                            >
                                                                <TriStateCheckbox
                                                                    state={
                                                                        isOn(dash.value, t.value)
                                                                            ? "on"
                                                                            : "off"
                                                                    }
                                                                    ariaLabel={`${t.label} for ${dash.label}`}
                                                                    onToggle={(next) =>
                                                                        setOne(
                                                                            dash.value,
                                                                            t.value,
                                                                            next,
                                                                        )
                                                                    }
                                                                />
                                                                <span className="text-sm text-ink">
                                                                    {t.label}
                                                                </span>
                                                                <code className="font-mono text-[11px] text-ink-muted">
                                                                    {t.value}
                                                                </code>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {save.error && (
                <div className="flex items-center gap-2 text-sm text-danger">
                    <AlertTriangle className="h-4 w-4" />
                    {(save.error as Error).message}
                </div>
            )}

            <div className="flex items-center gap-3">
                <button
                    type="button"
                    disabled={pending.size === 0 || save.isPending}
                    onClick={() => save.mutate()}
                    className="rounded-md bg-brand-sky px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                    {save.isPending
                        ? "Saving…"
                        : pending.size === 0
                          ? "Save changes"
                          : `Save ${pending.size} change${pending.size === 1 ? "" : "s"}`}
                </button>
                {pending.size > 0 && (
                    <button
                        type="button"
                        onClick={() => setPending(new Map())}
                        className="text-sm text-ink-muted hover:text-ink"
                    >
                        Discard
                    </button>
                )}
                {savedAt && pending.size === 0 && (
                    <span className="text-xs text-ink-muted">Saved at {savedAt}</span>
                )}
            </div>
        </div>
    );
}
