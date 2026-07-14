'use client';

import type { ReactNode } from 'react';

/**
 * Shared chart vocabulary for the Battery tab: one palette, one card shell, one set of axis
 * and tooltip styles. Twelve charts otherwise repeat the same twenty lines of recharts props,
 * and they drift — one grid goes grey, one axis grows a zero baseline, and the page stops
 * reading as one system.
 *
 * ## The palette
 *
 * Validated, not chosen by eye. Every categorical pair used together on a chart clears the
 * colour-vision-deficiency separation floor on this white surface:
 *
 *   CHARGED vs DISCHARGED   ΔE 96.7 (protan)   — the only two-series chart here
 *   CAPACITY vs CHARGED     ΔE 22.9 (deutan)
 *   WARNING vs CRITICAL     ΔE 27.8 (deutan)   — the threshold rules
 *
 * The band *washes* (BAND_*) are deliberately below text contrast: they are fills, and the
 * meaning is carried by the labelled reference lines drawn over them, never by the colour
 * alone. CAPACITY keeps its original violet so the chart the team already reads does not
 * change identity underneath them.
 */
export const VIZ = {
    capacity: '#7c3aed',
    charged: '#2a78d6',
    discharged: '#eb6834',
    distance: '#2a78d6',
    soc: '#0ea5e9',
    /** Threshold RULES — legible on white (both clear 3:1). */
    warningLine: '#d97706',
    criticalLine: '#d03b3b',
    /** Threshold ZONE washes — fills only; the rules above carry the meaning. */
    bandGood: '#0ca30c',
    bandWarning: '#fab219',
    bandCritical: '#d03b3b',
    /** Charge / discharge shading on the timeline. */
    chargeSpan: '#22c55e',
    dischargeSpan: '#eb6834',
    grid: '#f1f5f9',
    axis: '#e2e8f0',
    tick: '#94a3b8',
} as const;

/** Recessive grid + axis, applied identically everywhere. */
export const TICK = { fontSize: 11, fill: VIZ.tick } as const;
export const AXIS_LINE = { stroke: VIZ.axis } as const;

const MONTH_DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' });
const MONTH_YEAR = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit' });

/** Bucket label that stays readable whether the bucket is a day, a week, or a month. */
export function bucketLabel(iso: string, granularity: 'day' | 'week' | 'month'): string {
    const d = new Date(iso);
    return granularity === 'month' ? MONTH_YEAR.format(d) : MONTH_DAY.format(d);
}

export function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    if (!hours) return `${minutes} min`;
    return `${hours} hr ${minutes} min`;
}

/**
 * The card every chart sits in.
 *
 * `caveat` is a first-class slot rather than an afterthought: several of these charts are only
 * honest with a sentence attached (a breach count is a lower bound; a distance gap is not a
 * zero), and a caveat that lives in a doc nobody opens is not a caveat.
 */
export function ChartCard({
    title,
    subtitle,
    headline,
    caveat,
    empty,
    children,
}: {
    title: string;
    subtitle?: string;
    headline?: ReactNode;
    caveat?: ReactNode;
    /** When set, the chart body is replaced by this message — no empty axes. */
    empty?: string;
    children?: ReactNode;
}) {
    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4 p-6 pb-3">
                <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900">{title}</h3>
                    {subtitle && <p className="text-xs text-gray-500 mt-1 max-w-xl">{subtitle}</p>}
                </div>
                {headline && <div className="text-right shrink-0">{headline}</div>}
            </div>

            {empty ? (
                <div className="h-48 flex items-center justify-center text-center px-8 pb-6">
                    <p className="text-sm text-gray-400 max-w-sm">{empty}</p>
                </div>
            ) : (
                <div className="px-2 pb-1">{children}</div>
            )}

            {caveat && !empty && (
                <div className="px-6 pb-5 pt-3 text-xs text-gray-400 space-y-1.5">{caveat}</div>
            )}
        </div>
    );
}

/** A big number for the card header. Proportional figures — it is not in a column. */
export function Headline({
    value,
    unit,
    sub,
}: {
    value: string | number;
    unit?: string;
    sub?: ReactNode;
}) {
    return (
        <>
            <p className="text-2xl font-semibold text-gray-900 leading-none">
                {value}
                {unit && <span className="text-sm font-medium text-gray-400 ml-1">{unit}</span>}
            </p>
            {sub && <p className="text-xs text-gray-400 mt-1.5">{sub}</p>}
        </>
    );
}

/** The tooltip chrome — a titled card with an aligned label/value table. */
export function TooltipShell({
    title,
    sub,
    rows,
    footer,
}: {
    title: string;
    sub?: string;
    rows: Array<[string, string]>;
    footer?: ReactNode;
}) {
    return (
        <div className="bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden text-xs w-60">
            <div className="px-3.5 pt-3 pb-2 border-b border-gray-100 flex items-baseline justify-between gap-2">
                <span className="font-semibold text-gray-900">{title}</span>
                {sub && <span className="text-gray-400">{sub}</span>}
            </div>
            <table className="w-full">
                <tbody>
                    {rows.map(([label, value]) => (
                        <tr key={label}>
                            <td className="text-gray-500 pl-3.5 pr-3 py-[3px]">{label}</td>
                            {/* tabular-nums: these DO align vertically in a column. */}
                            <td className="text-gray-900 text-right font-medium tabular-nums pr-3.5 py-[3px]">
                                {value}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {footer && <div className="px-3.5 pb-2.5 pt-1">{footer}</div>}
            <div className="h-1.5" />
        </div>
    );
}

/**
 * A legend. Present whenever a chart carries two or more series, so identity is never colour
 * alone — a single-series chart needs none, because its title names it.
 */
export function Legend({
    items,
}: {
    items: Array<{ color: string; label: string; dashed?: boolean }>;
}) {
    return (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-6 pt-3 text-xs text-gray-500">
            {items.map((it) => (
                <span key={it.label} className="inline-flex items-center gap-1.5">
                    <svg width="16" height="10" aria-hidden>
                        <line
                            x1="0"
                            y1="5"
                            x2="16"
                            y2="5"
                            stroke={it.color}
                            strokeWidth="2"
                            strokeDasharray={it.dashed ? '5 4' : undefined}
                        />
                    </svg>
                    {it.label}
                </span>
            ))}
        </div>
    );
}
