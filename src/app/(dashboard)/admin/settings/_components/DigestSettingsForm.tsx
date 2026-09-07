"use client";

// E-285/E-286 — the scheduled digest emails. One form, every kind: the sections,
// the headings and the button label all come from the descriptor over the wire,
// so a new digest needs no change here.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Mail, Plus, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MAX_RECIPIENTS = 10;

type Section = {
    key: string;
    label: string;
    hint: string;
    group: "activity" | "backlog";
};

type KindMeta = {
    id: string;
    label: string;
    description: string;
    ctaHref: string;
    ctaLabel: string;
    sections: Section[];
};

type Settings = {
    enabled: boolean;
    recipients: string[];
    morningHour: number;
    morningMinute: number;
    eveningHour: number;
    eveningMinute: number;
    detail: "summary" | "detailed";
    sections: Record<string, boolean>;
    attachExcel: boolean;
};

type RunRow = {
    id: number;
    kind: string;
    digest_date: string;
    slot: string;
    status: string;
    attempts: number;
    recipients: string | null;
    counts: Record<string, number> | null;
    triggered_by: string;
    error: string | null;
    created_at: string;
};

/** "09:00" — the shape both <input type="time"> and the mail use. */
function toTimeValue(hour: number, minute: number): string {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function fromTimeValue(v: string): { hour: number; minute: number } | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
}

function looksLikeEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function formatSent(row: RunRow): string {
    const when = new Date(row.created_at).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
    // `counts` is keyed by the figure's LABEL, so this reads whatever the kind
    // happened to report without knowing anything about it.
    const entries = Object.entries(row.counts ?? {})
        .filter(([, v]) => typeof v === "number" && v > 0)
        .slice(0, 3)
        .map(([k, v]) => `${v} ${k.toLowerCase()}`);
    return entries.length ? `${when} IST · ${entries.join(", ")}` : `${when} IST`;
}

