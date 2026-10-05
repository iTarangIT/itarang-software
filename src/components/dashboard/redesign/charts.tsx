"use client";

// The two charts of the CEO overview, drawn as plain SVG so they carry the
// pace projection and the target line the shared MetricsChart cannot.

import React from "react";

import { inr } from "./primitives";

const W = 760;
const H = 250;
const LEFT = 56;
const RIGHT = 16;
const TOP = 16;
const BOTTOM = 232;

function niceMax(v: number): number {
    if (v <= 0) return 1;
    const mag = 10 ** Math.floor(Math.log10(v));
    const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= v) ?? 10;
    return step * mag;
}

function Grid({ max }: { max: number }) {
    return (
        <>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                const y = BOTTOM - f * (BOTTOM - TOP);
                return (
                    <g key={f}>
                        <line x1={LEFT} x2={W - RIGHT} y1={y} y2={y} stroke="#eef1f5" strokeWidth="1" />
                        <text x={LEFT - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#5a6877">
                            {inr(max * f)}
                        </text>
                    </g>
                );
            })}
        </>
    );
}

export type PacePoint = {
    /** Position on the x axis, 1-based (day of month, or bucket number). */
    x: number;
    label: string;
    /** Revenue of this bucket alone; the chart accumulates it. */
    value: number;
};

/**
 * Cumulative revenue across the period. `slots` is the full width of the axis
 * (days in the month); `elapsed` is how far the period has run. When the
 * period is still open the line continues, dashed, at the pace so far. The
 * target line is drawn only when a target exists.
 */
export function RevenuePaceChart({
    points,
    slots,
    elapsed,
    target,
}: {
    points: PacePoint[];
    slots: number;
    elapsed: number;
    target?: number | null;
}) {
    const total = points.reduce((a, p) => a + p.value, 0);
    const open = elapsed > 0 && elapsed < slots;
    const paceEnd = open ? (total / elapsed) * slots : total;
    const max = niceMax(Math.max(paceEnd, target ?? 0, total) * 1.08);
    const X = (i: number) => LEFT + (i / slots) * (W - LEFT - RIGHT);
    const Y = (v: number) => BOTTOM - (v / max) * (BOTTOM - TOP);

    let cum = 0;
    const line: Array<[number, number]> = [[X(0), Y(0)]];
    for (const p of [...points].sort((a, b) => a.x - b.x)) {
        cum += p.value;
        line.push([X(p.x), Y(cum)]);
    }
    const endX = X(open ? elapsed : slots);
    line.push([endX, Y(total)]);
    const path = "M " + line.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");
    const area = `${path} L ${endX.toFixed(1)} ${Y(0).toFixed(1)} L ${X(0).toFixed(1)} ${Y(0).toFixed(1)} Z`;
    const ticks = Array.from(new Set([1, Math.round(slots * 0.25), Math.round(slots * 0.5), Math.round(slots * 0.75), slots])).filter(
        (t) => t >= 1,
    );
    const labelFor = (t: number) => points.find((p) => p.x === t)?.label ?? String(t);

    return (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cumulative revenue across the period">
            <Grid max={max} />
            <path d={area} fill="#2e68b2" opacity="0.08" />
            {target != null && target > 0 && (
                <path
                    d={`M ${X(0)} ${Y(0)} L ${X(slots)} ${Y(target)}`}
                    stroke="#8a96a3"
                    strokeWidth="2"
                    strokeDasharray="6 4"
                    fill="none"
                />
            )}
            <path d={path} stroke="#2e68b2" strokeWidth="2.5" fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {open && (
                <>
                    <path
                        d={`M ${endX} ${Y(total)} L ${X(slots)} ${Y(paceEnd)}`}
                        stroke="#2e68b2"
                        strokeWidth="2"
                        strokeDasharray="3 3"
                        fill="none"
                    />
                    <line x1={endX} x2={endX} y1={TOP} y2={BOTTOM} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="2 3" />
                    <text x={X(slots)} y={Y(paceEnd) - 8} textAnchor="end" fontSize="11.5" fontWeight="700" fill="#2e68b2">
                        {inr(paceEnd)} at this pace
                    </text>
                </>
            )}
            <circle cx={endX} cy={Y(total)} r="4" fill="#2e68b2" />
            <text
                x={endX + (open ? -8 : -8)}
                y={Y(total) - 10}
                textAnchor="end"
                fontSize="12"
                fontWeight="700"
                fill="#02314e"
            >
                {inr(total)}
            </text>
            {ticks.map((t) => (
                <text key={t} x={X(t)} y={H - 2} textAnchor="middle" fontSize="11" fill="#5a6877">
                    {labelFor(t)}
                </text>
            ))}
        </svg>
    );
}

/** Two bars per bucket: revenue (royal) beside costs (orange). */
export function GroupedBarChart({ rows }: { rows: Array<{ label: string; a: number; b: number }> }) {
    const max = niceMax(Math.max(1, ...rows.map((r) => Math.max(r.a, r.b))) * 1.1);
    const slot = (W - LEFT - RIGHT) / Math.max(rows.length, 1);
    const bw = Math.min(30, slot / 3);
    const Y = (v: number) => BOTTOM - (Math.max(v, 0) / max) * (BOTTOM - TOP);
    const last = rows.length - 1;
    return (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Revenue against total costs by month">
            <Grid max={max} />
            {rows.map((r, i) => {
                const cx = LEFT + slot * i + slot / 2;
                return (
                    <g key={r.label}>
                        <rect x={cx - bw - 2} y={Y(r.a)} width={bw} height={BOTTOM - Y(r.a)} rx="3" fill="#2e68b2" />
                        <rect x={cx + 2} y={Y(r.b)} width={bw} height={BOTTOM - Y(r.b)} rx="3" fill="#eb6834" />
                        {i === last && (
                            <>
                                <text x={cx - 4} y={Y(r.a) - 6} textAnchor="end" fontSize="11" fontWeight="700" fill="#02314e">
                                    {inr(r.a)}
                                </text>
                                <text x={cx + 4} y={Y(r.b) - 6} textAnchor="start" fontSize="11" fontWeight="700" fill="#b4441a">
                                    {inr(r.b)}
                                </text>
                            </>
                        )}
                        <text x={cx} y={H - 2} textAnchor="middle" fontSize="11" fill="#5a6877">
                            {r.label}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}
