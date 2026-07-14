'use client';

import {
    BarChart,
    Bar,
    LineChart,
    Line,
    ScatterChart,
    Scatter,
    XAxis,
    YAxis,
    ZAxis,
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
    TooltipShell,
    bucketLabel,
} from './chart-kit';
import type { DistanceData, DischargeKmData, Granularity } from '../types';

/**
 * Kilometre Trend — distance per bucket.
 *
 * A separate chart from the cumulative view below, and deliberately so: per-bucket km and
 * cumulative km differ by two orders of magnitude, and putting them on one canvas would need a
 * second y-axis. A dual axis lets a reader compare two lines whose heights mean different
 * things, which is the single most common way a chart lies. Two charts, one axis each.
 */
export function DistanceTrendChart({
    data,
    granularity,
}: {
    data: DistanceData | undefined;
    granularity: Granularity;
}) {
    const buckets = data?.buckets ?? [];
    const s = data?.summary;

    const rows = buckets.map((b) => ({
        t: bucketLabel(b.bucket, granularity),
        bucket: b.bucket,
        km: b.km,
        hasTelemetry: b.has_telemetry,
    }));

    const unknown = s?.bucketsWithoutDistance ?? 0;

    return (
        <ChartCard
            title="Kilometre Trend"
            subtitle="Distance driven per period, from the daily distance rollup — the only populated distance source on this fleet."
            headline={
                s ? (
                    <Headline
                        value={s.totalKm.toLocaleString()}
                        unit="km"
                        sub={`${s.avgKmPerActiveBucket} km per active ${granularity} · ${s.activeBuckets} active`}
                    />
                ) : undefined
            }
            empty={rows.length === 0 ? 'No distance recorded in this period.' : undefined}
            caveat={
                unknown > 0 ? (
                    <p>
                        <strong>{unknown}</strong> {granularity}
                        {unknown === 1 ? '' : 's'} in this period have battery telemetry but no distance
                        row, so their distance is <strong>unknown, not zero</strong> — they are drawn as
                        gaps. The total above is therefore a lower bound. A missing rollup row means the
                        aggregator did not write, which is not the same as the vehicle standing still.
                    </p>
                ) : undefined
            }
        >
            <ResponsiveContainer width="100%" height={280}>
                <BarChart data={rows} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                    <CartesianGrid horizontal vertical={false} stroke={VIZ.grid} />
                    <XAxis
                        dataKey="t"
                        tick={TICK}
                        tickLine={false}
                        axisLine={AXIS_LINE}
                        tickMargin={10}
                        interval="preserveStartEnd"
                        minTickGap={24}
                    />
                    {/* A zero baseline IS correct here: bar LENGTH encodes the value. */}
                    <YAxis tick={TICK} tickLine={false} axisLine={false} tickMargin={8} width={48} unit=" km" />
                    <Tooltip
                        cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as
                                | { bucket: string; km: number | null; hasTelemetry: boolean }
                                | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={bucketLabel(p.bucket, granularity)}
                                    rows={[
                                        ['Distance', p.km != null ? `${p.km} km` : 'unknown'],
                                        ['Battery telemetry', p.hasTelemetry ? 'yes' : 'none'],
                                    ]}
                                    footer={
                                        p.km == null ? (
                                            <p className="text-[11px] text-amber-600">
                                                No distance row — unknown, not zero.
                                            </p>
                                        ) : undefined
                                    }
                                />
                            );
                        }}
                    />
                    {/* Bars with a null km simply do not render — a gap, never a zero-height bar
                      * sitting on the baseline pretending the vehicle was parked. */}
                    <Bar dataKey="km" name="Distance" fill={VIZ.distance} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}

/** Cumulative Kilometre — the running total. Its own chart, its own axis (see above). */
export function CumulativeDistanceChart({
    data,
    granularity,
}: {
    data: DistanceData | undefined;
    granularity: Granularity;
}) {
    const buckets = data?.buckets ?? [];
    const s = data?.summary;

    // connectNulls is deliberately OFF below, so a bucket with unknown distance breaks the
    // line rather than being interpolated through. The reader sees the hole in the record.
    const rows = buckets.map((b) => ({
        t: bucketLabel(b.bucket, granularity),
        bucket: b.bucket,
        cum: b.km == null ? null : b.cum_km,
        km: b.km,
    }));

    return (
        <ChartCard
            title="Cumulative Distance"
            subtitle="Total kilometres accumulated across the period. The line breaks wherever distance is unknown."
            headline={
                s ? (
                    <Headline
                        value={s.totalKm.toLocaleString()}
                        unit="km total"
                        sub={s.bucketsWithoutDistance > 0 ? 'lower bound — see the gaps' : 'complete record'}
                    />
                ) : undefined
            }
            empty={rows.length === 0 ? 'No distance recorded in this period.' : undefined}
        >
            <ResponsiveContainer width="100%" height={280}>
                <LineChart data={rows} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                    <CartesianGrid horizontal vertical={false} stroke={VIZ.grid} />
                    <XAxis
                        dataKey="t"
                        tick={TICK}
                        tickLine={false}
                        axisLine={AXIS_LINE}
                        tickMargin={10}
                        interval="preserveStartEnd"
                        minTickGap={24}
                    />
                    <YAxis tick={TICK} tickLine={false} axisLine={false} tickMargin={8} width={56} unit=" km" />
                    <Tooltip
                        cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as
                                | { bucket: string; cum: number | null; km: number | null }
                                | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={bucketLabel(p.bucket, granularity)}
                                    rows={[
                                        ['This period', p.km != null ? `${p.km} km` : 'unknown'],
                                        ['Cumulative', p.cum != null ? `${p.cum} km` : '—'],
                                    ]}
                                />
                            );
                        }}
                    />
                    <Line
                        type="monotone"
                        dataKey="cum"
                        name="Cumulative distance"
                        stroke={VIZ.distance}
                        strokeWidth={2}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}

