"use client";

// R-17 — the actual-vs-target cells shared by the admin register and a rep's
// own "My targets" card, so both read a target the same way.

import type React from "react";
import type { Progress } from "@/lib/targets/rules";
import { metricKind } from "@/lib/targets/rules";

const RAG_TONE = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
} as const;

/** A target number as it reads: ₹ for money, a custom metric's unit after it. */
export function fmtTarget(metric: string, n: number | null, unit?: string | null): string {
    if (n == null) return "—";
    if (metricKind(metric, unit) === "money") {
        return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
    }
    const v = n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
    return unit?.trim() ? `${v} ${unit.trim()}` : v;
}

export function TargetProgressCells({
    metric,
    p,
    unit,
    actualSlot,
}: {
    metric: string;
    p: Progress;
    unit?: string | null;
    /** Replaces the MTD actual cell's content — a custom metric's hand-entered progress input. */
    actualSlot?: React.ReactNode;
}) {
    const fmt = (n: number | null) => fmtTarget(metric, n, unit);
    return (
        <>
            <td className="px-3 py-2 text-right tabular-nums">{fmt(p.mtd_target)}</td>
            <td className="px-3 py-2 text-right tabular-nums">
                {actualSlot ?? (p.actual == null ? <span className="text-ink-muted" title="Not measurable in the CRM yet">not measured</span> : fmt(p.actual))}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{p.pct_of_mtd == null ? "—" : `${p.pct_of_mtd}%`}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmt(p.required_per_day)}</td>
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
