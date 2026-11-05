"use client";

// Settings → Dialer alerts (Priya KPI tracker tasks 5 and 10). Who is told when
// the carrier refuses calls and a campaign pauses, who gets the nightly AI
// dialer quality readout, and the number the carrier probe rings.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";

type Settings = {
    userIds: string[];
    emails: string[];
    probeNumber: string;
    agentVersion: string;
    changeTested: string;
    updatedAt: string | null;
};
type Draft = Omit<Settings, "updatedAt">;
type UserOption = { user_id: string; name: string | null; email: string; role: string | null };

const QUERY_KEY = ["dialer-alerts-settings"];
const PICKABLE_ROLES = "admin,ceo,it,business_head,sales_head,sales_manager,inside_sales_rep";

export function DialerAlertsForm() {
    const qc = useQueryClient();
    const [draft, setDraft] = useState<Draft | null>(null);
    const [pick, setPick] = useState("");
    const [newEmail, setNewEmail] = useState("");
    const [saving, setSaving] = useState(false);

    const settingsQ = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/dialer-alerts", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load");
            return json.data.settings as Settings;
        },
    });
    const usersQ = useQuery({
        queryKey: ["dialer-alerts-users"],
        queryFn: async () => {
            const res = await fetch(`/api/admin/users?roles=${PICKABLE_ROLES}`, { cache: "no-store" });
            const json = await res.json();
            return (json?.data?.users ?? []) as UserOption[];
        },
    });

    if (settingsQ.isLoading) {
        return (
            <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
            </div>
        );
    }
    if (settingsQ.error || !settingsQ.data) {
        return <div className="py-8 text-sm text-red-600">Failed to load the dialer alert settings.</div>;
    }

    const saved = settingsQ.data;
    const current: Draft = draft ?? {
        userIds: saved.userIds,
        emails: saved.emails,
        probeNumber: saved.probeNumber,
        agentVersion: saved.agentVersion,
        changeTested: saved.changeTested,
    };
    const users = usersQ.data ?? [];
    const labelOf = (id: string) => {
        const u = users.find((x) => x.user_id === id);
        return u ? `${u.name ?? u.email}${u.role ? ` · ${u.role}` : ""}` : id;
    };
    const update = (next: Partial<Draft>) => setDraft({ ...current, ...next });
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim());

    async function save() {
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/dialer-alerts", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(current),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Save failed");
            setDraft(null);
            qc.invalidateQueries({ queryKey: QUERY_KEY });
            toast.success("Saved.");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Save failed");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-sm font-semibold text-ink">AI dialer alerts</h3>
                <p className="mt-1 text-xs text-ink-muted">
                    When the carrier refuses 10 calls in a row (SIP 401 / 403 / 407 / 429 / 503) the campaign pauses and
                    these people get one alert. A test call to the probe number then runs every 30 minutes between
                    10:00 and 19:00 (up to 6) and resumes the campaign once one goes through. The same people get the
                    AI dialer quality readout every evening by 19:30.
                </p>
            </div>

            <div className="space-y-2">
                <p className="text-xs font-medium text-ink">People (bell + email)</p>
                {current.userIds.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-ink-muted">
                        Nobody yet — admins, the CEO and IT get the alerts until someone is added.
                    </p>
                ) : (
                    <ul className="space-y-1">
                        {current.userIds.map((id) => (
                            <li
                                key={id}
                                className="flex items-center gap-2 rounded-md border border-border bg-surface-subtle px-3 py-1.5 text-xs text-ink"
                            >
                                <span className="flex-1">{labelOf(id)}</span>
                                <button
                                    type="button"
                                    onClick={() => update({ userIds: current.userIds.filter((x) => x !== id) })}
                                    aria-label={`Remove ${labelOf(id)}`}
                                    className="text-ink-muted hover:text-red-600"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex gap-2">
                    <select
                        value={pick}
                        onChange={(e) => setPick(e.target.value)}
                        className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                        aria-label="Add a person"
                    >
                        <option value="">Add a person…</option>
                        {users
                            .filter((u) => !current.userIds.includes(u.user_id))
                            .map((u) => (
                                <option key={u.user_id} value={u.user_id}>
                                    {u.name ?? u.email} {u.role ? `(${u.role})` : ""}
                                </option>
                            ))}
                    </select>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!pick}
                        onClick={() => {
                            update({ userIds: [...current.userIds, pick] });
                            setPick("");
                        }}
                    >
                        Add
                    </Button>
                </div>
            </div>

            <div className="space-y-2">
                <p className="text-xs font-medium text-ink">Other email addresses</p>
                <div className="flex flex-wrap gap-1.5">
                    {current.emails.map((e) => (
                        <span
                            key={e}
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-subtle px-2 py-0.5 text-xs text-ink"
                        >
                            {e}
                            <button
                                type="button"
                                onClick={() => update({ emails: current.emails.filter((x) => x !== e) })}
                                aria-label={`Remove ${e}`}
                                className="text-ink-muted hover:text-red-600"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input
                        type="email"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        placeholder="name@itarang.com"
                        className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                        aria-label="Add an email address"
                    />
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!emailOk || current.emails.includes(newEmail.trim().toLowerCase())}
                        onClick={() => {
                            update({ emails: [...current.emails, newEmail.trim().toLowerCase()] });
                            setNewEmail("");
                        }}
                    >
                        Add
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
                <label className="space-y-1 text-xs">
                    <span className="font-medium text-ink">Probe number</span>
                    <input
                        value={current.probeNumber}
                        onChange={(e) => update({ probeNumber: e.target.value })}
                        inputMode="tel"
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                    />
                    <span className="block text-ink-muted">Rung by the test call while a campaign is paused.</span>
                </label>
                <label className="space-y-1 text-xs">
                    <span className="font-medium text-ink">Agent version (readout)</span>
                    <input
                        value={current.agentVersion}
                        onChange={(e) => update({ agentVersion: e.target.value })}
                        placeholder="v27"
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                    />
                </label>
                <label className="space-y-1 text-xs">
                    <span className="font-medium text-ink">Change tested today (readout)</span>
                    <input
                        value={current.changeTested}
                        onChange={(e) => update({ changeTested: e.target.value })}
                        placeholder="v27 opener"
                        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                    />
                </label>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
                <p className="text-xs text-ink-muted">
                    {saved.updatedAt ? `Last saved ${new Date(saved.updatedAt).toLocaleString("en-IN")}` : "Not saved yet"}
                </p>
                <div className="flex gap-2">
                    {draft && (
                        <Button type="button" variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                            Discard
                        </Button>
                    )}
                    <Button type="button" onClick={save} disabled={!draft || saving}>
                        {saving ? "Saving…" : "Save"}
                    </Button>
                </div>
            </div>
        </div>
    );
}
