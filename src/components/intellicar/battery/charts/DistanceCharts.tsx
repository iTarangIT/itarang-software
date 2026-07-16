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
    Legend,
    TooltipShell,
    bucketLabel,
    formatDuration,
} from './chart-kit';
import type { DistanceData, DischargeKmData, Granularity } from '../types';

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Kilometre Trend — distance per bucket.
 *
 * Every chart on this tab keeps to ONE y-axis. A dual axis lets a reader compare two lines
 * whose heights mean different things, which is the single most common way a chart lies.
 * (The monthly energy overview is the lone documented exception — see EnergyCharts.tsx for
 * the mitigations that make it tolerable there.)
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

/**
 * Discharge vs Kilometre — the efficiency scatter, one point per DISCHARGE CYCLE.
 *
 * The distance inside a cycle's window is the GPS chord calibrated against the daily
 * rollup (see cycle-distance.ts): the chord gives the cycle its share of the day, the
 * rollup gives the day its true scale. Per-cycle beats the old per-day view for driver
 * behaviour: one heavy trip no longer hides inside a day's average.
 *
 * The slope is the pack's Ah/km. A point drifting up-left of the reference line did more
 * work for the same distance — overload, or degradation as seen from the driver's seat.
 */
export function DischargeVsKmChart({ data }: { data: DischargeKmData | undefined }) {
    const cycles = data?.cycles ?? [];
    const cs = data?.cycleSummary;
    const slope = cs?.avgAhPerKm ?? null;

    const rows = cycles.map((c) => ({
        km: c.km,
        ah: c.ah_discharged,
        ratio: c.ah_per_km,
        mileage: c.km_per_ah,
        dod: c.dod_pct,
        start: c.start_time,
        end: c.end_time,
        durationS: c.duration_s,
        source: c.km_source,
    }));

    const maxKm = rows.length ? Math.max(...rows.map((r) => r.km)) : 0;
    const uncalibrated = rows.filter((r) => r.source === 'gps').length;

    return (
        <ChartCard
            title="Discharge vs Kilometres"
            subtitle="One point per discharge cycle: amp-hours drawn against kilometres covered during that cycle. The dashed line is the pack's average efficiency — points above it did more work per kilometre."
            headline={
                cs ? (
                    <Headline
                        value={slope != null ? slope.toFixed(2) : '—'}
                        unit="Ah / km"
                        sub={`${cs.cycles} cycles · ${cs.totalKm.toLocaleString()} km`}
                    />
                ) : undefined
            }
            empty={
                rows.length === 0
                    ? (cs?.cyclesWithoutDistance ?? 0) > 0
                        ? `${cs!.cyclesWithoutDistance} discharge cycle${cs!.cyclesWithoutDistance === 1 ? ' was' : 's were'} detected, but none had usable GPS distance — the GPS feed reported no fixes (or only parked jitter) in this period.`
                        : 'No discharge cycle in this period covered a measurable distance.'
                    : undefined
            }
            caveat={
                <>
                    <p>
                        Distance inside a cycle is GPS straight-line travel <strong>calibrated against the
                        daily distance rollup</strong>
                        {cs?.calibratedPct != null ? <> ({cs.calibratedPct}% of plotted cycles calibrated)</> : null}
                        . {uncalibrated > 0 ? (
                            <>
                                <strong>{uncalibrated}</strong> point{uncalibrated === 1 ? '' : 's'} had no rollup to
                                calibrate against and show raw GPS distance — a <strong>lower bound</strong>, so their
                                true Ah/km is lower than plotted.
                            </>
                        ) : null}
                    </p>
                    <p>
                        The headline is the aggregate ratio (total Ah ÷ total km), not the average of the
                        per-cycle ratios — a partially-resolved cycle must not count as much as a full one.
                        {(cs?.cyclesWithoutDistance ?? 0) > 0 && (
                            <>
                                {' '}
                                <strong>{cs?.cyclesWithoutDistance}</strong> discharge cycle
                                {cs?.cyclesWithoutDistance === 1 ? '' : 's'} moved under 1 km (parked drain, or GPS
                                silent) and {cs?.cyclesWithoutDistance === 1 ? 'is' : 'are'} counted here rather than
                                plotted at the axis.
                            </>
                        )}
                    </p>
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
                        label={{ value: 'Kilometres covered in the cycle', position: 'insideBottom', offset: -8, fontSize: 11, fill: VIZ.tick }}
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
                            const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={DAY_FMT.format(new Date(p.start))}
                                    sub={`${TIME_FMT.format(new Date(p.start))} → ${TIME_FMT.format(new Date(p.end))}`}
                                    rows={[
                                        ['Duration', formatDuration(p.durationS)],
                                        ['Distance', `${p.km} km${p.source === 'gps' ? ' (GPS lower bound)' : ''}`],
                                        ['Discharged', `${p.ah} Ah`],
                                        ['Efficiency', p.ratio != null ? `${p.ratio} Ah/km` : '—'],
                                        ['Mileage', p.mileage != null ? `${p.mileage} km/Ah` : '—'],
                                        ['Depth of discharge', p.dod != null ? `${p.dod}%` : '—'],
                                    ]}
                                    footer={
                                        p.source === 'gps' ? (
                                            <p className="text-[11px] text-amber-600">
                                                No rollup that day — distance is uncalibrated GPS, a lower bound.
                                            </p>
                                        ) : undefined
                                    }
                                />
                            );
                        }}
                    />
                    {/* The pack's average efficiency, as a reference slope. A point above the line
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
                        name="Discharge cycle"
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

/**
 * Mileage Trend — km per Ah, one point per day.
 *
 * Daily and rollup-based on purpose. "Instantaneous" mileage from speed ÷ current would
 * sample two different feeds at a ~8.5-minute cadence — pure aliasing dressed as a signal —
 * and per-cycle mileage inherits the GPS chord's bias (it is still visible per point in the
 * scatter above). A day of rollup km over a day of SOC-derived Ah is the finest honest unit.
 *
 * How to read it: points well BELOW the dashed pack average are days the battery did little
 * distance for its charge — overload, heavy current draw, or misuse. A sustained slide of
 * the line is a mileage drop worth investigating.
 */
export function MileageTrendChart({ data }: { data: DischargeKmData | undefined }) {
    const points = (data?.points ?? []).filter((p) => p.km_per_ah != null);
    const s = data?.summary;
    const packAvg =
        s && s.totalAh > 0 ? Math.round((s.totalKm / s.totalAh) * 100) / 100 : null;

    const rows = points.map((p) => ({
        t: bucketLabel(p.day, 'day'),
        day: p.day,
        mileage: p.km_per_ah,
        km: p.km,
        ah: p.ah_discharged,
    }));

    return (
        <ChartCard
            title="Mileage Trend"
            subtitle="Kilometres per amp-hour, per day. Days far below the dashed pack average did little distance for their charge — overload or heavy draw; a sustained slide is a mileage drop."
            headline={
                packAvg != null ? (
                    <Headline value={packAvg.toFixed(2)} unit="km / Ah avg" sub={`${rows.length} days`} />
                ) : undefined
            }
            empty={rows.length === 0 ? 'No day in this period has both a distance row and a resolved discharge.' : undefined}
            caveat={
                <p>
                    Only days with BOTH a distance rollup row and a resolved discharge cycle appear —
                    a missing day is unknown, not zero, and the line simply skips it.
                    {(s?.daysWithoutDischarge ?? 0) > 0 && (
                        <>
                            {' '}
                            <strong>{s?.daysWithoutDischarge}</strong> day
                            {s?.daysWithoutDischarge === 1 ? '' : 's'} had kilometres but no resolvable
                            discharge and {s?.daysWithoutDischarge === 1 ? 'is' : 'are'} absent here.
                        </>
                    )}
                </p>
            }
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
                    <YAxis
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={56}
                        unit=" km/Ah"
                    />
                    <Tooltip
                        cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={DAY_FMT.format(new Date(p.day))}
                                    rows={[
                                        ['Mileage', `${p.mileage} km/Ah`],
                                        ['Distance', `${p.km} km`],
                                        ['Discharged', `${p.ah} Ah`],
                                    ]}
                                />
                            );
                        }}
                    />
                    {packAvg != null && (
                        <ReferenceLine
                            y={packAvg}
                            stroke={VIZ.tick}
                            strokeDasharray="5 4"
                            label={{
                                value: `${packAvg.toFixed(2)} km/Ah pack avg`,
                                position: 'insideTopRight',
                                fontSize: 10,
                                fill: VIZ.tick,
                            }}
                        />
                    )}
                    {/* Dots ON: the series is sparse and each day is a reading, not a sample of
                      * a continuous process — hiding the points would overstate the line. */}
                    <Line
                        type="monotone"
                        dataKey="mileage"
                        name="Mileage"
                        stroke={VIZ.distance}
                        strokeWidth={2}
                        dot={{ r: 2.5, fill: VIZ.distance, strokeWidth: 0 }}
                        connectNulls={false}
                        isAnimationActive={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}

