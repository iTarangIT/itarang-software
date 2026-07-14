'use client';

import {
    Bar,
    ComposedChart,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
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
} from './chart-kit';
import type { DistanceData, EnergyData } from '../types';

/**
 * Km wears violet here, not VIZ.distance: distance's own hue is the same hex as charged,
 * and two identities cannot share a hue on one canvas. The blue/orange/violet trio clears
 * the CVD separation floor (worst adjacent pair ΔE 96.7, validated 2026-07-14).
 */
const KM_LINE = '#7c3aed';

/**
 * Monthly Charge / Discharge / Distance — the energy overview.
 *
 * ## The one dual-axis chart on this tab
 *
 * Everywhere else a second y-scale is banned for the reason documented in
 * DistanceCharts.tsx: it lets a reader compare two heights that mean different things.
 * Here the CEO's question is "for each month: Ah in, Ah out, km" in ONE view, so the km
 * series gets a right axis with these mitigations, which are load-bearing — keep them:
 *
 *  - different MARK TYPES: Ah are bars, km is a dotted line, so heights are never
 *    visually compared across axes;
 *  - each axis is labelled with its unit, and the right axis' ticks are tinted the km
 *    line's own colour so the pairing is explicit;
 *  - the legend names the axis for the km series.
 *
 * Months where the rollup wrote no distance BREAK the line (connectNulls off) — a
 * missing month is unknown, not zero. Months with no detected cycles show zero-height
 * bars, which is what "no detected cycle" honestly measures.
 */
export function MonthlyEnergyDistanceChart({
    energy,
    distance,
}: {
    energy: EnergyData | undefined;
    distance: DistanceData | undefined;
}) {
    const s = energy?.summary;

    // Join on the YYYY-MM prefix, not full ISO equality: energy buckets come from Node's
    // bucketKey() (UTC) while distance buckets come from date_trunc in the DB session, and
    // the 7-char prefix is immune to tz-representation drift between the two.
    const merged = new Map<
        string,
        { bucket: string; charged: number; discharged: number; km: number | null }
    >();
    for (const b of energy?.buckets ?? []) {
        merged.set(b.bucket.slice(0, 7), {
            bucket: b.bucket,
            charged: b.ah_charged,
            discharged: b.ah_discharged,
            km: null,
        });
    }
    for (const d of distance?.buckets ?? []) {
        const key = d.bucket.slice(0, 7);
        const row = merged.get(key);
        if (row) {
            row.km = d.km;
        } else {
            merged.set(key, { bucket: d.bucket, charged: 0, discharged: 0, km: d.km });
        }
    }
    const rows = [...merged.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, r]) => ({ ...r, t: bucketLabel(r.bucket, 'month') }));

    const totalKm = distance?.summary.totalKm ?? 0;

    return (
        <ChartCard
            title="Monthly Charge, Discharge & Distance"
            subtitle="Per month: amp-hours into the pack (bars, left axis), amp-hours out, and kilometres driven (line, right axis)."
            headline={
                s ? (
                    <Headline
                        value={s.totalCharged.toLocaleString()}
                        unit="Ah in"
                        sub={`${s.totalDischarged.toLocaleString()} Ah out · ${totalKm.toLocaleString()} km`}
                    />
                ) : undefined
            }
            empty={
                rows.length === 0
                    ? 'No charge cycles, discharge cycles, or distance in this period.'
                    : undefined
            }
            caveat={
                <>
                    <p>
                        Discharge is measured from the SOC endpoints, not by integrating current:
                        discharge current swings between 0 and ~57 A with traffic, and at our sampling
                        rate an integral of it is a straight line through a curve nobody saw.
                    </p>
                    <p>
                        A month where the distance line breaks has no rollup row — its distance is{' '}
                        <strong>unknown, not zero</strong>. The two bar heights and the line height are
                        on different scales; read each against its own axis.
                    </p>
                </>
            }
        >
            <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={rows} margin={{ top: 16, right: 8, left: 8, bottom: 8 }}>
                    <CartesianGrid horizontal vertical={false} stroke={VIZ.grid} />
                    <XAxis
                        dataKey="t"
                        tick={TICK}
                        tickLine={false}
                        axisLine={AXIS_LINE}
                        tickMargin={10}
                        interval="preserveStartEnd"
                        minTickGap={28}
                    />
                    <YAxis
                        yAxisId="ah"
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={58}
                        unit=" Ah"
                    />
                    {/* Right axis ticks are tinted the km line's colour — the pairing is explicit. */}
                    <YAxis
                        yAxisId="km"
                        orientation="right"
                        tick={{ fontSize: 11, fill: KM_LINE }}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={58}
                        unit=" km"
                    />
                    <Tooltip
                        cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={bucketLabel(p.bucket, 'month')}
                                    rows={[
                                        ['Charged', `${p.charged} Ah`],
                                        ['Discharged', `${p.discharged} Ah`],
                                        ['Distance', p.km != null ? `${p.km} km` : 'unknown'],
                                    ]}
                                    footer={
                                        p.km == null ? (
                                            <p className="text-[11px] text-amber-600">
                                                No distance row this month — unknown, not zero.
                                            </p>
                                        ) : undefined
                                    }
                                />
                            );
                        }}
                    />
                    <Bar
                        yAxisId="ah"
                        dataKey="charged"
                        name="Charged"
                        fill={VIZ.charged}
                        radius={[4, 4, 0, 0]}
                        isAnimationActive={false}
                    />
                    <Bar
                        yAxisId="ah"
                        dataKey="discharged"
                        name="Discharged"
                        fill={VIZ.discharged}
                        radius={[4, 4, 0, 0]}
                        isAnimationActive={false}
                    />
                    <Line
                        yAxisId="km"
                        type="monotone"
                        dataKey="km"
                        name="Distance"
                        stroke={KM_LINE}
                        strokeWidth={2}
                        dot={{ r: 3, fill: KM_LINE, strokeWidth: 0 }}
                        connectNulls={false}
                        isAnimationActive={false}
                    />
                </ComposedChart>
            </ResponsiveContainer>
            <Legend
                items={[
                    { color: VIZ.charged, label: 'Charged (Ah in, left axis)' },
                    { color: VIZ.discharged, label: 'Discharged (Ah out, left axis)' },
                    { color: KM_LINE, label: 'Distance (km, right axis)' },
                ]}
            />
        </ChartCard>
    );
}

