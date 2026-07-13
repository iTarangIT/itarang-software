'use client';

import { useState, useRef, useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Loader2, BatteryCharging, Zap, Gauge, Repeat, Clock, TrendingUp, Calendar, ChevronDown, ChevronLeft, ChevronRight, Search, Download } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
// No <Legend>: every chart here has a single series, and its title names it.
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts';

type Months = 1 | 3 | 6;
const PERIODS: { value: Months; label: string }[] = [
    { value: 1, label: '1 Month' },
    { value: 3, label: '3 Months' },
    { value: 6, label: '6 Months' },
];

interface AhSession {
    start_time: string;
    end_time: string;
    duration_s: number;
    ah_charged: number;
    start_soc: number | null;
    end_soc: number | null;
    soc_difference: number | null;
    avg_charging_current: number | null;
    max_charging_current: number | null;
    coverage_pct: number | null;
    n_samples: number;
    rated_capacity_ah: number | null;
    estimated_capacity_ah: number | null;
    capacity_plausible: boolean;
}

/** Below this coverage a point is shown, but marked as indicative rather than solid. */
const LOW_CONFIDENCE_COVERAGE = 40;

const CAPACITY_COLOR = '#7c3aed';

/**
 * A rounded axis band that frames the data instead of the origin.
 *
 * A zero-baseline is mandatory for bars, where the bar's *length* encodes the value.
 * It is wrong here: this is a line chart of capacities that all sit near 100 Ah, so
 * anchoring at 0 squashes every meaningful movement into the top fifth of the canvas
 * and the degradation the chart exists to show becomes invisible. The band is padded
 * around the data and the nameplate, and snapped to round ticks so the reader is never
 * decoding a number like 126.4 off an axis.
 */
export function capacityAxis(values: number[], rated: number | null) {
    const all = rated != null ? [...values, rated] : values;
    if (all.length === 0) return { domain: [0, 100] as [number, number], ticks: [0, 25, 50, 75, 100] };

    const min = Math.min(...all);
    const max = Math.max(...all);
    const pad = Math.max((max - min) * 0.25, 5);
    const step = [5, 10, 20, 25, 50, 100].find((s) => (max + pad - (min - pad)) / s <= 5) ?? 100;

    const lo = Math.max(0, Math.floor((min - pad) / step) * step);
    const hi = Math.ceil((max + pad) / step) * step;

    const ticks: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v));
    return { domain: [lo, hi] as [number, number], ticks };
}

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' });

interface AhAnalytics {
    vehicleno: string;
    months: number | null;
    month: string | null;
    sessions: AhSession[];
    summary: {
        chargingCycles: number;
        totalAhCharged: number;
        avgAhPerSession: number;
        avgCapacityAh: number | null;
        avgSessionDurationMin: number;
        avgSocGained: number;
        ratedCapacityAh: number | null;
        implausibleCycles: number;
        gates: { minSocDifference: number; minCoveragePct: number; minSamples: number };
    };
}

interface SocTimeline {
    points: Array<{ time: string; soc_pct: number | null; in_cycle: boolean }>;
}

