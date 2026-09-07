"use client";

// Settings → Email Notification (E-282).
//
// The email-channel sibling of NotificationAccessManager. One accordion row per
// notification category with a tri-state master, expanding to the individual
// types — the same interaction model, deliberately, so the two tabs read as one
// screen.
//
// FLAT, NOT PER-DASHBOARD. The bell tab has 17 dashboards because a bell row is
// written per person. Email has no such axis: emit()'s emailTargets() collects
// every resolved target's address and sends ONE message, so a (dashboard, type)
// toggle here would be a control the emitter cannot honour.
//
// STATE IS A DIFF, NOT A MATRIX. `pending` holds only the boxes actually moved,
// so Save sends the smallest payload and "N changes" is free to compute. Moving
// a box back to its SAVED value — the override if one exists, else the code
// default — removes it from the diff, so the count never includes a no-op.
//
// NO "DELIVERED IN 180 DAYS" SPLIT. The bell tab can show that because the
// `notifications` table IS the delivery record. There is no email send log
// anywhere in this codebase, so the equivalent here would be a guess dressed as
// evidence. Every type is simply listed.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Loader2, Lock, MailX } from "lucide-react";

import { TriStateCheckbox, type TriState } from "@/components/ui/tri-state-checkbox";
import { typeGroups } from "@/lib/notifications/registry";

interface OverrideRow {
    notification_type: string;
    enabled: boolean;
}

interface Payload {
    overrides: OverrideRow[];
    /** Types emailWorthy() suppresses in code — the unticked baseline. */
    defaults_off: string[];
    /** Types that are always emailed and cannot be changed here. */
    locked: string[];
    last_change: { updated_at: string; updated_by_name: string | null } | null;
    can_edit: boolean;
}

