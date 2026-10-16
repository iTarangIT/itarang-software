"use client";

// R-17 — the actual-vs-target cells shared by the admin register, a rep's own
// "My targets" card and the team card, so all read a target the same way.
//
// ID 189 labels: every target says "per day" or "per month"; the to-date
// column says how many working days it counts ("Target to date (n of N
// working days)"); "Needed per day" is for the working days left; an actual
// the CRM cannot count reads "not measured" WITH its reason in words — never 0,
// and not only on hover.

import type React from "react";
import type { MetricKind, Progress } from "@/lib/targets/rules";
import { metricKind, targetPeriodLabel, targetSumLabel, targetToDateLabel } from "@/lib/targets/rules";

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

/** "150 per month" / "40 per day". */
export function fmtTargetPer(metric: string, n: number | null, unit?: string | null, kind?: MetricKind): string {
    if (n == null) return "—";
    return `${fmtTarget(metric, n, unit)} ${targetPeriodLabel(kind ?? metricKind(metric, unit))}`;
}

/** "CEO 100 + 50 = 150" (or "CEO 100" with no stretch), in the metric's own format. */
export function fmtTargetSum(metric: string, ceo: number, stretch: number, unit?: string | null): string {
    return targetSumLabel(ceo, stretch, (n) => fmtTarget(metric, n, unit));
}

/** "not measured" with its reason shown as text under it. */
export function NotMeasured({ reason }: { reason?: string | null }) {
    return (
        <span className="inline-block max-w-[220px] text-right text-ink-muted">
            not measured
            {reason && <span className="block text-[10px] leading-snug">{reason}</span>}
        </span>
    );
}

export function TargetProgressCells({
    metric,
    p,
    unit,
    kind,
    actualSlot,
}: {
    metric: string;
    p: Progress;
    unit?: string | null;
    kind?: MetricKind;
    /** Replaces the MTD actual cell's content — a custom metric's hand-entered progress input. */
    actualSlot?: React.ReactNode;
}) {
    const fmt = (n: number | null) => fmtTarget(metric, n, unit);
    const perDay = (kind ?? metricKind(metric, unit)) === "per_day";
    return (
        <>
            <td className="px-3 py-2 text-right tabular-nums">
                {fmt(p.mtd_target)}
                {perDay && <span className="block text-[10px] text-ink-muted">per day</span>}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
                {actualSlot ?? (p.actual == null ? <NotMeasured reason={p.not_measured_reason} /> : fmt(p.actual))}
                {actualSlot == null && p.actual != null && perDay && (
                    <span className="block text-[10px] text-ink-muted">a day, on average</span>
                )}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{p.pct_of_mtd == null ? "—" : `${p.pct_of_mtd}%`}</td>
            <td className="px-3 py-2 text-right tabular-nums">
                {perDay ? <span className="text-[11px] text-ink-muted">a daily rate</span> : fmt(p.required_per_day)}
            </td>
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

/** Column headers for TargetProgressCells; the to-date one names the working days it counts. */
export function progressHeaders(ctx?: { working_days_elapsed: number; working_days_total: number } | null): string[] {
    return [
        ctx ? targetToDateLabel(ctx.working_days_elapsed, ctx.working_days_total) : "Target to date",
        "Actual to date",
        "% of target to date",
        "Needed per day",
        "RAG",
    ];
}

/** @deprecated progressHeaders(context) — names the working days counted. */
export const PROGRESS_HEADERS = progressHeaders();
