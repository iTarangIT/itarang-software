"use client";

import { MapPinned, CalendarClock, Compass, CheckCheck } from "lucide-react";
import { ASM_QUEUE_TABS, ASM_TAB_LABELS, type AsmQueueCounts, type AsmQueueTab } from "@/lib/asm/types";

type Props = {
    active: AsmQueueTab;
    counts: AsmQueueCounts | null;
    onChange: (tab: AsmQueueTab) => void;
};

const ICONS: Record<AsmQueueTab, React.ComponentType<{ className?: string }>> = {
    my_visits: MapPinned,
    today: CalendarClock,
    territory: Compass,
    my_closed: CheckCheck,
};

export function AsmQueueTabs({ active, counts, onChange }: Props) {
    return (
        <div className="border-b border-gray-100 flex overflow-x-auto">
            {ASM_QUEUE_TABS.map((tab) => {
                const Icon = ICONS[tab];
                const isActive = tab === active;
                const count = counts?.[tab];
                const showBadge = typeof count === "number";
                const accent =
                    tab === "today" && (count ?? 0) > 0
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-gray-100 text-gray-600";
                return (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => onChange(tab)}
                        className={`relative flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                            isActive
                                ? "border-emerald-600 text-emerald-700"
                                : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                        }`}
                    >
                        <Icon className="h-4 w-4" />
                        {ASM_TAB_LABELS[tab]}
                        {showBadge && (
                            <span
                                className={`text-[10px] font-semibold rounded-md px-1.5 py-0.5 ${isActive ? "bg-emerald-100 text-emerald-700" : accent}`}
                            >
                                {count}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
