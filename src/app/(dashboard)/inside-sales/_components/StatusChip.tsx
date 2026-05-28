// 9-state status chip — BRD §0.7.
// Color tiers chosen so the queue table reads at a glance: cooler tones for
// early lifecycle, warmer for late, success/failure terminal.

import type { LeadStatus } from "@/lib/lifecycle/transitions";

const STATUS_COLORS: Record<LeadStatus, { bg: string; text: string; border: string; label: string }> = {
    New_Unassigned: { bg: "bg-slate-50", text: "text-slate-700", border: "border-slate-200", label: "Unassigned" },
    Assigned_Not_Contacted: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200", label: "Assigned" },
    Under_Discussion: { bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-200", label: "Under Discussion" },
    Commercials_Explained: { bg: "bg-indigo-50", text: "text-indigo-700", border: "border-indigo-200", label: "Commercials Explained" },
    Commercials_Finalised: { bg: "bg-violet-50", text: "text-violet-700", border: "border-violet-200", label: "Commercials Finalised" },
    Awaiting_Customer_Decision: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", label: "Awaiting Decision" },
    Transferred_to_ASM: { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200", label: "Transferred to ASM" },
    Converted: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", label: "Converted" },
    Lost: { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200", label: "Lost" },
};

export function StatusChip({ status, size = "md" }: { status: LeadStatus | null | undefined; size?: "sm" | "md" }) {
    if (!status) {
        return (
            <span className={`inline-flex items-center rounded-md ${size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"} font-medium bg-gray-50 text-gray-500 border border-gray-200`}>
                — no status
            </span>
        );
    }
    const c = STATUS_COLORS[status];
    return (
        <span className={`inline-flex items-center rounded-md ${size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"} font-medium border ${c.bg} ${c.text} ${c.border}`}>
            {c.label}
        </span>
    );
}
