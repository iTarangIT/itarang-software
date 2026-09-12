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
//
// DELIVERED vs NOT SEEN. Only a few roles are ever in an audience, so most of
// the 17 x ~138 grid governs an event that dashboard cannot receive; the old
// "all N on" summary read as coverage when (say) ASM has only ever been sent one
// type. Each panel now splits on `observed` — what the bell actually delivered
// there in 180 days — and leads with the count that is true.
//
// NOTHING IS HIDDEN. Not-seen types stay listed and stay toggleable, just
// collapsed. A type that has not fired YET is not the same as one that cannot,
// and the two are indistinguishable from here; demoting is honest, removing
// would be a guess that silently costs an admin control they have today.
//
// A DASHBOARD WITH NO HISTORY OF ITS OWN. `observed` is per-role, so a role
// added recently reads as "nothing delivered here" and its panel opens on all
// ~200 types with nothing to separate the ones it will actually be sent.
// `peer_observed` (see the API route) answers that from the bell's own record:
// the roles it shares an audience with. Where it is present the panel leads with
// what that audience receives and collapses the rest, which is the same
// delivered/not-seen split every other panel already uses — one honest basis,
// two sources.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellOff, ChevronRight, Loader2 } from "lucide-react";

import { TriStateCheckbox, type TriState } from "@/components/ui/tri-state-checkbox";
import { DASHBOARDS, typeGroups, type DashboardMeta } from "@/lib/notifications/registry";

interface DeniedRow {
    dashboard: string;
    notification_type: string;
}

interface Payload {
    dashboards: DashboardMeta[];
    denied: DeniedRow[];
    last_change: { updated_at: string; updated_by_name: string | null } | null;
    unknown_roles: string[];
    /** dashboard -> types actually delivered to it in the last 180 days. */
    observed: Record<string, string[]>;
    /**
     * dashboard -> types delivered to the roles it SHARES AN AUDIENCE WITH, for
     * a dashboard too new to have a history of its own. Absent for every
     * dashboard that stands alone, which is all of them but `partner`.
     */
    peer_observed?: Record<string, string[]>;
    /** dashboard -> the peer roles peer_observed was read from. */
    audience_peers?: Record<string, string[]>;
}

const key = (dashboard: string, type: string) => `${dashboard}|${type}`;

