// Interest level chip (BRD §0.7). Independent of lead_status — owner can
// override with reason.

const COLORS: Record<string, { bg: string; text: string; border: string; label: string }> = {
    hot: { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200", label: "Hot" },
    warm: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", label: "Warm" },
    cold: { bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-200", label: "Cold" },
    order_placed: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", label: "Order Placed" },
};

export function InterestChip({ level }: { level: string | null | undefined }) {
    if (!level) return null;
    const c = COLORS[level.toLowerCase()];
    if (!c) {
        return (
            <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-gray-50 text-gray-600 border border-gray-200">
                {level}
            </span>
        );
    }
    return (
        <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${c.bg} ${c.text} ${c.border}`}>
            {c.label}
        </span>
    );
}