/**
 * Deep-discharge events per month.
 *
 * A count of adverse events, so it wears the critical status colour — paired with an explicit
 * label, never colour alone. Each bar is one *debounced* event: a battery hovering at 19-21%
 * is one event, not one per sample.
 */
export function DeepDischargeChart({
    byMonth,
    enterPct,
    exitPct,
    totalEvents,
}: {
    byMonth: Array<{ month: string; count: number }>;
    enterPct: number;
    exitPct: number;
    totalEvents: number;
}) {
    const rows = byMonth.map((m) => ({
        ...m,
        label: new Date(`${m.month}-01T00:00:00`).toLocaleString('en-GB', {
            month: 'short',
            year: '2-digit',
        }),
    }));

    return (
        <ChartCard
            title={`Deep Discharge Events (below ${enterPct}% SOC)`}
            subtitle={`One bar per month. An event runs from the moment SOC drops below ${enterPct}% until it recovers past ${exitPct}% — so a battery sitting at 12% for two days is one event, not dozens.`}
            headline={
                <Headline
                    value={totalEvents}
                    unit={totalEvents === 1 ? 'event' : 'events'}
                    sub="across the period"
                />
            }
            empty={rows.length === 0 ? `No deep-discharge events — SOC never fell below ${enterPct}%.` : undefined}
            caveat={
                <p>
                    Deep discharge is hard on cell chemistry, and repeated events are the clearest
                    behavioural signal of a driver running the pack flat. The {exitPct - enterPct}-point
                    recovery band is what stops a battery wobbling across the threshold from being
                    counted many times over.
                </p>
            }
        >
            <ResponsiveContainer width="100%" height={260}>
                <LineChart data={rows} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
                    <CartesianGrid horizontal vertical={false} stroke={VIZ.grid} />
                    <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={AXIS_LINE} tickMargin={10} />
                    <YAxis
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={40}
                        allowDecimals={false}
                    />
                    <Tooltip
                        cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as { label: string; count: number } | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={p.label}
                                    rows={[['Deep-discharge events', String(p.count)]]}
                                />
                            );
                        }}
                    />
                    <Line
                        type="monotone"
                        dataKey="count"
                        name="Events"
                        stroke={VIZ.criticalLine}
                        strokeWidth={2}
                        dot={{ r: 4, fill: VIZ.criticalLine, stroke: '#fff', strokeWidth: 2 }}
                        activeDot={{ r: 6 }}
                        isAnimationActive={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}