/** A role value as the screen names it, so a peer list reads like the rows above it. */
const dashboardLabel = (value: string) =>
    DASHBOARDS.find((d) => d.value === value)?.label ?? value;

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
    const [showUnseen, setShowUnseen] = useState<string | null>(null);
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

    // One category accordion per group. Shared by the delivered and not-seen
    // sections, so `section` keeps their open-category keys from colliding.
    const renderGroups = (
        dash: DashboardMeta,
        groupList: ReturnType<typeof typeGroups>,
        section: string,
    ) =>
        groupList.map((group) => {
            const values = group.types.map((t) => t.value);
            const onCount = values.filter((v) => isOn(dash.value, v)).length;
            const state: TriState =
                onCount === values.length ? "on" : onCount === 0 ? "off" : "mixed";
            const catKey = `${dash.value}|${section}|${group.category}`;
            const catOpen = openCategory === catKey;

            return (
                <div key={catKey} className="border-b border-border last:border-0">
                    <div className="flex items-center gap-3 py-2">
                        <TriStateCheckbox
                            state={state}
                            ariaLabel={`${group.category} for ${dash.label}`}
                            onToggle={(next) => setMany(dash.value, values, next)}
                        />
                        <button
                            type="button"
                            onClick={() => setOpenCategory(catOpen ? null : catKey)}
                            className="flex flex-1 items-center gap-2 text-left"
                        >
                            <ChevronRight
                                className={`h-3.5 w-3.5 text-ink-muted transition-transform ${catOpen ? "rotate-90" : ""}`}
                            />
                            <span className="text-sm text-ink">{group.category}</span>
                            <span className="text-xs text-ink-muted">
                                {onCount}/{values.length}
                            </span>
                        </button>
                    </div>

                    {catOpen && (
                        <ul className="space-y-1 pb-2 pl-10">
                            {group.types.map((t) => (
                                <li key={t.value} className="flex items-center gap-3">
                                    <TriStateCheckbox
                                        state={isOn(dash.value, t.value) ? "on" : "off"}
                                        ariaLabel={`${t.label} for ${dash.label}`}
                                        onToggle={(next) => setOne(dash.value, t.value, next)}
                                    />
                                    <span className="text-sm text-ink">{t.label}</span>
                                    <code className="font-mono text-[11px] text-ink-muted">
                                        {t.value}
                                    </code>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            );
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
                    // What this dashboard is routed: its own 180 days, plus — for
                    // one too new to have any — what the roles it shares an
                    // audience with were sent. `peers` is empty for every
                    // dashboard that stands alone, so `routed` is then exactly
                    // the delivered set this panel has always shown.
                    const peers = data.audience_peers?.[dash.value] ?? [];
                    const routed = new Set([
                        ...(data.observed?.[dash.value] ?? []),
                        ...(data.peer_observed?.[dash.value] ?? []),
                    ]);
                    const seenGroups = groups
                        .map((g) => ({ ...g, types: g.types.filter((t) => routed.has(t.value)) }))
                        .filter((g) => g.types.length > 0);
                    const unseenGroups = groups
                        .map((g) => ({ ...g, types: g.types.filter((t) => !routed.has(t.value)) }))
                        .filter((g) => g.types.length > 0);
                    const unseenCount = totalTypes - routed.size;
                    // Muted is counted over what actually arrives here; a mute on
                    // something never delivered is not a silenced notification.
                    const mutedCount = seenGroups.reduce(
                        (n, g) => n + g.types.filter((t) => !isOn(dash.value, t.value)).length,
                        0,
                    );
                    const open = openDashboard === dash.value;
                    const unseenOpen = showUnseen === dash.value;

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
                                    {routed.size === 0 ? (
                                        <span className="inline-flex items-center gap-1">
                                            <AlertTriangle className="h-3 w-3" />
                                            nothing delivered here in 180d
                                        </span>
                                    ) : mutedCount === 0 ? (
                                        `all ${routed.size} ${peers.length > 0 ? "routed" : "delivered"} here are on`
                                    ) : (
                                        <span className="inline-flex items-center gap-1">
                                            <BellOff className="h-3 w-3" />
                                            {mutedCount} of {routed.size} muted
                                        </span>
                                    )}
                                </span>
                            </button>

                            {open && (
                                <div className="border-t border-border bg-bg/40 px-4 pb-3">
                                    <p className="pt-3 text-xs text-ink-muted">
                                        {routed.size === 0 ? (
                                            <>
                                                No notification has reached this dashboard in the
                                                last 180 days. Every type below is listed for
                                                completeness, but muting one changes nothing until
                                                something is actually routed here.
                                            </>
                                        ) : peers.length > 0 ? (
                                            <>
                                                This dashboard shares one audience with{" "}
                                                <strong>{peers.map(dashboardLabel).join(", ")}</strong>, so it is sent
                                                what they are sent. The{" "}
                                                <strong>{routed.size}</strong> types that audience
                                                actually received in the last 180 days are listed
                                                here; the other {unseenCount} are collapsed below.
                                            </>
                                        ) : (
                                            <>
                                                <strong>{routed.size}</strong> of {totalTypes} types
                                                have actually been delivered to this dashboard in
                                                the last 180 days. The rest are listed under “not
                                                seen” below.
                                            </>
                                        )}
                                    </p>
                                    {renderGroups(dash, seenGroups, "seen")}

                                    {unseenGroups.length > 0 && (
                                        <div className="mt-2 border-t border-border pt-2">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setShowUnseen(unseenOpen ? null : dash.value)
                                                }
                                                className="flex w-full items-center gap-2 py-1 text-left text-xs text-ink-muted hover:text-ink"
                                            >
                                                <ChevronRight
                                                    className={`h-3.5 w-3.5 transition-transform ${unseenOpen ? "rotate-90" : ""}`}
                                                />
                                                {unseenCount} type
                                                {unseenCount === 1 ? "" : "s"}{" "}
                                                {peers.length > 0
                                                    ? "not routed to this dashboard"
                                                    : "not seen on this dashboard in 180 days"}
                                            </button>
                                            {unseenOpen && (
                                                <div className="opacity-70">
                                                    <p className="py-2 text-xs text-ink-muted">
                                                        These are still muteable. It means the event
                                                        has not arrived here recently — it may be
                                                        one this dashboard is never routed (a dealer
                                                        or NBFC portal event, say), or one that
                                                        simply has not fired yet.
                                                    </p>
                                                    {renderGroups(dash, unseenGroups, "unseen")}
                                                </div>
                                            )}
                                        </div>
                                    )}
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
