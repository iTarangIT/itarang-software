"use client";

// Settings → AI callbacks (D8). Who takes the callbacks Priya promises on
// UNOWNED leads (in turn — a lead with an owner keeps its owner), and whether
// the lead is pushed into that ISR's own NeoDove campaign 15 minutes before the
// promised time. The push stays off until the one-off NeoDove test passes.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";

type Settings = {
    ownerIds: string[];
    neodovePush: boolean;
    updatedAt: string | null;
};
type UserOption = { id: string; name: string | null; role: string | null };

const QUERY_KEY = ["callback-loop-settings"];

export function CallbackLoopForm() {
    const qc = useQueryClient();
    const [draft, setDraft] = useState<{ ownerIds: string[]; neodovePush: boolean } | null>(null);
    const [pick, setPick] = useState("");
    const [saving, setSaving] = useState(false);

    const settingsQ = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/callback-loop", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load");
            return json.data.settings as Settings;
        },
    });
    const usersQ = useQuery({
        queryKey: ["callback-loop-users"],
        queryFn: async () => {
            const res = await fetch("/api/admin/users?roles=inside_sales_rep,asm", { cache: "no-store" });
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
        return <div className="py-8 text-sm text-red-600">Failed to load the callback settings.</div>;
    }

    const saved = settingsQ.data;
    const current = draft ?? { ownerIds: saved.ownerIds, neodovePush: saved.neodovePush };
    const users = usersQ.data ?? [];
    const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? id;
    const dirty = draft !== null;

    const update = (next: Partial<typeof current>) => setDraft({ ...current, ...next });
    const move = (i: number, d: -1 | 1) => {
        const ids = [...current.ownerIds];
        const j = i + d;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        update({ ownerIds: ids });
    };

    async function save() {
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/callback-loop", {
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
                <h3 className="text-sm font-semibold text-ink">AI-call callbacks</h3>
                <p className="mt-1 text-xs text-ink-muted">
                    When Priya promises a callback, raises a complaint, or qualifies a dealer, the lead goes to
                    one named ISR: its current owner, or else the next person on this list, in turn. She gets
                    the call brief, a reminder 15 minutes before the promised time, and the Sales Head is told
                    if there is no call 30 minutes after it.
                </p>
            </div>

            <div className="space-y-2">
                <p className="text-xs font-medium text-ink">Callback owners (in turn)</p>
                {current.ownerIds.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-ink-muted">
                        Nobody yet — callbacks on unowned leads go to the admins&apos; bell only.
                    </p>
                ) : (
                    <ol className="space-y-1">
                        {current.ownerIds.map((id, i) => (
                            <li
                                key={id}
                                className="flex items-center gap-2 rounded-md border border-border bg-surface-subtle px-3 py-1.5 text-xs text-ink"
                            >
                                <span className="w-4 text-ink-muted">{i + 1}.</span>
                                <span className="flex-1">{nameOf(id)}</span>
                                <button type="button" onClick={() => move(i, -1)} aria-label="Move up" className="text-ink-muted hover:text-ink">
                                    <ArrowUp className="h-3 w-3" />
                                </button>
                                <button type="button" onClick={() => move(i, 1)} aria-label="Move down" className="text-ink-muted hover:text-ink">
                                    <ArrowDown className="h-3 w-3" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => update({ ownerIds: current.ownerIds.filter((x) => x !== id) })}
                                    aria-label={`Remove ${nameOf(id)}`}
                                    className="text-ink-muted hover:text-red-600"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </li>
                        ))}
                    </ol>
                )}
                <div className="flex gap-2">
                    <select
                        value={pick}
                        onChange={(e) => setPick(e.target.value)}
                        className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                    >
                        <option value="">Add an ISR…</option>
                        {users
                            .filter((u) => !current.ownerIds.includes(u.id))
                            .map((u) => (
                                <option key={u.id} value={u.id}>
                                    {u.name ?? u.id}
                                    {u.role ? ` (${u.role.replace(/_/g, " ")})` : ""}
                                </option>
                            ))}
                    </select>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!pick}
                        onClick={() => {
                            update({ ownerIds: [...current.ownerIds, pick] });
                            setPick("");
                        }}
                    >
                        Add
                    </Button>
                </div>
            </div>

            <label className="flex items-start gap-2 text-sm text-ink">
                <input
                    type="checkbox"
                    className="mt-1"
                    checked={current.neodovePush}
                    onChange={(e) => update({ neodovePush: e.target.checked })}
                />
                <span>
                    Push callbacks to NeoDove
                    <span className="block text-xs text-ink-muted">
                        15 minutes before the promised time, the lead is sent to the ISR&apos;s own NeoDove campaign
                        with the brief. Turn on only after the one-off test: an owned test lead reaches her NeoDove
                        list and her call comes back under her name.
                    </span>
                </span>
            </label>

            <div className="flex items-center gap-3">
                <Button onClick={save} disabled={!dirty || saving}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Save
                </Button>
                {dirty && (
                    <button type="button" className="text-sm text-ink-muted hover:text-ink" onClick={() => setDraft(null)}>
                        Discard
                    </button>
                )}
                {saved.updatedAt && (
                    <span className="text-[11px] text-ink-muted">
                        Last changed {new Date(saved.updatedAt).toLocaleString("en-IN")}
                    </span>
                )}
            </div>
        </div>
    );
}