/**
 * Per-Cycle Mileage — km per Ah, one point per discharge cycle, placed at the time it happened.
 *
 * This is the finest HONEST grain for mileage, and the closest this data supports to the
 * "instantaneous" chart the request asks for. True instantaneous mileage (speed ÷ current per
 * sample) is aliasing: GPS fixes (~8.5 min) and CAN samples (p90 33-62 min) ride independent
 * clocks, so a per-second line through them is noise dressed as signal — see MileageTrendChart
 * above and docs/intellicar-calculations.md §22. One discharge cycle is one trip/run, so each
 * dot is a real driving event, not a resampled point.
 *
 * The daily MileageTrendChart answers "how did mileage move day to day"; this answers "which
 * individual trips were inefficient" — a single overloaded run shows as one low dot at its own
 * time instead of being averaged into its day. Dots below the dashed pack average (drawn in the
 * overload colour) are the trips that did little distance for their charge.
 */
export function PerCycleMileageChart({ data }: { data: DischargeKmData | undefined }) {
    const cs = data?.cycleSummary;
    // Aggregate ratio (Σkm ÷ ΣAh), not the mean of per-cycle ratios — matches the scatter
    // headline so both per-cycle views quote the same pack average.
    const packAvg =
        cs && cs.totalAh > 0 ? Math.round((cs.totalKm / cs.totalAh) * 100) / 100 : null;

    const rows = (data?.cycles ?? [])
        .filter((c) => c.km_per_ah != null)
        .map((c) => ({
            t: new Date(c.start_time).getTime(),
            mileage: c.km_per_ah as number,
            km: c.km,
            ah: c.ah_discharged,
            dod: c.dod_pct,
            durationS: c.duration_s,
            start: c.start_time,
            end: c.end_time,
            source: c.km_source,
        }));

    // Split by the pack average so overloaded trips read as a distinct colour, never colour
    // alone (a Legend names both). With no average to split on, everything is one series.
    const belowAvg = packAvg != null ? rows.filter((r) => r.mileage < packAvg) : [];
    const atOrAbove = packAvg != null ? rows.filter((r) => r.mileage >= packAvg) : rows;

    return (
        <ChartCard
            title="Per-Cycle Mileage"
            subtitle="Kilometres per amp-hour for each discharge cycle, plotted at the time it happened — the finest honest grain (one point per trip/run). Dots below the dashed pack average did little distance for their charge: overload or heavy draw."
            headline={
                packAvg != null ? (
                    <Headline value={packAvg.toFixed(2)} unit="km / Ah avg" sub={`${rows.length} cycles`} />
                ) : undefined
            }
            empty={
                rows.length === 0
                    ? (cs?.cyclesWithoutDistance ?? 0) > 0
                        ? `${cs!.cyclesWithoutDistance} discharge cycle${cs!.cyclesWithoutDistance === 1 ? ' was' : 's were'} detected, but none had usable GPS distance — the GPS feed reported no fixes (or only parked jitter) in this period.`
                        : 'No discharge cycle in this period covered a measurable distance.'
                    : undefined
            }
            caveat={
                <p>
                    Each dot is one cycle&apos;s calibrated GPS distance ÷ its SOC-derived Ah. A
                    dot from an uncalibrated day shows raw GPS distance — a <strong>lower bound</strong>,
                    so its true mileage is higher than plotted — and per-cycle mileage inherits the
                    GPS chord&apos;s calibration bias, which is why the day-level trend above stays the
                    headline number.
                </p>
            }
        >
            <Legend
                items={[
                    { color: VIZ.distance, label: 'At / above pack average' },
                    { color: VIZ.discharged, label: 'Below average — overload / heavy draw' },
                    { color: VIZ.tick, label: 'Pack average', dashed: true },
                ]}
            />
            <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 16, right: 24, left: 8, bottom: 14 }}>
                    <CartesianGrid stroke={VIZ.grid} />
                    <XAxis
                        type="number"
                        dataKey="t"
                        name="Time"
                        domain={['dataMin', 'dataMax']}
                        scale="time"
                        tick={TICK}
                        tickLine={false}
                        axisLine={AXIS_LINE}
                        tickMargin={8}
                        tickFormatter={(t: number) => DAY_FMT.format(new Date(t))}
                        minTickGap={40}
                    />
                    <YAxis
                        type="number"
                        dataKey="mileage"
                        name="Mileage"
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={58}
                        unit=" km/Ah"
                    />
                    <ZAxis range={[60, 60]} />
                    <Tooltip
                        cursor={{ strokeDasharray: '3 3', stroke: '#cbd5e1' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={DAY_FMT.format(new Date(p.start))}
                                    sub={`${TIME_FMT.format(new Date(p.start))} → ${TIME_FMT.format(new Date(p.end))}`}
                                    rows={[
                                        ['Mileage', `${p.mileage} km/Ah`],
                                        ['Distance', `${p.km} km${p.source === 'gps' ? ' (GPS lower bound)' : ''}`],
                                        ['Discharged', `${p.ah} Ah`],
                                        ['Depth of discharge', p.dod != null ? `${p.dod}%` : '—'],
                                        ['Duration', formatDuration(p.durationS)],
                                    ]}
                                    footer={
                                        p.source === 'gps' ? (
                                            <p className="text-[11px] text-amber-600">
                                                No rollup that day — distance is uncalibrated GPS, so mileage is a lower bound.
                                            </p>
                                        ) : undefined
                                    }
                                />
                            );
                        }}
                    />
                    {packAvg != null && (
                        <ReferenceLine
                            y={packAvg}
                            stroke={VIZ.tick}
                            strokeDasharray="5 4"
                            label={{
                                value: `${packAvg.toFixed(2)} km/Ah pack avg`,
                                position: 'insideTopRight',
                                fontSize: 10,
                                fill: VIZ.tick,
                            }}
                        />
                    )}
                    <Scatter
                        name="At / above pack average"
                        data={atOrAbove}
                        fill={VIZ.distance}
                        fillOpacity={0.75}
                        stroke="#fff"
                        strokeWidth={1.5}
                        isAnimationActive={false}
                    />
                    <Scatter
                        name="Below average"
                        data={belowAvg}
                        fill={VIZ.discharged}
                        fillOpacity={0.8}
                        stroke="#fff"
                        strokeWidth={1.5}
                        isAnimationActive={false}
                    />
                </ScatterChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}
