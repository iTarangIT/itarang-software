// IDs 85 / 86 — "Past a limit": a clock on this lead (first attempt, owner,
// Hot, retry or field visit) is still running past its time limit. Shown in
// the ISR and ASM queues; the lead's timeline lists which limit and when.

import { AlarmClock } from "lucide-react";

export function PastLimitChip({ className = "", limits }: { className?: string; limits?: string[] }) {
    // 18 Oct row 34: the chip names the limit(s) passed.
    const named = limits?.filter(Boolean) ?? [];
    return (
        <span
            title={
                named.length
                    ? `Past: ${named.join("; ")} — still unanswered (Admin › Time limits).`
                    : "A time limit on this lead has passed and is still unanswered — open the lead to see which (Admin › Time limits)."
            }
            className={`inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 whitespace-nowrap ${className}`}
        >
            <AlarmClock className="h-3 w-3" />
            {named.length ? `Past: ${named[0]}${named.length > 1 ? ` +${named.length - 1}` : ""}` : "Past a limit"}
        </span>
    );
}
