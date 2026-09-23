"use client";

// R-17 — the actual-vs-target cells shared by the admin register and a rep's
// own "My targets" card, so both read a target the same way.

import type { Progress, TargetMetric } from "@/lib/targets/rules";
import { TARGET_METRICS } from "@/lib/targets/rules";

const RAG_TONE = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
} as const;

export function fmtTarget(metric: TargetMetric, n: number | null): string {
    if (n == null) return "—";
    if (TARGET_METRICS[metric].kind === "money") {
        return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
    }
    return n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

export function TargetProgressCells({ metric, p }: { metric: TargetMetric; p: Progress }) {
    return (
        <>
            <td className="px-3 py-2 text-right tabular-nums">{fmtTarget(metric, p.mtd_target)}</td>
            <td className="px-3 py-2 text-right tabular-nums">
                {p.actual == null ? <span className="text-ink-muted" title="Not measurable in the CRM yet">not measured</span> : fmtTarget(metric, p.actual)}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{p.pct_of_mtd == null ? "—" : `${p.pct_of_mtd}%`}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtTarget(metric, p.required_per_day)}</td>
            <td className="px-3 py-2">
                {p.rag && (
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${RAG_TONE[p.rag]}`}>
                        {p.rag}
                    </span>
                )}
            </td>
        </>
    );
}

export const PROGRESS_HEADERS = ["MTD target", "MTD actual", "% of MTD", "Needed / day left", "RAG"];
