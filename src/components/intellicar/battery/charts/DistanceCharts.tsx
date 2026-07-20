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
// load-math is pure by construction (see its header), so a client component may import it. The
// gate values still come from the server payload's `gates` — these constants are only the fallback
// for a payload that predates them, since env overrides do not reach the browser.
import {
    BASELINE_MIN_CYCLES,
    BASELINE_MIN_KM,
    OVERLOAD_INDEX_WARN,
    isoDistanceAh,
} from '@/lib/telemetry/load-math';
import type { ReactElement } from 'react';
import type { BatteryThresholds, DistanceData, DischargeKmData, Granularity } from '../types';

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * E-201 — the model spec's normal km-per-Ah efficiency band, as labelled reference lines.
 *
 * Returns a bare ARRAY of <ReferenceLine> (never a fragment or wrapper component) so Recharts'
 * child scan — which matches on element type among the chart's children — actually picks the
 * lines up. `axis='y'` for the km/Ah trend charts (horizontal rules), `axis='x'` for the
 * Ah-vs-mileage scatter (vertical rules). Draws nothing when the spec records no band: a pack
 * with no recorded range gets no line rather than being judged against an invented number —
 * the same rule capacityBands() follows for a missing nameplate.
 *
 * Coloured to stay distinct from the charts' existing data-derived lines (grey pack average,
 * amber "pack's own best"): red floor = below it is poor mileage; green ceiling = above it is
 * unusually efficient (worth a data check).
 */
