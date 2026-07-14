'use client';

import {
    ComposedChart,
    Area,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceLine,
} from 'recharts';
import {
    VIZ,
    TICK,
    AXIS_LINE,
    ChartCard,
    Headline,
    Legend,
    TooltipShell,
} from './chart-kit';
import { capacityAxis } from '../capacity-axis';
import type { AhSession, AhSummary, BatteryThresholds, Granularity } from '../types';

interface PeriodPoint {
    key: string;
    label: string;
    mean: number;
    q1: number;
    q3: number;
    n: number;
    _base: number;
    _span: number;
}

function quantile(sorted: number[], q: number): number {
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Capacity by Period — the honest version of "capacity trend over time".
 *
 * The per-cycle chart (AH Trend) cannot support reading a trend off individual points: on the
 * reference battery those points scatter ±15% around the mean, and that scatter is *sampling
 * noise*, not degradation. Averaging the cycles within a period beats the noise down by roughly
 * √n, which is what makes a trend readable at all.
 *
 * The interquartile band is not decoration — it is the reason to trust or distrust each mean.
 * A month whose cycles disagree wildly gets a fat band, and its mean should be weighed
 * accordingly. The sample count `n` is in the tooltip for the same reason: a mean of two cycles
 * is not a mean.
 */
export function CapacityByPeriodChart({
    sessions,
    summary,
    granularity,
    thresholds,
}: {
    sessions: AhSession[];
    summary: AhSummary | undefined;
    granularity: Granularity;
    thresholds?: BatteryThresholds;
}) {
    const rated = summary?.ratedCapacityAh ?? null;

    // Bucket the HIGH-CONFIDENCE cycles. Derived client-side from the SAME payload the per-cycle
    // chart draws, so the two capacity charts can never disagree about a number.
    //
    // Averaging is supposed to beat the sampling noise DOWN. Feeding it the low-confidence
    // estimates — a 2% swing amplifies its Ah error ×50 — would pour that noise straight back in
    // and defeat the only thing this chart is for. A mean of untrustworthy numbers is not a
    // trustworthy number.
    const groups = new Map<string, number[]>();
    for (const s of sessions) {
        if (s.estimated_capacity_ah == null) continue;
        if (s.capacity_confidence !== 'high') continue;
        const d = new Date(s.start_time);
        d.setUTCHours(0, 0, 0, 0);
        if (granularity === 'month') d.setUTCDate(1);
        if (granularity === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
        const key = d.toISOString();
        const list = groups.get(key) ?? [];
        list.push(s.estimated_capacity_ah);
        groups.set(key, list);
    }

    const points: PeriodPoint[] = [...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, values]) => {
            const sorted = [...values].sort((a, b) => a - b);
            const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
            const q1 = Math.round(quantile(sorted, 0.25) * 10) / 10;
            const q3 = Math.round(quantile(sorted, 0.75) * 10) / 10;
            return {
                key,
                label: new Date(key).toLocaleDateString('en-GB', {
                    month: 'short',
                    year: granularity === 'month' ? '2-digit' : undefined,
                    day: granularity === 'month' ? undefined : '2-digit',
                }),
                mean,
                q1,
                q3,
                n: values.length,
                _base: q1,
                _span: Math.round((q3 - q1) * 10) / 10,
            };
        });

    const bands =
        rated != null && rated > 0 && thresholds
            ? {
                  warning: Math.round(rated * thresholds.capacityWarningFrac * 10) / 10,
                  critical: Math.round(rated * thresholds.capacityCriticalFrac * 10) / 10,
              }
            : null;

    const all = points.flatMap((p) => [p.q1, p.q3, p.mean]);
    const yAxis = capacityAxis(bands ? [...all, bands.critical] : all, rated);

    const first = points[0]?.mean ?? null;
    const last = points[points.length - 1]?.mean ?? null;
    const drift = first != null && last != null ? Math.round((last - first) * 10) / 10 : null;

    return (
        <ChartCard
            title="Capacity by Period"
            subtitle="Mean estimated capacity per period, with the interquartile range of the cycles behind it. Averaging beats down the per-cycle sampling noise that makes the individual points unreadable as a trend."
            headline={
                last != null ? (
                    <Headline
                        value={last}
                        unit="Ah latest"
                        sub={
                            drift != null && points.length > 1
                                ? `${drift >= 0 ? '+' : ''}${drift} Ah across ${points.length} periods`
                                : `${points.length} period${points.length === 1 ? '' : 's'}`
                        }
                    />
                ) : undefined
            }
            empty={
                points.length === 0
                    ? 'No cycle in this period has a high-confidence capacity estimate, so there is nothing worth averaging. Every cycle still carries an estimate — see the per-cycle chart above, and its confidence grades.'
                    : undefined
            }
            caveat={
                <>
                    <p>
                        A wide band means the cycles inside that period disagreed with each other, and its
                        mean should be weighed accordingly. Hover for the number of cycles behind each point —
                        a mean of two cycles is not really a mean.
                    </p>
                    <p>
                        Even averaged, this cannot resolve a 1–2%/year degradation: the underlying scatter is
                        a sampling artefact of the poller, and no amount of averaging a handful of cycles per
                        month fixes that. What it <em>can</em> show is a pack whose mean sits well below its
                        nameplate, or one that falls off a cliff.
                    </p>
                </>
            }
        >
            <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={points} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                    <CartesianGrid horizontal vertical={false} stroke={VIZ.grid} />
                    {bands && (
                        <>
                            <ReferenceLine
                                y={bands.warning}
                                stroke={VIZ.warningLine}
                                strokeDasharray="4 3"
                                label={{
                                    value: `Warning ${bands.warning} Ah`,
                                    position: 'insideLeft',
                                    fontSize: 10,
                                    fill: VIZ.warningLine,
                                    dy: -5,
                                }}
                            />
                            <ReferenceLine
                                y={bands.critical}
                                stroke={VIZ.criticalLine}
                                strokeDasharray="4 3"
                                label={{
                                    value: `Critical ${bands.critical} Ah`,
                                    position: 'insideLeft',
                                    fontSize: 10,
                                    fill: VIZ.criticalLine,
                                    dy: -5,
                                }}
                            />
                        </>
                    )}
                    <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={AXIS_LINE} tickMargin={10} />
                    <YAxis
                        domain={yAxis.domain}
                        ticks={yAxis.ticks}
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={52}
                        unit=" Ah"
                    />
                    <Tooltip
                        cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as PeriodPoint | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={p.label}
                                    rows={[
                                        ['Mean capacity', `${p.mean} Ah`],
                                        ['Interquartile range', `${p.q1} – ${p.q3} Ah`],
                                        ['Cycles averaged', String(p.n)],
                                        ...(rated
                                            ? ([['% of rated', `${Math.round((p.mean / rated) * 100)}%`]] as Array<
                                                  [string, string]
                                              >)
                                            : []),
                                    ]}
                                    footer={
                                        p.n < 3 ? (
                                            <p className="text-[11px] text-amber-600">
                                                Only {p.n} cycle{p.n === 1 ? '' : 's'} — treat as indicative.
                                            </p>
                                        ) : undefined
                                    }
                                />
                            );
                        }}
                    />
                    {rated != null && (
                        <ReferenceLine
                            y={rated}
                            stroke="#cbd5e1"
                            strokeDasharray="5 4"
                            label={{
                                value: `Rated ${rated} Ah`,
                                position: 'insideTopRight',
                                fontSize: 10,
                                fill: '#94a3b8',
                                dy: -6,
                            }}
                        />
                    )}
                    <Area
                        type="monotone"
                        dataKey="_base"
                        stackId="iqr"
                        stroke="none"
                        fill="none"
                        isAnimationActive={false}
                    />
                    <Area
                        type="monotone"
                        dataKey="_span"
                        stackId="iqr"
                        stroke="none"
                        fill={VIZ.capacity}
                        fillOpacity={0.12}
                        isAnimationActive={false}
                    />
                    <Line
                        type="monotone"
                        dataKey="mean"
                        name="Mean capacity"
                        stroke={VIZ.capacity}
                        strokeWidth={2}
                        dot={{ r: 4, fill: VIZ.capacity, stroke: '#fff', strokeWidth: 2 }}
                        activeDot={{ r: 6 }}
                        isAnimationActive={false}
                    />
                </ComposedChart>
            </ResponsiveContainer>
            <Legend
                items={[
                    { color: VIZ.capacity, label: 'Mean capacity' },
                    { color: VIZ.capacity, label: 'Interquartile range (shaded)' },
                ]}
            />
        </ChartCard>
    );
}