export function EmailNotificationManager() {
    const qc = useQueryClient();
    const groups = useMemo(() => typeGroups(), []);

    const [pending, setPending] = useState<Map<string, boolean>>(new Map());
    const [openCategory, setOpenCategory] = useState<string | null>(null);
    const [savedAt, setSavedAt] = useState<string | null>(null);

    const query = useQuery<{ success: true; data: Payload }>({
        queryKey: ["notification-email"],
        queryFn: async () => {
            const res = await fetch("/api/admin/notification-email", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load email notification settings");
            return res.json();
        },
    });
    const data = query.data?.data;

    const overrideMap = useMemo(
        () => new Map((data?.overrides ?? []).map((o) => [o.notification_type, o.enabled])),
        [data],
    );
    const defaultsOff = useMemo(() => new Set(data?.defaults_off ?? []), [data]);
    const lockedSet = useMemo(() => new Set(data?.locked ?? []), [data]);
    const canEdit = data?.can_edit ?? false;

    /** The answer currently in the database — the override if any, else the code. */
    const savedValue = (type: string) => overrideMap.get(type) ?? !defaultsOff.has(type);

    const isOn = (type: string) => {
        if (lockedSet.has(type)) return true;
        if (pending.has(type)) return pending.get(type) as boolean;
        return savedValue(type);
    };

    const setMany = (types: string[], next: boolean) => {
        if (!canEdit) return;
        setPending((prev) => {
            const copy = new Map(prev);
            for (const type of types) {
                if (lockedSet.has(type)) continue;
                if (savedValue(type) === next) copy.delete(type);
                else copy.set(type, next);
            }
            return copy;
        });
    };

    const save = useMutation({
        mutationFn: async () => {
            const changes = [...pending.entries()].map(([notification_type, enabled]) => ({
                notification_type,
                enabled,
            }));
            const res = await fetch("/api/admin/notification-email", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ changes }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(body?.error?.message ?? "Could not save email settings");
            }
            return body;
        },
        onSuccess: async () => {
            setPending(new Map());
            setSavedAt(new Date().toLocaleTimeString());
            await qc.invalidateQueries({ queryKey: ["notification-email"] });
        },
    });

    if (query.isLoading) {
        return (
            <div className="flex items-center justify-center py-10 text-ink-muted">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading email settings…
            </div>
        );
    }
    if (query.error || !data) {
        return (
            <div className="flex items-center gap-2 text-sm text-danger">
                <AlertTriangle className="h-4 w-4" />
                {(query.error as Error)?.message ?? "Could not load email settings"}
            </div>
        );
    }

    const offCount = groups.reduce(
        (n, g) => n + g.types.filter((t) => !isOn(t.value)).length,
        0,
    );

    return (
        <div className="space-y-4">
            <header className="space-y-1">
                <h3 className="text-sm font-semibold text-ink">Email Notification</h3>
                <p className="max-w-3xl text-xs text-ink-muted">
                    Which notifications <strong>also go out by email</strong>. Unticking one stops
                    the email; the in-app bell is unaffected and is controlled on the Notification
                    Access tab. Changes apply to new notifications.
                </p>
                <p className="max-w-3xl text-xs text-ink-muted">
                    This governs the general notification email only. Transactional mail —
                    password resets and OTPs, login credentials, agreement and consent links,
                    field-agent and video-KYC dispatch, auction lot mails — is sent by its own
                    dedicated sender and cannot be switched off here.
                </p>
                {data.last_change && (
                    <p className="text-xs text-ink-muted">
                        Last changed by {data.last_change.updated_by_name ?? "someone"} on{" "}
                        {new Date(data.last_change.updated_at).toLocaleString()}
                    </p>
                )}
            </header>

            {!canEdit && (
                <div className="flex items-start gap-2 rounded-md border border-border bg-bg p-3 text-xs text-ink-muted">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                        Read-only for your role. This setting is global — one change here affects
                        what every dealer, NBFC and customer receives — so only an admin can edit
                        it.
                    </span>
                </div>
            )}

            <div className="flex items-center gap-2 rounded-md border border-border bg-bg p-3 text-xs text-ink-muted">
                <MailX className="h-3.5 w-3.5 shrink-0" />
                <span>
                    {offCount === 0 ? (
                        <>Every notification type is currently emailed.</>
                    ) : (
                        <>
                            <strong>{offCount}</strong> type{offCount === 1 ? " is" : "s are"}{" "}
                            currently not emailed.
                        </>
                    )}
                </span>
            </div>

            <div className="divide-y divide-border rounded-lg border border-border">
                {groups.map((group) => {
                    // Locked types are excluded from the master checkbox's set: it
                    // must not read "mixed" forever because of boxes nobody can
                    // move, and toggling it must not send a change the API rejects.
                    const values = group.types.map((t) => t.value);
                    const togglable = values.filter((v) => !lockedSet.has(v));
                    const onCount = values.filter((v) => isOn(v)).length;
                    const togglableOn = togglable.filter((v) => isOn(v)).length;
                    const state: TriState =
                        togglable.length === 0 || togglableOn === togglable.length
                            ? "on"
                            : togglableOn === 0
                              ? "off"
                              : "mixed";
                    const open = openCategory === group.category;

                    return (
                        <div key={group.category}>
                            <div className="flex items-center gap-3 px-4 py-3">
                                <TriStateCheckbox
                                    state={state}
                                    ariaLabel={`Email for ${group.category}`}
                                    onToggle={(next) => setMany(togglable, next)}
                                />
                                <button
                                    type="button"
                                    onClick={() => setOpenCategory(open ? null : group.category)}
                                    className="flex flex-1 items-center gap-2 text-left"
                                >
                                    <ChevronRight
                                        className={`h-4 w-4 shrink-0 text-ink-muted transition-transform ${open ? "rotate-90" : ""}`}
                                    />
                                    <span className="flex-1 text-sm font-medium text-ink">
                                        {group.category}
                                    </span>
                                    <span className="shrink-0 text-xs text-ink-muted">
                                        {onCount} of {values.length} emailed
                                    </span>
                                </button>
                            </div>

                            {open && (
                                <ul className="space-y-1.5 border-t border-border bg-bg/40 px-4 py-3 pl-12">
                                    {group.types.map((t) => {
                                        const locked = lockedSet.has(t.value);
                                        const on = isOn(t.value);
                                        return (
                                            <li key={t.value} className="flex items-center gap-3">
                                                <TriStateCheckbox
                                                    state={on ? "on" : "off"}
                                                    ariaLabel={`Email ${t.label}`}
                                                    onToggle={(next) => setMany([t.value], next)}
                                                />
                                                <span
                                                    className={`text-sm ${on ? "text-ink" : "text-ink-muted"}`}
                                                >
                                                    {t.label}
                                                </span>
                                                <code className="font-mono text-[11px] text-ink-muted">
                                                    {t.value}
                                                </code>
                                                {locked ? (
                                                    <span
                                                        className="inline-flex items-center gap-1 text-[11px] text-ink-muted"
                                                        title="Always emailed — this is the only copy the recipient gets."
                                                    >
                                                        <Lock className="h-3 w-3" />
                                                        always on
                                                    </span>
                                                ) : (
                                                    !on && (
                                                        <span className="text-[11px] text-ink-muted">
                                                            bell only
                                                        </span>
                                                    )
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
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

            {canEdit && (
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
            )}
        </div>
    );
}
