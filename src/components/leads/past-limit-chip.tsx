// IDs 85 / 86 — "Past a limit": a clock on this lead (first attempt, owner,
// Hot, retry or field visit) is still running past its time limit. Shown in
// the ISR and ASM queues; the lead's timeline lists which limit and when.

import { AlarmClock } from "lucide-react";

export function PastLimitChip({ className = "" }: { className?: string }) {
    return (
        <span
            title="A time limit on this lead has passed and is still unanswered — open the lead to see which (Admin › Time limits)."
            className={`inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 whitespace-nowrap ${className}`}
        >
            <AlarmClock className="h-3 w-3" />
            Past a limit
        </span>
    );
}
