// AI intent-score badge (BRD §0.5). Color tiers use the central thresholds:
//   ≥ HOT_BADGE (85)        emerald  ("hot")
//   ≥ QUALIFIED (75)        amber    ("warm")
//   else gray
// Inline pill, no shadow — sits beside the status chip.

import { INTENT_THRESHOLDS, HOT_BADGE } from "@/lib/ai/scoring/thresholds";

export function IntentBadge({ score, size = "md" }: { score: number | null | undefined; size?: "sm" | "md" }) {
    if (score === null || score === undefined) {
        return <span className={size === "sm" ? "text-[10px] text-gray-400" : "text-xs text-gray-400"}>—</span>;
    }
    const tier =
        score >= HOT_BADGE
            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
            : score >= INTENT_THRESHOLDS.QUALIFIED
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : "bg-gray-50 text-gray-600 border-gray-200";
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-md border font-semibold ${tier} ${size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"}`}
            title="AI intent score (0–100)"
        >
            {score}
        </span>
    );
}
