"use client";

// BRD §0.2 / §0.1 — admin-tunable assignment config: AI intent threshold and
// the working-hours / working-days window.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AssignmentConfig } from "@/lib/admin/types";

const DAYS: [string, string][] = [
    ["mon", "Mon"],
    ["tue", "Tue"],
    ["wed", "Wed"],
    ["thu", "Thu"],
    ["fri", "Fri"],
    ["sat", "Sat"],
    ["sun", "Sun"],
];

export function AssignmentConfigForm({
    config,
}: {
    config: AssignmentConfig;
}) {
    const qc = useQueryClient();
    const [threshold, setThreshold] = useState(config.intent_score_threshold);
    const [start, setStart] = useState(config.working_hours_start);
    const [end, setEnd] = useState(config.working_hours_end);
    const [days, setDays] = useState<string[]>(config.working_days);
    const [saving, setSaving] = useState(false);

    function toggleDay(d: string) {
        setDays((prev) =>
            prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
        );
    }

    async function save() {
        if (days.length === 0) {
            toast.error("Select at least one working day.");
            return;
        }
        setSaving(true);
        try {
            const res = await fetch("/api/admin/settings/assignment-config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    intent_score_threshold: threshold,
                    working_hours_start: start,
                    working_hours_end: end,
                    working_days: days,
                }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to save");
            }
            toast.success("Assignment config saved.");
            qc.invalidateQueries({ queryKey: ["admin-settings"] });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-lg space-y-5">
            <div>
                <label className="block text-sm font-medium text-ink mb-1">
                    AI Intent Score Threshold
                </label>
                <Input
                    type="number"
                    min={0}
                    max={100}
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className="w-32"
                />
                <p className="mt-1 text-xs text-ink-muted">
                    Minimum AI score (0–100) for a lead to enter the Inside
                    Sales queue. Default 60.
                </p>
            </div>

            <div className="flex gap-4">
                <div>
                    <label className="block text-sm font-medium text-ink mb-1">
                        Working Hours Start
                    </label>
                    <input
                        type="time"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                        className="h-9 rounded-md border border-border px-2 text-sm"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium text-ink mb-1">
                        Working Hours End
                    </label>
                    <input
                        type="time"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                        className="h-9 rounded-md border border-border px-2 text-sm"
                    />
                </div>
            </div>

            <div>
                <label className="block text-sm font-medium text-ink mb-1.5">
                    Working Days
                </label>
                <div className="flex flex-wrap gap-2">
                    {DAYS.map(([d, label]) => {
                        const on = days.includes(d);
                        return (
                            <button
                                key={d}
                                type="button"
                                onClick={() => toggleDay(d)}
                                className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition ${
                                    on
                                        ? "bg-brand-600 text-white border-brand-600"
                                        : "bg-surface text-ink-muted border-border hover:bg-bg"
                                }`}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
                <Button type="button" onClick={save} disabled={saving}>
                    {saving && (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    )}
                    Save Config
                </Button>
                {config.updated_at && (
                    <span className="text-xs text-ink-muted">
                        Last updated by {config.updated_by_name ?? "—"}
                    </span>
                )}
            </div>
        </div>
    );
}
