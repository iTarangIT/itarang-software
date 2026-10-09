// AI intent-score badge (BRD §0.5). Colour = the same Hot / Warm / Cold bucket
// the /leads list shows for the score (src/lib/leads/intentBucket.ts), so a
// lead reads the same on every screen:
//   ≥ 75   emerald  (Hot — the Qualified cut-off, where the AI marks a lead hot)
//   ≥ 31   amber    (Warm)
//   else   gray     (Cold)
// It used to turn green only at 85, so a normal AI-qualified 75 looked warm.
// Inline pill, no shadow — sits beside the status chip.

import { intentBucketOf, type IntentBucket } from "@/lib/leads/intentBucket";

const TIER: Record<IntentBucket, string> = {
    hot: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warm: "bg-amber-50 text-amber-700 border-amber-200",
    cold: "bg-gray-50 text-gray-600 border-gray-200",
};

export function IntentBadge({ score, size = "md" }: { score: number | null | undefined; size?: "sm" | "md" }) {
    if (score === null || score === undefined) {
        return <span className={size === "sm" ? "text-[10px] text-gray-400" : "text-xs text-gray-400"}>—</span>;
    }
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-md border font-semibold ${TIER[intentBucketOf(score)]} ${size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"}`}
            title="AI intent score (0–100)"
        >
            {score}
        </span>
    );
}