export function DigestSettingsForm({ kind }: { kind: string }) {
    const qc = useQueryClient();
    const [draft, setDraft] = useState<Settings | null>(null);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [newRecipient, setNewRecipient] = useState("");

    const { data, isLoading } = useQuery({
        queryKey: ["digest-settings", kind],
        queryFn: async () => {
            const res = await fetch(`/api/admin/settings/digests/${kind}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to load digest settings");
            }
            return json.data as { settings: Settings; runs: RunRow[]; kind: KindMeta };
        },
    });

    const settings = draft ?? data?.settings ?? null;
    const runs = data?.runs ?? [];
    const meta = data?.kind ?? null;
    const sections = meta?.sections ?? [];

    function patch(next: Partial<Settings>) {
        if (!settings) return;
        setDraft({ ...settings, ...next });
    }

    function addRecipient() {
        if (!settings) return;
        const email = newRecipient.trim().toLowerCase();
        if (!email) return;
        if (!looksLikeEmail(email)) {
            toast.error("That does not look like an email address.");
            return;
        }
        if (settings.recipients.includes(email)) {
            setNewRecipient("");
            return;
        }
        if (settings.recipients.length >= MAX_RECIPIENTS) {
            toast.error(`At most ${MAX_RECIPIENTS} recipients.`);
            return;
        }
        patch({ recipients: [...settings.recipients, email] });
        setNewRecipient("");
    }

    function removeRecipient(email: string) {
        if (!settings) return;
        // The last one is not removable: a digest with no recipients still claims
        // its slot and counts everything, then mails nobody — which reads on the
        // history below exactly like a successful send. Switching it off is how
        // "send to nobody" is spelled.
        if (settings.recipients.length <= 1) {
            toast.error("Keep at least one recipient, or switch the digest off.");
            return;
        }
        patch({ recipients: settings.recipients.filter((r) => r !== email) });
    }

    function toggleSection(key: string, on: boolean) {
        if (!settings) return;
        const next = { ...settings.sections, [key]: on };
        // Refused here as well as on the server: a mail with every block off is
        // not shorter, it is empty — and it still claims its slot and still reads
        // as a successful send in the history below.
        if (!Object.values(next).some(Boolean)) {
            toast.error("Keep at least one section, or switch the digest off.");
            return;
        }
        patch({ sections: next });
    }

    async function save() {
        if (!settings) return;
        if (settings.recipients.length === 0) {
            toast.error("Add at least one recipient.");
            return;
        }
        if (!Object.values(settings.sections).some(Boolean)) {
            toast.error("Keep at least one section, or switch the digest off.");
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(`/api/admin/settings/digests/${kind}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(settings),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Save failed");
            }
            setDraft(null);
            qc.invalidateQueries({ queryKey: ["digest-settings", kind] });
            toast.success(
                settings.enabled
                    ? `Saved. The digest goes out at ${toTimeValue(
                          settings.morningHour,
                          settings.morningMinute,
                      )} and ${toTimeValue(
                          settings.eveningHour,
                          settings.eveningMinute,
                      )} IST.`
                    : "Saved. The digest is switched off.",
            );
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Save failed");
        } finally {
            setSaving(false);
        }
    }

    async function sendTest() {
        setTesting(true);
        try {
            const res = await fetch(`/api/admin/settings/digests/${kind}/test`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Test send failed");
            }
            const d = json.data;
            if (d.sent) {
                toast.success(`Test sent to ${(d.recipients ?? []).join(", ")}.`);
            } else {
                toast.error(d.error ?? "The test did not send.");
            }
            qc.invalidateQueries({ queryKey: ["digest-settings", kind] });
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Test send failed");
        } finally {
            setTesting(false);
        }
    }

    if (isLoading || !settings || !meta) {
        return (
            <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading digest settings…
            </div>
        );
    }

    const dirty = draft !== null;

    return (
        <div className="space-y-6">
            {/* Master switch */}
            <div className="rounded-lg border border-border bg-surface-subtle p-4">
                <label className="flex cursor-pointer items-start gap-3">
                    <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={settings.enabled}
                        onChange={(e) => patch({ enabled: e.target.checked })}
                    />
                    <span>
                        <span className="block text-sm font-medium text-ink">
                            Send the {meta.label} digest
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                            {meta.description} Sent even on a quiet day, so a morning with
                            no mail means something is broken rather than nothing happened.
                        </span>
                    </span>
                </label>
            </div>

            {/* Recipients */}
            <div className="space-y-2">
                <label className="block text-sm font-medium text-ink">Recipients</label>
                <p className="text-xs text-ink-muted">
                    Everyone here gets both emails. At most {MAX_RECIPIENTS} addresses.
                </p>
                <div className="flex flex-wrap gap-2">
                    {settings.recipients.map((email) => (
                        <span
                            key={email}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-sm text-ink"
                        >
                            <Mail className="h-3.5 w-3.5 text-ink-muted" />
                            {email}
                            <button
                                type="button"
                                onClick={() => removeRecipient(email)}
                                className="ml-0.5 rounded-full p-0.5 text-ink-muted hover:bg-surface-subtle hover:text-ink"
                                aria-label={`Remove ${email}`}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2 pt-1">
                    <Input
                        type="email"
                        placeholder="name@example.com"
                        value={newRecipient}
                        onChange={(e) => setNewRecipient(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                addRecipient();
                            }
                        }}
                        className="max-w-xs"
                    />
                    <Button type="button" variant="outline" onClick={addRecipient}>
                        <Plus className="mr-1 h-4 w-4" />
                        Add
                    </Button>
                </div>
            </div>

            {/* Times */}
            <div className="space-y-2">
                <label className="block text-sm font-medium text-ink">
                    When to send (IST)
                </label>
                <div className="flex flex-wrap gap-6">
                    <div className="space-y-1">
                        <span className="block text-xs text-ink-muted">
                            Morning — covers yesterday
                        </span>
                        <Input
                            type="time"
                            value={toTimeValue(settings.morningHour, settings.morningMinute)}
                            onChange={(e) => {
                                const t = fromTimeValue(e.target.value);
                                if (t) patch({ morningHour: t.hour, morningMinute: t.minute });
                            }}
                            className="w-32"
                        />
                    </div>
                    <div className="space-y-1">
                        <span className="block text-xs text-ink-muted">
                            Evening — covers today so far
                        </span>
                        <Input
                            type="time"
                            value={toTimeValue(settings.eveningHour, settings.eveningMinute)}
                            onChange={(e) => {
                                const t = fromTimeValue(e.target.value);
                                if (t) patch({ eveningHour: t.hour, eveningMinute: t.minute });
                            }}
                            className="w-32"
                        />
                    </div>
                </div>
                <p className="text-xs text-ink-muted">
                    The scheduler checks every five minutes, so a digest can arrive a few
                    minutes after the time set here — and one whose server was restarting at
                    the time still goes out once it is back, rather than being skipped.
                </p>
            </div>

            {/* Format */}
            <div className="space-y-3 border-t border-border pt-5">
                <div>
                    <label className="block text-sm font-medium text-ink">
                        What the email contains
                    </label>
                    <p className="mt-0.5 text-xs text-ink-muted">
                        Applies to both the morning and the evening mail, so the two stay
                        comparable.
                    </p>
                </div>

                {/* Detail level */}
                <div className="flex flex-wrap gap-3">
                    {(
                        [
                            {
                                value: "summary" as const,
                                label: "Summary",
                                hint: "Counts only. Shortest.",
                            },
                            {
                                value: "detailed" as const,
                                label: "Detailed",
                                hint: "Figures, plus the items behind each one — who, which dealer, which city.",
                            },
                        ]
                    ).map((opt) => (
                        <label
                            key={opt.value}
                            className={`flex-1 min-w-[220px] cursor-pointer rounded-lg border p-3 ${
                                settings.detail === opt.value
                                    ? "border-primary bg-surface-subtle"
                                    : "border-border bg-surface"
                            }`}
                        >
                            <span className="flex items-start gap-2">
                                <input
                                    type="radio"
                                    name="digest-detail"
                                    className="mt-1 h-4 w-4"
                                    checked={settings.detail === opt.value}
                                    onChange={() => patch({ detail: opt.value })}
                                />
                                <span>
                                    <span className="block text-sm font-medium text-ink">
                                        {opt.label}
                                    </span>
                                    <span className="mt-0.5 block text-xs text-ink-muted">
                                        {opt.hint}
                                    </span>
                                </span>
                            </span>
                        </label>
                    ))}
                </div>
                {settings.detail === "detailed" && (
                    <p className="text-xs text-ink-muted">
                        Long lists are trimmed to 15 rows per section with a “+N more”
                        line — the attachment below is the uncapped version.
                    </p>
                )}

                {/* Sections */}
                <div className="space-y-1.5 pt-1">
                    <span className="block text-xs font-medium text-ink">
                        Sections to include
                    </span>
                    {sections.map((s) => (
                        <label
                            key={s.key}
                            className="flex cursor-pointer items-start gap-2.5 py-0.5"
                        >
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4"
                                checked={settings.sections[s.key]}
                                onChange={(e) => toggleSection(s.key, e.target.checked)}
                            />
                            <span>
                                <span className="block text-sm text-ink">{s.label}</span>
                                <span className="block text-xs text-ink-muted">{s.hint}</span>
                            </span>
                        </label>
                    ))}
                </div>

                {/* Excel attachment */}
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface-subtle p-3">
                    <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={settings.attachExcel}
                        onChange={(e) => patch({ attachExcel: e.target.checked })}
                    />
                    <span>
                        <span className="block text-sm font-medium text-ink">
                            Attach an Excel file
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                            Two sheets: the figures exactly as mailed, and one row for
                            every item behind them. Off by default — an attachment twice a
                            day is a lot for an inbox.
                        </span>
                    </span>
                </label>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button onClick={save} disabled={!dirty || saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save changes
                </Button>
                {dirty && (
                    <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                        Discard
                    </Button>
                )}
                <Button
                    type="button"
                    variant="outline"
                    onClick={sendTest}
                    disabled={testing}
                    className="ml-auto"
                >
                    {testing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <Send className="mr-2 h-4 w-4" />
                    )}
                    Send test now
                </Button>
            </div>
            {dirty && (
                <p className="-mt-3 text-xs text-amber-700">
                    The test sends the <em>saved</em> settings, not the unsaved changes above.
                </p>
            )}

            {/* History */}
            <div className="space-y-2">
                <h2 className="text-sm font-medium text-ink">Recent sends</h2>
                {runs.length === 0 ? (
                    <p className="text-xs text-ink-muted">
                        Nothing sent yet.
                    </p>
                ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {runs.map((row) => (
                            <li
                                key={row.id}
                                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-xs"
                            >
                                <span className="font-medium capitalize text-ink">
                                    {row.slot}
                                </span>
                                <span
                                    className={
                                        row.status === "sent"
                                            ? "text-emerald-700"
                                            : row.status === "failed"
                                              ? "text-red-700"
                                              : "text-ink-muted"
                                    }
                                >
                                    {row.status}
                                </span>
                                <span className="text-ink-muted">{formatSent(row)}</span>
                                {row.error && (
                                    <span className="w-full text-red-700">{row.error}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
