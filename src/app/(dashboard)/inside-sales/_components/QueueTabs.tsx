"use client";

import { ListChecks, AlarmClock, Inbox, Users, CheckCheck } from "lucide-react";
import { QUEUE_TABS, TAB_LABELS, type QueueCounts, type QueueTab } from "@/lib/inside-sales/types";

type Props = {
    active: QueueTab;
    counts: QueueCounts | null;
    onChange: (tab: QueueTab) => void;
};

const ICONS: Record<QueueTab, React.ComponentType<{ className?: string }>> = {
    my_open: ListChecks,
    follow_ups: AlarmClock,
    unassigned: Inbox,
    team: Users,
    my_closed: CheckCheck,
};

export function QueueTabs({ active, counts, onChange }: Props) {
    return (
        <div className="border-b border-gray-100 flex overflow-x-auto">
            {QUEUE_TABS.map((tab) => {
                const Icon = ICONS[tab];
                const isActive = tab === active;
                const count = counts?.[tab];
                const showBadge = typeof count === "number";
                const accent =
                    tab === "follow_ups" && (count ?? 0) > 0
                        ? "bg-amber-100 text-amber-700"
                        : tab === "unassigned" && (count ?? 0) > 0
                            ? "bg-sky-100 text-sky-700"
                            : "bg-gray-100 text-gray-600";
                return (
                    <button
                        key={tab}
                        type="button"
                        onClick={() => onChange(tab)}
                        className={`relative flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                            isActive
                                ? "border-blue-600 text-blue-700"
                                : "border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                        }`}
                    >
                        <Icon className="h-4 w-4" />
                        {TAB_LABELS[tab]}
                        {showBadge && (
                            <span
                                className={`text-[10px] font-semibold rounded-md px-1.5 py-0.5 ${isActive ? "bg-blue-100 text-blue-700" : accent}`}
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