function mileageBandLines(
    t: BatteryThresholds | undefined,
    axis: 'x' | 'y',
): ReactElement[] {
    const lines: ReactElement[] = [];
    const min = t?.minMileageKmPerAh;
    const max = t?.maxMileageKmPerAh;
    if (typeof min === 'number' && Number.isFinite(min)) {
        lines.push(
            <ReferenceLine
                key="mileage-band-min"
                {...(axis === 'y' ? { y: min } : { x: min })}
                stroke={VIZ.criticalLine}
                strokeDasharray="4 4"
                // The floor usually sits below every plotted point, so extend the axis to it
                // rather than let Recharts clip the line (its default is to discard overflow).
                ifOverflow="extendDomain"
                label={{
                    value: `Min ${min} km/Ah`,
                    position: axis === 'y' ? 'insideBottomRight' : 'insideBottomLeft',
                    fontSize: 10,
                    fill: VIZ.criticalLine,
                }}
            />,
        );
    }
    if (typeof max === 'number' && Number.isFinite(max)) {
        lines.push(
            <ReferenceLine
                key="mileage-band-max"
                {...(axis === 'y' ? { y: max } : { x: max })}
                stroke={VIZ.bandGood}
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
                label={{
                    value: `Max ${max} km/Ah`,
                    position: axis === 'y' ? 'insideTopRight' : 'insideBottomRight',
                    fontSize: 10,
                    fill: VIZ.bandGood,
                }}
            />,
        );
    }
    return lines;
}

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
export function MileageTrendChart({
    data,
    thresholds,
}: {
    data: DischargeKmData | undefined;
    thresholds?: BatteryThresholds;
}) {
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
                    {/* E-201: the model spec's normal km/Ah band (drawn only when recorded). */}
                    {mileageBandLines(thresholds, 'y')}
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
export function PerCycleMileageChart({
    data,
    thresholds,
}: {
    data: DischargeKmData | undefined;
    thresholds?: BatteryThresholds;
}) {
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
                    {/* E-201: the model spec's normal km/Ah band (drawn only when recorded). */}
                    {mileageBandLines(thresholds, 'y')}
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

/**
 * Pick up to four round distances that actually cross the plotted data.
 *
 * Contours outside the data's range draw curves nobody can land on, and contours at arbitrary
 * values ("37.4 km") read as data rather than as a grid.
 */
function niceContours(minKm: number, maxKm: number): number[] {
    if (!(maxKm > 0)) return [];
    const CANDIDATES = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 300];
    const inRange = CANDIDATES.filter((k) => k >= minKm * 0.9 && k <= maxKm * 1.1);
    if (inRange.length <= 4) return inRange;
    // Spread four across the range rather than clustering them at the bottom.
    const step = (inRange.length - 1) / 3;
    return [0, 1, 2, 3].map((i) => inRange[Math.round(i * step)]);
}

/**
 * Ah vs Mileage — how much charge each discharge cycle spent, against how far it got per amp-hour.
 *
 * X is kilometres per amp-hour (right = more efficient), Y is the amp-hours the cycle actually
 * drew. One point per discharge cycle: the finest grain distance can honestly be resolved at,
 * since `distance_rollup` is daily and the `trips` table is empty fleet-wide.
 *
 * ## Read the contours, not the slope
 *
 * The two axes are NOT independent — mileage is km / Ah, so amp-hours sit in the x-axis
 * denominator, and lines of constant distance are hyperbolae (km = mileage x Ah). Some of the
 * left-to-right fall is that constraint, not a finding. The dotted iso-distance curves make it
 * visible: WHICH contour a point sits on is how far it went; WHERE along it is how efficiently.
 * Hiding the constraint would turn arithmetic into a discovery.
 *
 * This is exactly why the requested "mileage vs current" chart does not exist. There the x-axis was
 * a *badly measured* quantity sitting in the y-axis denominator, so binning sorted intervals by
 * their own error and manufactured a ~9x curve out of a vehicle whose mileage never changed
 * (load-math.test.ts proves it arithmetically). Here both axes come from robust per-cycle
 * measurements — Ah is SOC-derived (two endpoints, ~2%, immune to the poller's sparseness) and km
 * is the rollup-calibrated chord — so the constraint is honest geometry rather than laundered noise.
 *
 * ## What it shows
 *
 * Left of the dashed baseline = this pack spent more charge per kilometre than it does at its own
 * best. High AND left = a lot of charge bought little distance: the overload signature.
 */
export function AhVsMileageChart({
    data,
    thresholds,
}: {
    data: DischargeKmData | undefined;
    thresholds?: BatteryThresholds;
}) {
    const cs = data?.cycleSummary;
    const baseline = cs?.baseline ?? null;
    const warn = cs?.gates?.overloadIndexWarn ?? OVERLOAD_INDEX_WARN;

    const rows = (data?.cycles ?? [])
        .filter((c) => c.km_per_ah != null && c.ah_discharged > 0)
        .map((c) => ({
            mileage: c.km_per_ah as number,
            ah: c.ah_discharged,
            km: c.km,
            ratio: c.ah_per_km,
            index: c.overload_index ?? null,
            dod: c.dod_pct,
            start: c.start_time,
            end: c.end_time,
            durationS: c.duration_s,
            source: c.km_source,
        }));

    // The baseline as the driver reads it: the reciprocal of the baseline Ah/km.
    const baselineMileage = baseline ? Math.round((1 / baseline.ahPerKm) * 100) / 100 : null;

    // Split on the index, never colour alone — the Legend names both. Cycles with no index (no
    // baseline, or an uncalibrated chord) stay in the neutral series rather than being guessed.
    const heavy = rows.filter((r) => r.index != null && r.index >= warn);
    const normal = rows.filter((r) => !(r.index != null && r.index >= warn));

    const xMin = rows.length ? Math.min(...rows.map((r) => r.mileage)) : 0;
    const xMax = rows.length ? Math.max(...rows.map((r) => r.mileage)) : 1;
    const contourSeries = (
        rows.length
            ? niceContours(Math.min(...rows.map((r) => r.km)), Math.max(...rows.map((r) => r.km)))
            : []
    ).map((km) => ({
        km,
        // 24 samples reads as a smooth curve without pretending to be data.
        points: Array.from({ length: 24 }, (_, i) => {
            const mileage = xMin + ((xMax - xMin) * i) / 23;
            return { mileage, ah: isoDistanceAh(km, mileage) };
        }).filter((p) => p.ah != null),
    }));

    const uncalibrated = rows.filter((r) => r.source === 'gps').length;

    return (
        <ChartCard
            title="Ah vs Mileage"
            subtitle="One point per discharge cycle: amp-hours drawn (up) against kilometres per amp-hour (right). Dotted curves are constant distance. Points high and to the left spent a lot of charge for little distance — the overload signature."
            headline={
                baselineMileage != null ? (
                    <Headline
                        value={baselineMileage.toFixed(2)}
                        unit="km / Ah at its best"
                        sub={
                            cs?.overloadedCycles != null
                                ? `${cs.overloadedCycles} of ${rows.length} cycles at or above ${warn}x that`
                                : `${rows.length} cycles`
                        }
                    />
                ) : (
                    <Headline value={rows.length} unit="cycles" sub="no baseline — see below" />
                )
            }
            empty={
                rows.length === 0
                    ? (cs?.cyclesWithoutDistance ?? 0) > 0
                        ? `${cs!.cyclesWithoutDistance} discharge cycle${cs!.cyclesWithoutDistance === 1 ? ' was' : 's were'} detected, but none had usable GPS distance — so none has a mileage to plot.`
                        : 'No discharge cycle in this period covered a measurable distance.'
                    : undefined
            }
            caveat={
                <>
                    <p>
                        <strong>The axes are not independent.</strong> Mileage is km ÷ Ah, so amp-hours
                        appear in both — the dotted curves are lines of constant distance, and some of the
                        left-to-right fall is that geometry rather than a finding. Read a point by which
                        contour it sits on (how far it went) and where along it (how efficiently).
                    </p>
                    {baseline ? (
                        <p>
                            The dashed line is this pack&apos;s <strong>own best fifth</strong> —{' '}
                            {baseline.ahPerKm} Ah/km over {baseline.cycles} cycle
                            {baseline.cycles === 1 ? '' : 's'} and {baseline.km} km, aggregated as total Ah ÷
                            total km. It measures <strong>variation in load, not absolute load</strong>: if the
                            vehicle was loaded on every trip in this window then the baseline is a loaded
                            baseline and everything here reads normal. It cannot tell you the vehicle is
                            overloaded — only that some trips cost more per kilometre than this pack&apos;s own
                            best.
                        </p>
                    ) : (
                        <p>
                            <strong>No baseline.</strong> This period has fewer than{' '}
                            {cs?.gates?.baselineMinCycles ?? BASELINE_MIN_CYCLES} calibrated cycles, or under{' '}
                            {cs?.gates?.baselineMinKm ?? BASELINE_MIN_KM} km between them, so there is no honest
                            &quot;this pack at its best&quot; to compare against — and a baseline drawn from one
                            lucky trip would report overload on every normal one. Points are still plotted;
                            none is judged.
                        </p>
                    )}
                    <p>
                        Amp-hours are SOC-derived — the pack&apos;s own SOC swing against its nameplate —
                        which needs only the cycle&apos;s two endpoints and so does not degrade as the poller
                        gets sparser. Distance is the GPS chord calibrated against the daily rollup
                        {cs?.calibratedPct != null ? <> ({cs.calibratedPct}% of plotted cycles calibrated)</> : null}.
                        {uncalibrated > 0 ? (
                            <>
                                {' '}
                                <strong>{uncalibrated}</strong> point{uncalibrated === 1 ? '' : 's'} had no
                                rollup to calibrate against and use the raw chord — it under-reads distance by
                                roughly a quarter, which is the size of a real overload, so they are excluded
                                from the baseline and are never marked heavy.
                            </>
                        ) : null}
                    </p>
                </>
            }
        >
            <Legend
                items={[
                    { color: VIZ.distance, label: 'Discharge cycle' },
                    ...(baseline
                        ? [
                              { color: VIZ.discharged, label: `Heavy — ${warn}x the pack's best or worse` },
                              { color: VIZ.warningLine, label: "Pack's own best", dashed: true },
                          ]
                        : []),
                    { color: VIZ.axis, label: 'Constant distance', dashed: true },
                ]}
            />
            <ResponsiveContainer width="100%" height={320}>
                <ScatterChart margin={{ top: 16, right: 28, left: 8, bottom: 20 }}>
                    <CartesianGrid stroke={VIZ.grid} />
                    <XAxis
                        type="number"
                        dataKey="mileage"
                        name="Mileage"
                        tick={TICK}
                        tickLine={false}
                        axisLine={AXIS_LINE}
                        tickMargin={10}
                        domain={['dataMin', 'dataMax']}
                        label={{
                            value: 'Mileage (km / Ah) — further right is more efficient',
                            position: 'insideBottom',
                            offset: -12,
                            fontSize: 11,
                            fill: VIZ.tick,
                        }}
                    />
                    {/* Ah is a magnitude and the contours must be able to meet it, so the zero
                      * baseline is correct here — unlike the capacity charts, where it would
                      * flatten the very variation being read. */}
                    <YAxis
                        type="number"
                        dataKey="ah"
                        name="Ah drawn"
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={52}
                        unit=" Ah"
                    />
                    <ZAxis range={[70, 70]} />
                    <Tooltip
                        cursor={{ strokeDasharray: '3 3', stroke: VIZ.axis }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                            // Contour points carry no `start` — never draw a tooltip for a grid line.
                            if (!active || !p || !p.start) return null;
                            return (
                                <TooltipShell
                                    title={DAY_FMT.format(new Date(p.start))}
                                    sub={`${TIME_FMT.format(new Date(p.start))}–${TIME_FMT.format(new Date(p.end))}`}
                                    rows={[
                                        ['Mileage', `${p.mileage.toFixed(2)} km / Ah`],
                                        ['Ah drawn', `${p.ah.toFixed(1)} Ah`],
                                        ['Distance', `${p.km.toFixed(1)} km`],
                                        ['Efficiency', p.ratio != null ? `${p.ratio.toFixed(2)} Ah / km` : '—'],
                                        [
                                            'vs pack best',
                                            p.index != null ? `${p.index.toFixed(2)}x` : 'no baseline',
                                        ],
                                        ['Depth of discharge', p.dod != null ? `${p.dod}%` : '—'],
                                        ['Duration', formatDuration(p.durationS)],
                                    ]}
                                    footer={
                                        p.source === 'gps' ? (
                                            <p className="text-[11px] text-amber-600">
                                                Raw GPS distance — a lower bound, so the true mileage is further
                                                right than plotted. Not judged against the baseline.
                                            </p>
                                        ) : p.index != null && p.index >= warn ? (
                                            <p className="text-[11px] text-amber-600">
                                                Spent {p.index.toFixed(2)}x this pack&apos;s best charge per km.
                                                Heavy load, gradient or traffic — evidence, not proof.
                                            </p>
                                        ) : undefined
                                    }
                                />
                            );
                        }}
                    />

                    {/* Contours first, so the cycles draw on top of the grid rather than under it. */}
                    {contourSeries.map((c) => (
                        <Scatter
                            key={`iso-${c.km}`}
                            name={`${c.km} km`}
                            data={c.points}
                            line={{ stroke: VIZ.axis, strokeWidth: 1, strokeDasharray: '2 4' }}
                            lineType="joint"
                            shape={() => <g />}
                            legendType="none"
                            isAnimationActive={false}
                        />
                    ))}

                    {baselineMileage != null && (
                        <ReferenceLine
                            x={baselineMileage}
                            stroke={VIZ.warningLine}
                            strokeDasharray="5 4"
                            label={{
                                value: `${baselineMileage.toFixed(2)} km/Ah — pack's best`,
                                position: 'insideTopRight',
                                fontSize: 10,
                                fill: VIZ.tick,
                            }}
                        />
                    )}
                    {/* E-201: the model spec's normal km/Ah band (drawn only when recorded). */}
                    {mileageBandLines(thresholds, 'x')}

                    <Scatter
                        name="Discharge cycle"
                        data={normal}
                        fill={VIZ.distance}
                        fillOpacity={0.75}
                        stroke="#fff"
                        strokeWidth={1.5}
                        isAnimationActive={false}
                    />
                    <Scatter
                        name="Heavy"
                        data={heavy}
                        fill={VIZ.discharged}
                        fillOpacity={0.85}
                        stroke="#fff"
                        strokeWidth={1.5}
                        isAnimationActive={false}
                    />
                </ScatterChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}
