"use client";

// E-254 — NBFC request SLA. Lets an admin decide how long an NBFC correction /
// document request waits with iTarang before the system routes it on by itself
// — to the dealer (leg 1) and back to the NBFC (leg 2).

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Settings = {
    enabled: boolean;
    /** Whole minutes — leg 1 (NBFC → admin → dealer). */
    forwardSlaMinutes: number;
    /** Whole minutes — leg 2 (dealer → admin → NBFC). */
    pushSlaMinutes: number;
    autoForwardToDealer: boolean;
    autoPushToNbfc: boolean;
};

type WindowKey = "forwardSlaMinutes" | "pushSlaMinutes";

const MIN_MINUTES = 1;
const MAX_MINUTES = 7 * 24 * 60;

/** One-click windows, in minutes. Anything else goes through Custom. */
const PRESETS = [5, 15, 30, 60, 120, 240, 480, 720, 1440, 2880];

const UNITS = [
    { key: "minutes", label: "minutes", mult: 1 },
    { key: "hours", label: "hours", mult: 60 },
    { key: "days", label: "days", mult: 1440 },
] as const;

type UnitKey = (typeof UNITS)[number]["key"];

function formatWindow(minutes: number): string {
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    if (minutes % 1440 === 0) {
        const d = minutes / 1440;
        return `${d} day${d === 1 ? "" : "s"}`;
    }
    if (minutes % 60 === 0) {
        const h = minutes / 60;
        return `${h} hour${h === 1 ? "" : "s"}`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Pick the largest unit that divides the value exactly, so 120 → "2 hours". */
function splitMinutes(minutes: number): { value: number; unit: UnitKey } {
    if (minutes % 1440 === 0) return { value: minutes / 1440, unit: "days" };
    if (minutes % 60 === 0) return { value: minutes / 60, unit: "hours" };
    return { value: minutes, unit: "minutes" };
}

const WINDOWS: {
    key: WindowKey;
    toggle: "autoForwardToDealer" | "autoPushToNbfc";
    title: string;
    hint: string;
    toggleLabel: string;
    toggleHint: string;
}[] = [
    {
        key: "forwardSlaMinutes",
        toggle: "autoForwardToDealer",
        title: "Leg 1 — NBFC request → dealer",
        hint: "From the moment an NBFC correction request, additional-document request or per-document rejection lands on the NBFC Actions card. If nobody forwards, declines or answers it in this time, the system forwards it to the dealer with the NBFC's own comments as the reason.",
        toggleLabel: "Auto-forward to the dealer when leg 1 expires",
        toggleHint: "Turn this off to keep the leg-1 clock visible on the card but leave the forward click to a human.",
    },
    {
        key: "pushSlaMinutes",
        toggle: "autoPushToNbfc",
        title: "Leg 2 — dealer upload → NBFC",
        hint: "From the moment the dealer has uploaded everything the request asked for and it is waiting on your review. If nobody approves or rejects the uploads in this time, the system marks them verified and pushes the request back to the NBFC.",
        toggleLabel: "Auto-verify uploads and push to the NBFC when leg 2 expires",
        toggleHint: "Turn this off to keep the leg-2 clock visible but require a human to verify each upload before it reaches the lender.",
    },
];

export function NbfcRequestSlaForm() {
    const qc = useQueryClient();
    const [draft, setDraft] = useState<Settings | null>(null);
    const [saving, setSaving] = useState(false);

    // Custom entry is held separately per window so typing "1" on the way to
    // "15" doesn't get clamped under the user's cursor.
    const [custom, setCustom] = useState<
        Record<WindowKey, { open: boolean; value: string; unit: UnitKey }>
    >({
        forwardSlaMinutes: { open: false, value: "30", unit: "minutes" },
        pushSlaMinutes: { open: false, value: "30", unit: "minutes" },
    });

    const { data, isLoading } = useQuery({
        queryKey: ["nbfc-request-sla-settings"],
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/nbfc-request-sla");
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to load NBFC request SLA settings");
            }
            return json.data.settings as Settings;
        },
    });

    // Seed the custom controls from whatever is stored, once it arrives.
    useEffect(() => {
        if (!data) return;
        const next = { ...custom };
        for (const w of WINDOWS) {
            const { value, unit } = splitMinutes(data[w.key]);
            next[w.key] = { open: !PRESETS.includes(data[w.key]), value: String(value), unit };
        }
        setCustom(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data]);

    const settings = draft ?? data ?? null;

    function patch(next: Partial<Settings>) {
        if (!settings) return;
        setDraft({ ...settings, ...next });
    }

    function applyCustom(key: WindowKey, rawValue: string, unit: UnitKey) {
        setCustom((c) => ({ ...c, [key]: { ...c[key], value: rawValue, unit } }));
        const mult = UNITS.find((u) => u.key === unit)!.mult;
        const n = Number(rawValue);
        if (!Number.isFinite(n) || n <= 0) return; // let them keep typing
        patch({ [key]: Math.round(n * mult) } as Partial<Settings>);
    }

    async function save() {
        if (!settings) return;
        for (const w of WINDOWS) {
            const m = settings[w.key];
            if (!Number.isInteger(m) || m < MIN_MINUTES || m > MAX_MINUTES) {
                toast.error(`${w.title}: the window must be between 1 minute and 7 days.`);
                return;
            }
        }
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/nbfc-request-sla", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(settings),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Save failed");
            setDraft(null);
            qc.invalidateQueries({ queryKey: ["nbfc-request-sla-settings"] });
            toast.success(
                settings.enabled
                    ? `Saved. NBFC requests auto-forward after ${formatWindow(settings.forwardSlaMinutes)} and dealer uploads auto-push after ${formatWindow(settings.pushSlaMinutes)}.`
                    : "Saved. NBFC request SLA is off.",
            );
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Save failed");
        } finally {
            setSaving(false);
        }
    }

    if (isLoading || !settings) {
        return (
            <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading NBFC request SLA settings…
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
                            Enable the NBFC request SLA
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                            Off by default. While this is off nothing below applies and every
                            NBFC request waits for a human at both legs, as it does today.
                        </span>
                    </span>
                </label>

                {settings.enabled && (
                    <div className="mt-3 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            <strong>Auto-pushed uploads are not reviewed uploads.</strong> When
                            leg 2 expires the system marks the dealer&apos;s files verified{" "}
                            <em>without anyone opening them</em> and hands them to the lender.
                            Every auto-action is stamped as a system action, shown on the NBFC
                            Actions card, and written to the audit log. Direct NBFC → dealer
                            threads are not affected — they never wait on iTarang.
                        </span>
                    </div>
                )}
            </div>

            {/* The two windows */}
            {WINDOWS.map((w) => {
                const c = custom[w.key];
                const value = settings[w.key];
                const selectValue = c.open ? "custom" : String(value);
                return (
                    <div key={w.key} className="space-y-2 rounded-lg border border-border p-4">
                        <label className="block text-sm font-medium text-ink">{w.title}</label>
                        <p className="text-xs text-ink-muted">{w.hint}</p>

                        <div className="flex flex-wrap items-center gap-2">
                            <select
                                className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink disabled:opacity-50"
                                value={selectValue}
                                disabled={!settings.enabled}
                                onChange={(e) => {
                                    if (e.target.value === "custom") {
                                        const { value: v, unit } = splitMinutes(value);
                                        setCustom((cur) => ({
                                            ...cur,
                                            [w.key]: { open: true, value: String(v), unit },
                                        }));
                                        return;
                                    }
                                    setCustom((cur) => ({ ...cur, [w.key]: { ...cur[w.key], open: false } }));
                                    patch({ [w.key]: Number(e.target.value) } as Partial<Settings>);
                                }}
                            >
                                {PRESETS.map((m) => (
                                    <option key={m} value={String(m)}>
                                        {formatWindow(m)}
                                    </option>
                                ))}
                                <option value="custom">Custom…</option>
                            </select>

                            {c.open && (
                                <>
                                    <Input
                                        type="number"
                                        min="1"
                                        step="1"
                                        className="w-24"
                                        value={c.value}
                                        disabled={!settings.enabled}
                                        onChange={(e) => applyCustom(w.key, e.target.value, c.unit)}
                                    />
                                    <select
                                        className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink disabled:opacity-50"
                                        value={c.unit}
                                        disabled={!settings.enabled}
                                        onChange={(e) =>
                                            applyCustom(w.key, c.value, e.target.value as UnitKey)
                                        }
                                    >
                                        {UNITS.map((u) => (
                                            <option key={u.key} value={u.key}>
                                                {u.label}
                                            </option>
                                        ))}
                                    </select>
                                </>
                            )}

                            <span className="text-xs font-medium text-ink-muted">
                                = {formatWindow(value)}
                            </span>
                        </div>

                        <label
                            className={`flex items-start gap-3 pt-1 ${
                                settings.enabled ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                            }`}
                        >
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4"
                                disabled={!settings.enabled}
                                checked={settings[w.toggle]}
                                onChange={(e) =>
                                    patch({ [w.toggle]: e.target.checked } as Partial<Settings>)
                                }
                            />
                            <span>
                                <span className="block text-sm text-ink">{w.toggleLabel}</span>
                                <span className="mt-0.5 block text-xs text-ink-muted">
                                    {w.toggleHint}
                                </span>
                            </span>
                        </label>
                    </div>
                );
            })}

            <p className="text-xs text-ink-muted">
                Both windows are plain wall-clock time — nights, weekends and holidays all
                count — from <strong>1 minute to 7 days</strong>. The sweep runs every 60
                seconds, so a 2-minute window fires within about three. Changing a window
                only affects requests raised, and uploads received, from now on; a request
                already waiting keeps the deadline it was given, and requests that were
                already waiting when you switched this on carry no deadline at all.
            </p>

            <div className="flex items-center gap-3 border-t border-border pt-4">
                <Button onClick={save} disabled={saving || !dirty}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save changes
                </Button>
                {dirty && !saving && (
                    <button
                        type="button"
                        className="text-xs text-ink-muted underline"
                        onClick={() => setDraft(null)}
                    >
                        Discard
                    </button>
                )}
            </div>
        </div>
    );
}