export function TripAnalytics() {
    const [battery, setBattery] = useState('');
    const [months, setMonths] = useState<Months>(3);
    const [month, setMonth] = useState(''); // specific calendar month YYYY-MM
    const [range, setRange] = useState<{ from: string; to: string } | null>(null); // custom YYYY-MM-DD

    // Precedence matches buildTimeWindow on the server: custom range, then a chosen
    // month, then the rolling window. Keeping the two in step is what stops the
    // chart's caption from describing a period the query didn't run.
    const periodParam = range
        ? `from=${range.from}&to=${range.to}`
        : month
          ? `month=${month}`
          : `months=${months}`;

    const periodLabel = range
        ? `${range.from} to ${range.to}`
        : month
          ? new Date(`${month}-01T00:00:00`).toLocaleString('default', { month: 'long', year: 'numeric' })
          : `${months} Month${months > 1 ? 's' : ''}`;

    // Battery options (reuse the devices endpoint; device_id === vehicleno).
    // limit=1000 fetches the whole fleet (~309) so the searchable picker covers everyone.
    const { data: devicesData } = useQuery({
        queryKey: ['intellicar-battery-options'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/devices?limit=1000');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data as Array<Record<string, unknown>>;
        },
    });
    const batteries = Array.isArray(devicesData) ? devicesData : [];

    const { data: ah, isFetching: ahLoading } = useQuery<AhAnalytics>({
        queryKey: ['intellicar-ah-trend', battery, periodParam],
        enabled: !!battery,
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const res = await fetch(`/api/telemetry/analytics/ah-trend?vehicleno=${encodeURIComponent(battery)}&${periodParam}`);
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data as AhAnalytics;
        },
    });

    // SOC against time — the chart that makes cycle detection checkable by eye.
    const { data: timeline } = useQuery<SocTimeline>({
        queryKey: ['intellicar-soc-timeline', battery, periodParam],
        enabled: !!battery,
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const res = await fetch(`/api/telemetry/analytics/soc-timeline?vehicleno=${encodeURIComponent(battery)}&${periodParam}`);
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data as SocTimeline;
        },
    });

    // Fleet-wide trip history (unchanged).
    const { data: tripsData, isLoading: tripsLoading } = useQuery({
        queryKey: ['intellicar-trips-overview'],
        queryFn: async () => {
            const res = await fetch('/api/telemetry/trips/overview?limit=50');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
    });
    const trips = Array.isArray(tripsData) ? tripsData : [];

    const summary = ah?.summary;
    const rated = summary?.ratedCapacityAh ?? null;

    // One point per *plottable* cycle. Cycles without a capacity estimate are dropped
    // rather than carried as null holes: this is a degradation trend, and a point we
    // declined to compute is not a point on it. Cycle numbers still count every
    // detected cycle, so #3 → #7 in the tooltip is a visible, honest gap.
    const chartData = (ah?.sessions ?? [])
        .map((s, i) => ({ ...s, cycleNo: i + 1 }))
        .filter((s) => s.estimated_capacity_ah != null)
        .map((s) => ({
            // The X key is the cycle number, not the date: two cycles can fall on the
            // same day, and a date-keyed category axis would collapse them into one
            // ambiguous tick. The tick *label* is still the date — the axis reads as
            // time, but every cycle keeps its own slot.
            cycleNo: s.cycleNo,
            t: DAY_FMT.format(new Date(s.start_time)),
            capacity: s.estimated_capacity_ah,
            startTime: s.start_time,
            endTime: s.end_time,
            durationS: s.duration_s,
            startSoc: s.start_soc,
            endSoc: s.end_soc,
            socDiff: s.soc_difference,
            ahCharged: s.ah_charged,
            avgCurrent: s.avg_charging_current,
            coverage: s.coverage_pct,
            samples: s.n_samples,
            lowConfidence: (s.coverage_pct ?? 0) < LOW_CONFIDENCE_COVERAGE,
        }));

    // Cycles the trend declines to plot, and why — otherwise a sparse chart reads as
    // "no degradation data" when it actually means "we didn't believe it".
    const withoutCapacity = (ah?.sessions ?? []).filter((s) => s.estimated_capacity_ah == null).length;
    const lowConfidence = chartData.filter((d) => d.lowConfidence).length;
    const minSoc = summary?.gates.minSocDifference ?? 20;

    const capacities = chartData.map((d) => d.capacity as number);
    const yAxis = capacityAxis(capacities, rated);
    const meanCapacity = capacities.length
        ? Math.round((capacities.reduce((a, b) => a + b, 0) / capacities.length) * 10) / 10
        : null;
    const pctOfRated = meanCapacity != null && rated ? Math.round((meanCapacity / rated) * 100) : null;

    const timelineData = (timeline?.points ?? []).map((p) => ({
        ts: new Date(p.time).getTime(),
        soc: p.soc_pct,
        charging: p.in_cycle,
    }));

    // Contiguous runs of charging samples → shaded bands behind the SOC line. Shading
    // the span rather than recolouring the line keeps SOC a single series, so the
    // charge/discharge alternation stays readable as one continuous shape.
    const chargingSpans: Array<{ from: number; to: number }> = [];
    for (let i = 0; i < timelineData.length; i++) {
        if (!timelineData[i].charging) continue;
        const from = timelineData[i].ts;
        while (i + 1 < timelineData.length && timelineData[i + 1].charging) i++;
        chargingSpans.push({ from, to: timelineData[i].ts });
    }

    const timeFmt = (ts: number) =>
        new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    return (
        <div className="space-y-6">
            {/* Controls: battery selection + period */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500">
                    <BatteryCharging className="w-4 h-4 text-gray-400" /> Battery
                </span>
                <BatteryPicker value={battery} onChange={setBattery} options={batteries} />

                <div className="flex flex-wrap items-center gap-2 ml-auto">
                    <CustomRangePicker value={range} onChange={(r) => { setRange(r); if (r) setMonth(''); }} />
                    {/* Specific month picker */}
                    <MonthPicker
                        value={month}
                        onChange={(m) => { setMonth(m); if (m) setRange(null); }}
                        max={new Date().toISOString().slice(0, 7)}
                    />
                    {/* Rolling window */}
                    <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg">
                        {PERIODS.map((p) => (
                            <button
                                key={p.value}
                                type="button"
                                onClick={() => { setMonths(p.value); setMonth(''); setRange(null); }}
                                className={cn(
                                    'px-3 py-1.5 rounded-md text-sm font-medium transition-all',
                                    !month && !range && months === p.value ? 'bg-white text-brand-700 shadow-sm' : 'text-gray-500 hover:text-gray-700',
                                )}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                    <DownloadChargingAnalysis
                        battery={battery}
                        periodParam={periodParam}
                        fileSuffix={range ? `${range.from}_to_${range.to}` : month || `${months}m`}
                    />
                </div>
            </div>

            {!battery ? (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center text-gray-400 text-sm">
                    <BatteryCharging className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                    Select a battery to view AH analytics.
                </div>
            ) : ahLoading && !ah ? (
                <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-brand-600 animate-spin" /></div>
            ) : (
                <>
                    {/* Charging statistics */}
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                        <StatCard
                            icon={Repeat}
                            color="text-blue-600"
                            label="Charging Cycles"
                            value={String(summary?.chargingCycles ?? 0)}
                            hint={withoutCapacity > 0 ? `${chartData.length} yield a capacity estimate` : undefined}
                        />
                        <StatCard icon={Zap} color="text-amber-600" label="Total AH Charged" value={`${summary?.totalAhCharged ?? 0} Ah`} hint="across all detected cycles" />
                        <StatCard icon={TrendingUp} color="text-green-600" label="Avg AH / Session" value={`${summary?.avgAhPerSession ?? 0} Ah`} />
                        <StatCard
                            icon={Gauge}
                            color="text-purple-600"
                            label="Avg Capacity"
                            value={summary?.avgCapacityAh != null ? `${summary.avgCapacityAh} Ah` : 'N/A'}
                            hint={chartData.length > 0 ? `over ${chartData.length} plotted cycle${chartData.length === 1 ? '' : 's'}` : undefined}
                        />
                        <StatCard icon={Clock} color="text-gray-600" label="Avg Duration" value={`${summary?.avgSessionDurationMin ?? 0} min`} />
                    </div>

                    {/*
                      * AH Trend — the battery-health chart.
                      *
                      * Plots Estimated Capacity, NOT AH charged per session: AH charged scales
                      * with the starting SOC (20%→100% adds more than 80%→100% on an identical
                      * pack), so a trend of it tracks charging habits rather than battery health.
                      * Capacity normalises that out — Total AH ÷ (SOC difference / 100).
                      */}
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                        {/* Header: identity on the left, the headline number on the right. */}
                        <div className="flex flex-wrap items-start justify-between gap-4 p-6 pb-4">
                            <div className="min-w-0">
                                <h3 className="text-base font-semibold text-gray-900">AH Trend</h3>
                                <p className="text-xs text-gray-500 mt-1 max-w-xl">
                                    Estimated battery capacity per valid charging cycle — Total AH ÷ (SOC difference / 100).
                                    A healthy pack holds roughly steady; a sustained decline is degradation.
                                </p>
                            </div>
                            {meanCapacity != null && (
                                <div className="text-right shrink-0">
                                    <p className="text-2xl font-semibold text-gray-900 tabular-nums leading-none">
                                        {meanCapacity}
                                        <span className="text-sm font-medium text-gray-400 ml-1">Ah avg</span>
                                    </p>
                                    {/* "12 of 15" rather than a bare "12": the Charging Cycles card
                                      * above reads 15, and an unexplained mismatch between two numbers
                                      * on the same screen reads as a bug. */}
                                    <p className="text-xs text-gray-400 mt-1.5">
                                        {pctOfRated != null && <>{pctOfRated}% of {rated} Ah rated · </>}
                                        {withoutCapacity > 0
                                            ? `${chartData.length} of ${summary?.chargingCycles ?? chartData.length} cycles plotted`
                                            : `${chartData.length} cycle${chartData.length === 1 ? '' : 's'}`}
                                        {' · '}{periodLabel}
                                    </p>
                                </div>
                            )}
                        </div>

                        {chartData.length > 0 ? (
                            <>
                                <div className="px-2 pb-1">
                                    <ResponsiveContainer width="100%" height={300}>
                                        <LineChart data={chartData} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                                            {/* Horizontal rules only: the X axis is ordinal cycles, so vertical
                                              * rules would imply a continuous time scale the axis doesn't have. */}
                                            <CartesianGrid horizontal vertical={false} stroke="#f1f5f9" />
                                            <XAxis
                                                dataKey="cycleNo"
                                                type="category"
                                                interval="preserveStartEnd"
                                                minTickGap={24}
                                                tickFormatter={(_v, i) => chartData[i]?.t ?? ''}
                                                tick={{ fontSize: 11, fill: '#94a3b8' }}
                                                tickLine={false}
                                                axisLine={{ stroke: '#e2e8f0' }}
                                                tickMargin={10}
                                            />
                                            <YAxis
                                                domain={yAxis.domain}
                                                ticks={yAxis.ticks}
                                                tick={{ fontSize: 11, fill: '#94a3b8' }}
                                                tickLine={false}
                                                axisLine={false}
                                                tickMargin={8}
                                                width={52}
                                                unit=" Ah"
                                            />
                                            <Tooltip
                                                content={<CapacityTooltip rated={rated} />}
                                                cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
                                            />
                                            {/* The nameplate, so degradation is read against what the pack should
                                              * hold. Labelled inside the plot area — a label hung off the right
                                              * edge gets clipped by the container. */}
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
                                            {/* Straight segments, circular markers: each point is a measured cycle,
                                              * and a smoothing curve would invent capacity between them. Hollow =
                                              * sparsely sampled, so a reader can see which points to lean on. */}
                                            <Line
                                                type="linear"
                                                dataKey="capacity"
                                                name="Estimated Capacity"
                                                stroke={CAPACITY_COLOR}
                                                strokeWidth={2}
                                                dot={<CapacityDot />}
                                                activeDot={{ r: 6, fill: CAPACITY_COLOR, stroke: '#fff', strokeWidth: 2 }}
                                                isAnimationActive={false}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>

                                {/* Legend: the marker shape is a second encoding, so it must be named. */}
                                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-6 pt-3 text-xs text-gray-500">
                                    <span className="inline-flex items-center gap-1.5">
                                        <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill={CAPACITY_COLOR} /></svg>
                                        Well-sampled cycle
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                        <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" fill="#fff" stroke={CAPACITY_COLOR} strokeWidth="2" /></svg>
                                        Indicative — under {LOW_CONFIDENCE_COVERAGE}% coverage
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                        <svg width="16" height="10" aria-hidden><line x1="0" y1="5" x2="16" y2="5" stroke="#cbd5e1" strokeWidth="2" strokeDasharray="5 4" /></svg>
                                        Rated capacity
                                    </span>
                                </div>

                                <div className="px-6 pb-5 pt-3 space-y-1.5">
                                    {lowConfidence > 0 && (
                                        <p className="text-xs text-gray-400">
                                            {lowConfidence} of {chartData.length} plotted cycles are hollow: under {LOW_CONFIDENCE_COVERAGE}%
                                            of their charging time was densely sampled, so their capacity leans on interpolation across
                                            telemetry gaps.
                                        </p>
                                    )}
                                    {withoutCapacity > 0 && (
                                        <p className="text-xs text-gray-400">
                                            <span className="text-gray-500">Why {chartData.length} points, not {summary?.chargingCycles}?</span>{' '}
                                            {withoutCapacity} detected cycle{withoutCapacity === 1 ? '' : 's'} charged by less than {minSoc}% SOC.
                                            Capacity divides by that swing, so a small one multiplies any error in the Ah total
                                            by {Math.round(100 / minSoc)}× or more — noise, not a capacity. Those cycles are still counted
                                            in Total AH Charged and Avg Duration.
                                        </p>
                                    )}
                                    {(summary?.implausibleCycles ?? 0) > 0 && (
                                        <p className="text-xs text-red-600">
                                            {summary?.implausibleCycles} cycle(s) estimate a capacity that contradicts the {rated} Ah
                                            nameplate. That indicates a telemetry fault, not a degraded battery.
                                        </p>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="h-56 flex flex-col items-center justify-center text-center px-8 pb-6">
                                <Gauge className="w-7 h-7 text-gray-200 mb-3" />
                                <p className="text-sm text-gray-500">No capacity estimate for this period</p>
                                <p className="text-xs text-gray-400 mt-1 max-w-sm">
                                    A cycle needs a SOC swing of at least {minSoc}% before its capacity can be extrapolated.
                                    {(summary?.chargingCycles ?? 0) > 0 && ` All ${summary?.chargingCycles} detected cycles fell below it.`}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Charging Timeline — the validation chart for cycle detection. */}
                    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
                        <h3 className="text-sm font-semibold text-gray-900 mb-1">Charging Timeline</h3>
                        <p className="text-xs text-gray-400 mb-4">
                            SOC over time, with detected charging cycles shaded. Every rising limb should be shaded and every
                            fall left clear — this is how the cycle detection above is verified.
                        </p>
                        {timelineData.length > 0 ? (
                            <ResponsiveContainer width="100%" height={300}>
                                <LineChart data={timelineData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                                    <XAxis
                                        dataKey="ts"
                                        type="number"
                                        scale="time"
                                        domain={['dataMin', 'dataMax']}
                                        tickFormatter={(ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                        tick={{ fontSize: 11 }}
                                    />
                                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} label={{ value: 'SOC %', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                                    <Tooltip
                                        labelFormatter={(ts) => timeFmt(Number(ts))}
                                        formatter={(v: number) => [`${v}%`, 'SOC']}
                                    />
                                    {chargingSpans.map((s) => (
                                        <ReferenceArea
                                            key={s.from}
                                            x1={s.from}
                                            x2={s.to}
                                            fill="#22c55e"
                                            fillOpacity={0.12}
                                            stroke="none"
                                        />
                                    ))}
                                    <Line type="monotone" dataKey="soc" name="SOC" stroke="#0ea5e9" strokeWidth={2} dot={false} connectNulls />
                                </LineChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="h-48 flex items-center justify-center text-gray-400 text-sm">No telemetry in this period</div>
                        )}
                        <p className="text-xs text-gray-400 mt-3">
                            <span className="inline-block w-3 h-3 rounded-sm bg-green-500/20 align-middle mr-1.5" />
                            Shaded = detected charging cycle
                        </p>
                    </div>
                </>
            )}

            {/* Trip History (fleet-wide) */}
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="p-4 border-b border-gray-100">
                    <h3 className="text-sm font-semibold text-gray-900">Trip History</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-500 border-b border-gray-50">
                                <th className="px-4 py-3 font-medium">Vehicle</th>
                                <th className="px-4 py-3 font-medium">Customer</th>
                                <th className="px-4 py-3 font-medium">Start</th>
                                <th className="px-4 py-3 font-medium">End</th>
                                <th className="px-4 py-3 font-medium">Distance</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tripsLoading ? (
                                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400"><Loader2 className="w-5 h-5 animate-spin inline" /></td></tr>
                            ) : trips.length === 0 ? (
                                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No trips found</td></tr>
                            ) : trips.map((t: Record<string, unknown>, i: number) => (
                                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                                    <td className="px-4 py-3 font-medium">{String(t.vehicle_number || t.device_id || '-')}</td>
                                    <td className="px-4 py-3 text-gray-600">{String(t.customer_name || '-')}</td>
                                    <td className="px-4 py-3 text-gray-500 text-xs">{t.start_time ? new Date(String(t.start_time)).toLocaleString() : '-'}</td>
                                    <td className="px-4 py-3 text-gray-500 text-xs">{t.end_time ? new Date(String(t.end_time)).toLocaleString() : '-'}</td>
                                    <td className="px-4 py-3 font-medium">{t.distance_km ? `${Number(t.distance_km).toFixed(1)} km` : '-'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

interface CapacityPoint {
    t: string;
    capacity: number | null;
    cycleNo: number;
    startTime: string;
    endTime: string;
    durationS: number;
    startSoc: number | null;
    endSoc: number | null;
    socDiff: number | null;
    ahCharged: number;
    avgCurrent: number | null;
    coverage: number | null;
    samples: number;
    lowConfidence: boolean;
}

/**
 * Filled marker for a well-sampled cycle, hollow for one whose capacity leans on
 * interpolation across telemetry gaps. Both are real points on the trend — the shape
 * says how much weight to put on each, which a uniform dot would hide.
 */
function CapacityDot(props: { cx?: number; cy?: number; payload?: CapacityPoint }) {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null || !payload) return null;
    // A hollow marker sitting on a 2px line reads as a smudge unless the line is
    // punched out behind it, so the fill is opaque white rather than transparent.
    return (
        <circle
            cx={cx}
            cy={cy}
            r={4}
            fill={payload.lowConfidence ? '#ffffff' : CAPACITY_COLOR}
            stroke={CAPACITY_COLOR}
            strokeWidth={2}
        />
    );
}

/** Seconds → `4 hr 33 min`. */
function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    if (!hours) return `${minutes} min`;
    return `${hours} hr ${minutes} min`;
}

const clockFmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The full record behind a capacity point — not just the number.
 *
 * Data coverage is here on purpose: it is what licenses the extrapolation, so a
 * reader deciding whether to believe a dip in the trend can weigh it without
 * opening the workbook.
 */
function CapacityTooltip({
    active,
    payload,
    rated,
}: {
    active?: boolean;
    payload?: Array<{ payload: CapacityPoint }>;
    rated: number | null;
}) {
    const p = payload?.[0]?.payload;
    if (!active || !p || p.capacity == null) return null;
    const pctOfRated = rated ? Math.round((p.capacity / rated) * 100) : null;
    const rows: Array<[string, string]> = [
        ['Time', `${clockFmt(p.startTime)} – ${clockFmt(p.endTime)}`],
        ['Duration', formatDuration(p.durationS)],
        ['SOC', p.startSoc != null && p.endSoc != null ? `${p.startSoc}% → ${p.endSoc}%` : '—'],
        ['SOC difference', p.socDiff != null ? `${p.socDiff}%` : '—'],
        ['Charged', `${p.ahCharged} Ah`],
        ['Avg current', p.avgCurrent != null ? `${p.avgCurrent} A` : '—'],
        ['CAN samples', String(p.samples)],
        ['Data coverage', p.coverage != null ? `${p.coverage}%` : '—'],
    ];
    return (
        <div className="bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden text-xs w-60">
            <div className="px-3.5 pt-3 pb-2.5 border-b border-gray-100">
                <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-gray-900">Cycle #{p.cycleNo}</span>
                    <span className="text-gray-400">
                        {new Date(p.startTime).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                </div>
                <p className="mt-1.5 text-lg font-semibold text-gray-900 tabular-nums leading-none">
                    {p.capacity}
                    <span className="text-xs font-medium text-gray-400 ml-1">Ah</span>
                    {pctOfRated != null && (
                        <span className="text-xs font-normal text-gray-400 ml-1.5">{pctOfRated}% of rated</span>
                    )}
                </p>
                {p.lowConfidence && (
                    <p className="mt-1.5 text-[11px] text-amber-600">Indicative — sparsely sampled</p>
                )}
            </div>
            <table className="w-full px-1">
                <tbody>
                    {rows.map(([label, value]) => (
                        <tr key={label}>
                            <td className="text-gray-500 pl-3.5 pr-3 py-[3px]">{label}</td>
                            <td className="text-gray-900 text-right font-medium tabular-nums pr-3.5 py-[3px]">{value}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="h-2" />
        </div>
    );
}

/**
 * Custom date range (YYYY-MM-DD). Both ends are required before it fires — a
 * half-filled range would silently query a window the user didn't ask for.
 */
function CustomRangePicker({
    value,
    onChange,
}: {
    value: { from: string; to: string } | null;
    onChange: (v: { from: string; to: string } | null) => void;
}) {
    const [open, setOpen] = useState(false);
    const [from, setFrom] = useState(value?.from ?? '');
    const [to, setTo] = useState(value?.to ?? '');
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const today = new Date().toISOString().slice(0, 10);
    const invalid = !!from && !!to && from > to;

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'inline-flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg bg-white transition-colors',
                    value ? 'border-brand-300 text-brand-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                )}
            >
                <Calendar className="w-4 h-4 text-gray-400" />
                {value ? `${value.from} → ${value.to}` : 'Custom range'}
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute z-20 mt-2 right-0 w-64 bg-white border border-gray-100 rounded-xl shadow-lg p-3 space-y-2">
                    <label className="block">
                        <span className="text-xs font-medium text-gray-500">From</span>
                        <input
                            type="date"
                            value={from}
                            max={today}
                            onChange={(e) => setFrom(e.target.value)}
                            className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:border-brand-400"
                        />
                    </label>
                    <label className="block">
                        <span className="text-xs font-medium text-gray-500">To</span>
                        <input
                            type="date"
                            value={to}
                            max={today}
                            onChange={(e) => setTo(e.target.value)}
                            className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:border-brand-400"
                        />
                    </label>
                    {invalid && <p className="text-xs text-red-600">From must not be after To.</p>}
                    <div className="flex items-center justify-between pt-1">
                        <button
                            type="button"
                            onClick={() => { onChange(null); setFrom(''); setTo(''); setOpen(false); }}
                            className="text-xs font-medium text-gray-500 hover:underline"
                        >
                            Clear
                        </button>
                        <button
                            type="button"
                            disabled={!from || !to || invalid}
                            onClick={() => { onChange({ from, to }); setOpen(false); }}
                            className="px-3 py-1 rounded-md text-xs font-medium bg-brand-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Apply
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Interactive month picker: a button that opens a popover with a year stepper
 * and a 12-month grid. `value`/`max` are 'YYYY-MM'; future months are disabled.
 * Empty value shows "Pick month". Choosing a month calls onChange; a footer
 * "Clear" resets to the rolling window.
 */
function MonthPicker({ value, onChange, max }: { value: string; onChange: (v: string) => void; max: string }) {
    const [open, setOpen] = useState(false);
    const [viewYear, setViewYear] = useState(() => Number((value || max).slice(0, 4)));
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    const maxYear = Number(max.slice(0, 4));
    const maxMonth = Number(max.slice(5, 7));
    const selYear = value ? Number(value.slice(0, 4)) : null;
    const selMonth = value ? Number(value.slice(5, 7)) : null;
    const label = value
        ? new Date(`${value}-01T00:00:00`).toLocaleString('default', { month: 'short', year: 'numeric' })
        : 'Pick month';

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'inline-flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg bg-white transition-colors',
                    value ? 'border-brand-300 text-brand-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                )}
            >
                <Calendar className="w-4 h-4 text-gray-400" />
                {label}
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute z-20 mt-2 right-0 w-64 bg-white border border-gray-100 rounded-xl shadow-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                        <button type="button" onClick={() => setViewYear((y) => y - 1)} className="p-1 rounded-md hover:bg-gray-100 text-gray-600">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-sm font-semibold text-gray-900">{viewYear}</span>
                        <button
                            type="button"
                            disabled={viewYear >= maxYear}
                            onClick={() => setViewYear((y) => y + 1)}
                            className="p-1 rounded-md hover:bg-gray-100 text-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                        {MONTH_NAMES.map((name, i) => {
                            const m = i + 1;
                            const disabled = viewYear > maxYear || (viewYear === maxYear && m > maxMonth);
                            const active = selYear === viewYear && selMonth === m;
                            return (
                                <button
                                    key={m}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => { onChange(`${viewYear}-${String(m).padStart(2, '0')}`); setOpen(false); }}
                                    className={cn(
                                        'px-2 py-1.5 text-sm rounded-md transition-colors',
                                        active ? 'bg-brand-600 text-white' : disabled ? 'text-gray-300 cursor-not-allowed' : 'text-gray-700 hover:bg-gray-100',
                                    )}
                                >
                                    {name}
                                </button>
                            );
                        })}
                    </div>
                    {value && (
                        <div className="mt-2 pt-2 border-t border-gray-100 text-right">
                            <button type="button" onClick={() => { onChange(''); setOpen(false); }} className="text-xs font-medium text-brand-600 hover:underline">
                                Clear
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Downloads the Charging Analysis workbook for the selected battery and period.
 *
 * Fetches into a blob rather than using a plain <a href> so the button can show a
 * spinner and, on a rejected range, surface the API's explanation ("choose a
 * narrower date range") instead of silently navigating.
 */
function DownloadChargingAnalysis({
    battery,
    periodParam,
    fileSuffix,
}: {
    battery: string;
    periodParam: string;
    fileSuffix: string;
}) {
    const [loading, setLoading] = useState(false);

    const download = async () => {
        setLoading(true);
        try {
            const res = await fetch(
                `/api/telemetry/analytics/charging-export.xlsx?vehicleno=${encodeURIComponent(battery)}&${periodParam}`,
            );
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message ?? 'Export failed');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `charging-analysis_${battery}_${fileSuffix}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Export failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            type="button"
            onClick={download}
            disabled={!battery || loading}
            title={battery ? undefined : 'Select a battery first'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-brand-600 text-white transition-colors hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {loading ? 'Preparing…' : 'Download Charging Analysis'}
        </button>
    );
}

/**
 * Searchable battery picker: a button that opens a popover with a search box and a
 * scrollable, client-side-filtered list of the whole fleet (matches on vehicle no /
 * device_id and customer name). Choosing one calls onChange; outside-click closes.
 */
function BatteryPicker({
    value,
    onChange,
    options,
}: {
    value: string;
    onChange: (v: string) => void;
    options: Array<Record<string, unknown>>;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const ref = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    useEffect(() => {
        if (open) inputRef.current?.focus();
    }, [open]);

    const items = options
        .map((b) => ({
            id: String(b.device_id || b.vehicle_number || ''),
            name: b.customer_name ? String(b.customer_name) : '',
        }))
        .filter((o) => o.id);

    const needle = q.trim().toLowerCase();
    const filtered = needle
        ? items.filter((o) => o.id.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle))
        : items;

    const selected = items.find((o) => o.id === value);
    const label = selected
        ? `${selected.id}${selected.name ? ` — ${selected.name}` : ''}`
        : 'Select a battery…';

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    'inline-flex items-center gap-2 px-3 py-2 text-sm border rounded-lg bg-white transition-colors min-w-[240px] max-w-[320px]',
                    value ? 'border-brand-300 text-brand-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                )}
            >
                <BatteryCharging className="w-4 h-4 text-gray-400 shrink-0" />
                <span className="truncate flex-1 text-left">{label}</span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform shrink-0', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="absolute z-20 mt-2 left-0 w-72 bg-white border border-gray-100 rounded-xl shadow-lg p-2">
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1 border-b border-gray-100">
                        <Search className="w-4 h-4 text-gray-400 shrink-0" />
                        <input
                            ref={inputRef}
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Search vehicle no or customer…"
                            className="w-full text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none"
                        />
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                        {filtered.length === 0 ? (
                            <div className="px-3 py-6 text-center text-sm text-gray-400">No matches</div>
                        ) : (
                            filtered.map((o) => (
                                <button
                                    key={o.id}
                                    type="button"
                                    onClick={() => { onChange(o.id); setOpen(false); setQ(''); }}
                                    className={cn(
                                        'w-full text-left px-3 py-2 text-sm rounded-md transition-colors',
                                        o.id === value ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100',
                                    )}
                                >
                                    <span className="font-medium">{o.id}</span>
                                    {o.name && (
                                        <span className={cn('ml-1', o.id === value ? 'text-brand-100' : 'text-gray-400')}>— {o.name}</span>
                                    )}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function StatCard({
    icon: Icon,
    color,
    label,
    value,
    hint,
}: {
    icon: React.ElementType;
    color: string;
    label: string;
    value: string;
    /** Reconciles this figure with the others when they legitimately differ. */
    hint?: string;
}) {
    return (
        <div className="p-4 bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
                <Icon className={cn('w-4 h-4', color)} />
                <span className="text-xs font-medium text-gray-500">{label}</span>
            </div>
            <p className="text-xl font-bold text-gray-900">{value}</p>
            {hint && <p className="text-[11px] text-gray-400 mt-0.5 leading-tight">{hint}</p>}
        </div>
    );
}
