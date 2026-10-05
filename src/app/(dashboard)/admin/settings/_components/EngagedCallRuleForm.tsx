"use client";

// Sales Daily settings → "Engaged call" (tracker ID 59). What counts as an
// engaged call in every report: the threshold in seconds, and whose duration
// is a measurement. Saved to app_settings and read by the reports directly, so
// a change shows on the next refresh of any of them.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Source = "neodove" | "reported";

type Payload = {
    settings: {
        minSeconds: number;
        durationSource: Source;
        updated_by_name: string | null;
        updated_at: string | null;
    };
    bounds: { floor: number; ceiling: number; default_seconds: number };
    can_edit: boolean;
};

const QUERY_KEY = ["engaged-call-rule"];

const SOURCES: Array<{ value: Source; title: string; body: string }> = [
    {
        value: "neodove",
        title: "Only the duration NeoDove records",
        body: "A duration a rep types is their own estimate and does not count. While NeoDove sends no duration, reports show “Not measured yet”.",
    },
    {
        value: "reported",
        title: "Also the duration a rep enters",
        body: "A call logged by hand with a duration counts. Calls that come through NeoDove still have no duration, so most calls stay unmeasured.",
    },
];

export function EngagedCallRuleForm() {
    const qc = useQueryClient();
    const [draft, setDraft] = useState<{ seconds: string; source: Source } | null>(null);
    const [saving, setSaving] = useState(false);

    const { data, isLoading, error } = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/engaged-call");
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to load the engaged-call rule");
            }
            return json.data as Payload;
        },
    });

    if (isLoading) {
        return (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </p>
        );
    }
    if (error || !data) {
        return <p className="text-sm text-red-600">{(error as Error)?.message ?? "Could not load."}</p>;
    }

    const saved = { seconds: String(data.settings.minSeconds), source: data.settings.durationSource };
    const form = draft ?? saved;
    const seconds = Number(form.seconds);
    const valid = Number.isInteger(seconds) && seconds >= data.bounds.floor && seconds <= data.bounds.ceiling;
    const dirty = form.seconds !== saved.seconds || form.source !== saved.source;

    async function save() {
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/engaged-call", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ min_seconds: seconds, duration_source: form.source }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to save");
            qc.setQueryData(QUERY_KEY, json.data as Payload);
            setDraft(null);
            toast.success("Saved. Every report uses this from its next refresh.");
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-2xl space-y-5">
            <div>
                <h2 className="text-base font-semibold text-ink">Engaged call</h2>
                <p className="mt-1 text-sm text-ink-muted">
                    A call is engaged when it connected and lasted at least the time below. This one rule is used by
                    the daily email, the Sales dashboard, the CEO control tower, the Admin KPI and the exports.
                </p>
            </div>

            <div>
                <label className="mb-1 block text-sm font-medium text-ink" htmlFor="engaged-min-seconds">
                    Minimum call length (seconds)
                </label>
                <Input
                    id="engaged-min-seconds"
                    type="number"
                    min={data.bounds.floor}
                    max={data.bounds.ceiling}
                    value={form.seconds}
                    disabled={!data.can_edit}
                    onChange={(e) => setDraft({ ...form, seconds: e.target.value })}
                    className="w-32"
                />
                <p className={`mt-1 text-xs ${valid ? "text-ink-muted" : "text-red-600"}`}>
                    A whole number from {data.bounds.floor} to {data.bounds.ceiling}. Default {data.bounds.default_seconds}.
                </p>
            </div>

            <fieldset>
                <legend className="mb-1.5 block text-sm font-medium text-ink">Which call length counts</legend>
                <div className="space-y-2">
                    {SOURCES.map((s) => (
                        <label
                            key={s.value}
                            className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
                                form.source === s.value ? "border-brand-600 bg-bg" : "border-border"
                            }`}
                        >
                            <input
                                type="radio"
                                name="engaged-duration-source"
                                className="mt-1"
                                checked={form.source === s.value}
                                disabled={!data.can_edit}
                                onChange={() => setDraft({ ...form, source: s.value })}
                            />
                            <span>
                                <span className="block text-sm font-medium text-ink">{s.title}</span>
                                <span className="mt-0.5 block text-xs text-ink-muted">{s.body}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            <div className="flex items-center gap-3 pt-1">
                <Button type="button" onClick={save} disabled={saving || !dirty || !valid || !data.can_edit}>
                    {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Save
                </Button>
                <span className="text-xs text-ink-muted">
                    {data.settings.updated_at
                        ? `Last changed by ${data.settings.updated_by_name ?? "—"} on ${new Date(
                              data.settings.updated_at,
                          ).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}`
                        : "Never changed — using the default."}
                </span>
            </div>
        </div>
    );
}