/**
 * Discharge vs Kilometre — the efficiency scatter.
 *
 * One point per DAY, not per discharge cycle. Distance exists only as a daily rollup (the
 * per-trip table is empty fleet-wide), so splitting a day's kilometres between the several
 * discharge cycles inside it would be an invention. The day is the finest honest unit.
 *
 * The slope is the pack's Ah/km. A battery drifting upward off the reference line is doing
 * more work for the same distance — which is what degradation looks like from the driver's seat.
 */
export function DischargeVsKmChart({ data }: { data: DischargeKmData | undefined }) {
    const points = data?.points ?? [];
    const s = data?.summary;
    const slope = s?.avgAhPerKm ?? null;

    const rows = points.map((p) => ({
        km: p.km,
        ah: p.ah_discharged,
        ratio: p.ah_per_km,
        cycles: p.cycles,
        day: p.day,
    }));

    const maxKm = rows.length ? Math.max(...rows.map((r) => r.km)) : 0;

    return (
        <ChartCard
            title="Discharge vs Kilometres"
            subtitle="One point per day: amp-hours drawn against kilometres driven. The dashed line is the pack's average efficiency — points above it did more work per kilometre."
            headline={
                s ? (
                    <Headline
                        value={slope != null ? slope.toFixed(2) : '—'}
                        unit="Ah / km"
                        sub={`${s.days} days · ${s.totalKm.toLocaleString()} km`}
                    />
                ) : undefined
            }
            empty={rows.length === 0 ? 'No day in this period has both a discharge cycle and a distance reading.' : undefined}
            caveat={
                <>
                    <p>
                        The headline is the aggregate ratio (total Ah ÷ total km), not the average of the
                        per-day ratios. A day where cycle detection resolved only part of the discharge
                        would otherwise count as much as a fully-resolved one, and drag the number down.
                    </p>
                    {(s?.daysWithoutDischarge ?? 0) > 0 && (
                        <p>
                            <strong>{s?.daysWithoutDischarge}</strong> days had kilometres but no resolvable
                            discharge cycle, and are left out rather than plotted at zero Ah. This scatter is a
                            sample of the period, not a census of it.
                        </p>
                    )}
                </>
            }
        >
            <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 16, right: 24, left: 8, bottom: 14 }}>
                    <CartesianGrid stroke={VIZ.grid} />
                    <XAxis
                        type="number"
                        dataKey="km"
                        name="Distance"
                        unit=" km"
                        tick={TICK}
                        tickLine={false}
                        axisLine={AXIS_LINE}
                        tickMargin={8}
                        label={{ value: 'Kilometres driven', position: 'insideBottom', offset: -8, fontSize: 11, fill: VIZ.tick }}
                    />
                    <YAxis
                        type="number"
                        dataKey="ah"
                        name="Discharged"
                        unit=" Ah"
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={58}
                    />
                    <ZAxis range={[60, 60]} />
                    <Tooltip
                        cursor={{ strokeDasharray: '3 3', stroke: '#cbd5e1' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as
                                | { day: string; km: number; ah: number; ratio: number | null; cycles: number }
                                | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={new Date(p.day).toLocaleDateString('en-GB', {
                                        day: '2-digit',
                                        month: 'short',
                                        year: 'numeric',
                                    })}
                                    rows={[
                                        ['Distance', `${p.km} km`],
                                        ['Discharged', `${p.ah} Ah`],
                                        ['Efficiency', p.ratio != null ? `${p.ratio} Ah/km` : '—'],
                                        ['Discharge cycles', String(p.cycles)],
                                    ]}
                                />
                            );
                        }}
                    />
                    {/* The fleet's average efficiency, as a reference slope. A point above the line
                      * drew more charge per kilometre than this pack typically does. */}
                    {slope != null && maxKm > 0 && (
                        <ReferenceLine
                            segment={[
                                { x: 0, y: 0 },
                                { x: maxKm, y: maxKm * slope },
                            ]}
                            stroke={VIZ.tick}
                            strokeDasharray="5 4"
                            label={{
                                value: `${slope.toFixed(2)} Ah/km avg`,
                                position: 'insideTopLeft',
                                fontSize: 10,
                                fill: VIZ.tick,
                            }}
                        />
                    )}
                    <Scatter
                        name="Day"
                        data={rows}
                        fill={VIZ.discharged}
                        fillOpacity={0.75}
                        stroke="#fff"
                        strokeWidth={1.5}
                        isAnimationActive={false}
                    />
                </ScatterChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}
