"use client";

// Tracker ID 197 (PJP phase 1) — "Which day(s) was this travel?" on Submit
// Expense for Travel and Vehicle/Fuel. Each picked day shows its verdict
// before submitting — Supported (a verified visit that day, ID 196) or Not
// supported — and a Not supported day needs a note. The server re-checks all
// of it (POST /api/expenses/submit).

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { MAX_CLAIM_DAYS_BACK, VERDICT_LABEL, type DayVerdict } from "@/lib/expenses/travelProof";
import { istDay } from "@/lib/visits/verifiedCapture";

export type PickedDay = {
    day: string;
    note: string;
    verdict?: DayVerdict;
    verifiedVisits?: number;
    unverifiedVisits?: number;
    calls?: number;
    alreadyClaimed?: boolean;
    error?: string;
    loading?: boolean;
};

function shiftDay(day: string, n: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Every picked day has its verdict, none is already claimed, and every Not supported day has a note. */
export function travelDaysReady(days: readonly PickedDay[]): string | null {
    if (days.length === 0) return "Pick the day(s) this travel was on.";
    for (const d of days) {
        if (d.loading) return "Checking the visits for the picked days…";
        if (d.error) return `${d.day}: ${d.error}`;
        if (d.alreadyClaimed) return `${d.day} is already in another claim of this category.`;
        if (d.verdict === "not_supported" && !d.note.trim()) return `${d.day} has no verified visit: add a note.`;
    }
    return null;
}

export function TravelDaysPicker({
    category,
    value,
    onChange,
}: {
    category: string;
    value: PickedDay[];
    onChange: (next: PickedDay[] | ((prev: PickedDay[]) => PickedDay[])) => void;
}) {
    const today = istDay(new Date());
    const [pick, setPick] = useState(today);

    const load = async (day: string) => {
        try {
            const r = await fetch(
                `/api/expenses/travel-proof?day=${encodeURIComponent(day)}&category=${encodeURIComponent(category)}`,
                { cache: "no-store" },
            );
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Could not check this day");
            const visits = (j.data.visits ?? []) as Array<{ verified: boolean }>;
            onChange((prev) =>
                prev.map((d) =>
                    d.day === day
                        ? {
                              ...d,
                              loading: false,
                              error: undefined,
                              verdict: j.data.verdict,
                              verifiedVisits: visits.filter((v) => v.verified).length,
                              unverifiedVisits: visits.filter((v) => !v.verified).length,
                              calls: j.data.calls,
                              alreadyClaimed: !!j.data.already_claimed,
                          }
                        : d,
                ),
            );
        } catch (e) {
            onChange((prev) => prev.map((d) => (d.day === day ? { ...d, loading: false, error: (e as Error).message } : d)));
        }
    };

    // A category change (Travel ↔ Vehicle/Fuel) changes "already claimed": re-check every day.
    useEffect(() => {
        for (const d of value) void load(d.day);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the category changes
    }, [category]);

    const add = () => {
        if (!pick || value.some((d) => d.day === pick)) return;
        onChange((prev) => [...prev, { day: pick, note: "", loading: true }].sort((a, b) => a.day.localeCompare(b.day)));
        void load(pick);
    };

    return (
        <div className="space-y-3">
            <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider">
                Which day(s) was this travel? <span className="text-rose-600">*</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
                <input
                    type="date"
                    value={pick}
                    min={shiftDay(today, -MAX_CLAIM_DAYS_BACK)}
                    max={today}
                    onChange={(e) => setPick(e.target.value)}
                    className="px-3 py-2 rounded-xl border border-gray-200 text-sm"
                />
                <button
                    type="button"
                    onClick={add}
                    className="px-3 py-2 rounded-xl border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                    Add day
                </button>
                <span className="text-xs text-gray-500">Today or up to {MAX_CLAIM_DAYS_BACK} days back. Each day is judged on its own.</span>
            </div>
            {value.length > 0 && (
                <ul className="space-y-2">
                    {value.map((d) => (
                        <li key={d.day} className="rounded-xl border border-gray-200 p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-gray-900">{d.day}</span>
                                {d.loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
                                {d.verdict && (
                                    <span
                                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                            d.verdict === "supported" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                                        }`}
                                    >
                                        {VERDICT_LABEL[d.verdict]}
                                    </span>
                                )}
                                {d.verdict && (
                                    <span className="text-xs text-gray-500">
                                        {d.verifiedVisits ?? 0} verified visit{d.verifiedVisits === 1 ? "" : "s"}
                                        {d.unverifiedVisits ? ` · ${d.unverifiedVisits} not verified` : ""} · {d.calls ?? 0} calls
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => onChange((prev) => prev.filter((x) => x.day !== d.day))}
                                    className="ml-auto text-gray-400 hover:text-rose-600"
                                    aria-label={`Remove ${d.day}`}
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>
                            {d.alreadyClaimed && (
                                <p className="mt-1 text-xs text-rose-700">Already in another pending or approved claim of this category.</p>
                            )}
                            {d.error && <p className="mt-1 text-xs text-rose-700">{d.error}</p>}
                            {d.verdict === "not_supported" && (
                                <textarea
                                    value={d.note}
                                    onChange={(e) =>
                                        onChange((prev) => prev.map((x) => (x.day === d.day ? { ...x, note: e.target.value } : x)))
                                    }
                                    rows={2}
                                    maxLength={1000}
                                    placeholder="No verified visit that day — what was the travel for? (required)"
                                    className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
