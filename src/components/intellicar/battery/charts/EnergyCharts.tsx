'use client';

import {
    AreaChart,
    Area,
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
import type { EnergyData, Granularity } from '../types';

/**
 * Cumulative Charge and Cumulative Discharge — both Ah, so both on ONE axis.
 *
 * They are the same measure in opposite directions, and a second y-scale would let the reader
 * compare two lines whose heights mean different things. Sharing an axis is what makes the
 * *gap* between the lines legible, and that gap is the whole point: on a battery that starts
 * and ends the window near the same SOC, energy in and energy out should track each other. A
 * pair that steadily diverges means one of the two measurements is wrong — a battery cannot
 * create charge.
 */
export function CumulativeEnergyChart({
    data,
    granularity,
}: {
    data: EnergyData | undefined;
    granularity: Granularity;
}) {
    const buckets = data?.buckets ?? [];
    const s = data?.summary;

    const rows = buckets.map((b) => ({
        t: bucketLabel(b.bucket, granularity),
        bucket: b.bucket,
        charged: b.cum_charged,
        discharged: b.cum_discharged,
        inCharged: b.ah_charged,
        inDischarged: b.ah_discharged,
    }));

    const ratio =
        s && s.totalDischarged > 0 ? s.totalCharged / s.totalDischarged : null;

    return (
        <ChartCard
            title="Cumulative Charge & Discharge"
            subtitle="Amp-hours into the pack and out of it, accumulating across the period. Discharge is derived from the SOC swing against the nameplate — see the note below."
            headline={
                s ? (
                    <Headline
                        value={s.totalCharged}
                        unit="Ah in"
                        sub={`${s.totalDischarged} Ah out · ${s.chargingCycles} charges / ${s.dischargeCycles} discharges`}
                    />
                ) : undefined
            }
            empty={rows.length === 0 ? 'No charge or discharge cycles in this period.' : undefined}
            caveat={
                <>
                    <p>
                        Discharge is measured from the SOC endpoints, not by integrating current:
                        discharge current swings between 0 and ~57 A with traffic, and at our sampling
                        rate an integral of it is a straight line through a curve nobody saw. SOC is a
                        state, so two endpoints are enough.
                    </p>
                    {ratio != null && (
                        <p>
                            Energy in ÷ energy out = <strong>{ratio.toFixed(2)}</strong>.{' '}
                            {ratio > 0.8 && ratio < 1.25
                                ? 'Two independent measurements agreeing this closely is the strongest evidence available that neither is badly wrong.'
                                : 'These should track each other over a long window. A persistent imbalance this large means one of the two measurements is off — a pack cannot create charge.'}
                        </p>
                    )}
                </>
            }
        >
            <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={rows} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
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
                    {/* One axis. Both series are Ah. */}
                    <YAxis
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={58}
                        unit=" Ah"
                    />
                    <Tooltip
                        content={<EnergyTooltip granularity={granularity} />}
                        cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
                    />
                    <Area
                        type="monotone"
                        dataKey="charged"
                        name="Cumulative charged"
                        stroke={VIZ.charged}
                        strokeWidth={2}
                        fill={VIZ.charged}
                        fillOpacity={0.08}
                        isAnimationActive={false}
                    />
                    <Area
                        type="monotone"
                        dataKey="discharged"
                        name="Cumulative discharged"
                        stroke={VIZ.discharged}
                        strokeWidth={2}
                        fill={VIZ.discharged}
                        fillOpacity={0.08}
                        isAnimationActive={false}
                    />
                </AreaChart>
            </ResponsiveContainer>
            <Legend
                items={[
                    { color: VIZ.charged, label: 'Charged (Ah in)' },
                    { color: VIZ.discharged, label: 'Discharged (Ah out)' },
                ]}
            />
        </ChartCard>
    );
}

interface EnergyRow {
    bucket: string;
    charged: number;
    discharged: number;
    inCharged: number;
    inDischarged: number;
}

function EnergyTooltip({
    active,
    payload,
    granularity,
}: {
    active?: boolean;
    payload?: Array<{ payload: EnergyRow }>;
    granularity?: Granularity;
}) {
    const p = payload?.[0]?.payload;
    if (!active || !p) return null;
    return (
        <TooltipShell
            title={bucketLabel(p.bucket, granularity ?? 'day')}
            rows={[
                ['Charged this period', `${p.inCharged} Ah`],
                ['Discharged this period', `${p.inDischarged} Ah`],
                ['Cumulative charged', `${p.charged} Ah`],
                ['Cumulative discharged', `${p.discharged} Ah`],
                ['Net (in − out)', `${Math.round((p.charged - p.discharged) * 10) / 10} Ah`],
            ]}
        />
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
