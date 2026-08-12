"use client";

// The six stat cards above the merged Leads list. Each one is also a filter —
// clicking "Hot" filters the list to Hot, clicking it again clears it.
//
// The counts come from ONE aggregate that shares the list's WHERE clause
// (fetchLeadListStats), so a card can never disagree with the rows below it.
// Hot/Warm/Cold are deliberately computed WITHOUT the intent filter applied, so
// selecting one doesn't zero the other two and destroy the control.
//
// Replaces the old Total / Hot / Warm / Qualified / Scheduled strip:
//   · Hot/Warm counted `current_status = 'hot' | 'warm'`, but nothing in the
//     codebase ever writes 'hot' to that column (leadStore.ts writes only
//     qualified/warm/cold/disqualified), so Hot was structurally near-zero.
//   · "Qualified" was the same set as Hot under another name — leadStatusFor()
//     calls score >= 75 "qualified", which is exactly the Hot bucket — so it is
//     dropped rather than shown twice.

import type { IntentBucket } from "@/lib/leads/intentBucket";
import type { LeadFilters } from "./filters";

export type LeadStats = {
    hot: number;
    warm: number;
    cold: number;
    unassigned: number;
    scheduled: number;
};

type Card = {
    label: string;
    value: number;
    /** Tailwind text colour for the number. */
    color: string;
    /** Ring colour when this card is the active filter. */
    ring: string;
    active: boolean;
    onClick?: () => void;
    hint: string;
};

type Props = {
    total: number;
    stats: LeadStats;
    filters: LeadFilters;
    onIntent: (bucket: "" | IntentBucket) => void;
    onUnassigned: () => void;
    unassignedActive: boolean;
};

export function LeadsStatCards({
    total,
    stats,
    filters,
    onIntent,
    onUnassigned,
    unassignedActive,
}: Props) {
    const toggleIntent = (b: IntentBucket) => () =>
        onIntent(filters.intent === b ? "" : b);

    const cards: Card[] = [
        {
            label: "Total Leads",
            value: total,
            color: "text-gray-900",
            ring: "",
            active: false,
            hint: "All leads matching the current filters",
        },
        {
            label: "Hot",
            value: stats.hot,
            color: "text-rose-600",
            ring: "ring-rose-400",
            active: filters.intent === "hot",
            onClick: toggleIntent("hot"),
            hint: "Intent score 75 or above",
        },
        {
            label: "Warm",
            value: stats.warm,
            color: "text-amber-600",
            ring: "ring-amber-400",
            active: filters.intent === "warm",
            onClick: toggleIntent("warm"),
            hint: "Intent score 31–74",
        },
        {
            label: "Cold",
            value: stats.cold,
            color: "text-sky-600",
            ring: "ring-sky-400",
            active: filters.intent === "cold",
            onClick: toggleIntent("cold"),
            hint: "Intent score 30 or below, including never-called leads",
        },
        {
            label: "Unassigned",
            value: stats.unassigned,
            color: "text-slate-700",
            ring: "ring-slate-400",
            active: unassignedActive,
            onClick: onUnassigned,
            hint: "No current owner",
        },
        {
            label: "Scheduled",
            value: stats.scheduled,
            color: "text-purple-600",
            ring: "",
            active: false,
            hint: "Has a next call scheduled",
        },
    ];

    return (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {cards.map((c) => {
                const clickable = Boolean(c.onClick);
                return (
                    <button
                        key={c.label}
                        type="button"
                        onClick={c.onClick}
                        disabled={!clickable}
                        title={c.hint}
                        aria-pressed={clickable ? c.active : undefined}
                        className={`rounded-xl border bg-white p-4 text-left transition-all ${
                            c.active
                                ? `border-transparent ring-2 ${c.ring}`
                                : "border-gray-200"
                        } ${
                            clickable
                                ? "cursor-pointer hover:border-gray-400"
                                : "cursor-default"
                        }`}
                    >
                        <p className="mb-1 text-xs text-gray-500">{c.label}</p>
                        <p className={`text-2xl font-bold tabular-nums ${c.color}`}>
                            {c.value.toLocaleString("en-IN")}
                        </p>
                    </button>
                );
            })}
        </div>
    );
}
