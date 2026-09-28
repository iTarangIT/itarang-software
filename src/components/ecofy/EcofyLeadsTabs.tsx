"use client";

// The tab strip of the Ecofy leads list — the same strip (icon, label, count
// badge, underline) as the ASM "My Visits" and Inside Sales queues, so an ASM
// / ISR / Sales Head reads this page the way they read their own queue.

import { AlarmClock, CalendarClock, CheckCheck, Inbox, ListChecks, Users } from "lucide-react";
import type { EcofyViewerKind } from "@/lib/ecofy/access";
import { ECOFY_TAB_LABELS, ecofyTabsFor, type EcofyListCounts, type EcofyListTab } from "@/lib/ecofy/listTypes";

const ICONS: Record<EcofyListTab, React.ComponentType<{ className?: string }>> = {
    open: ListChecks,
    queue: Inbox,
    follow_ups: AlarmClock,
    meetings_today: CalendarClock,
    closed: CheckCheck,
    all: Users,
};

export function EcofyLeadsTabs({
    kind,
    active,
    counts,
    onChange,
}: {
    kind: EcofyViewerKind;
    active: EcofyListTab;
    counts: EcofyListCounts | null;
    onChange: (tab: EcofyListTab) => void;
}) {
    return (
        <div className="flex overflow-x-auto border-b border-gray-100">
            {ecofyTabsFor(kind).map((tab) => {
                const Icon = ICONS[tab];
                const isActive = tab === active;
                const count = counts?.[tab];
                const showBadge = typeof count === "number";
                // Amber for follow-ups due, sky for a non-empty pickup queue:
                // the two tabs that are asking for someone's attention.
                const accent =
                    tab === "follow_ups" && (count ?? 0) > 0
                        ? "bg-amber-100 text-amber-700"
                        : tab === "queue" && (count ?? 0) > 0
                          ? "bg-sky-100 text-sky-700"
                          : "bg-gray-100 text-gray-600";
                return (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => onChange(tab)}
                        className={`relative flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition ${
                            isActive
                                ? "border-emerald-600 text-emerald-700"
                                : "border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                        }`}
                    >
                        <Icon className="h-4 w-4" />
                        {ECOFY_TAB_LABELS[kind][tab]}
                        {showBadge && (
                            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${isActive ? "bg-emerald-100 text-emerald-700" : accent}`}>
                                {count}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
