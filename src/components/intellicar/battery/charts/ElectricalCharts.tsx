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
import { AlertTriangle, BatteryLow, Thermometer, Zap, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
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
import type { ElectricalData, Granularity } from '../types';

/**
 * Voltage and current as a min–max envelope with a median line — **never a raw per-sample
 * line**.
 *
 * Pack voltage and current move on a ~1-second timescale. We sample every ~8.5 minutes. A raw
 * line through those points is an aliased noise band: it looks like signal, it invites the
 * reader to "see" spikes, and every one of those spikes is an artefact of the sampling rate.
 * The envelope says exactly what we know — the range the value occupied in each bucket, and
 * where its middle sat — and nothing more.
 */
function EnvelopeChart({
    title,
    subtitle,
    unit,
    rows,
    granularity,
    lo,
    mid,
    hi,
    band,
    color,
    thresholds,
    yDomain,
    headline,
    caveat,
}: {
    title: string;
    subtitle: string;
    unit: string;
    rows: Array<Record<string, unknown>>;
    granularity: Granularity;
    lo: string;
    mid: string;
    hi: string;
    /** [lowKey, spanKey] — a stacked pair that paints the band between lo and hi. */
    band: [string, string];
    color: string;
    thresholds?: Array<{ value: number; label: string; color: string }>;
    /**
     * Explicit y-axis window, tightened to the data envelope so the median line and band fill
     * the height instead of collapsing to a flat strip. Breach lines outside it clip (recharts
     * default) and reappear only as the data approaches them — which is exactly when they matter.
     */
    yDomain?: [number, number];
    headline?: React.ReactNode;
    caveat?: React.ReactNode;
}) {
    return (
        <ChartCard
            title={title}
            subtitle={subtitle}
            headline={headline}
            empty={rows.length === 0 ? 'No telemetry in this period.' : undefined}
            caveat={caveat}
        >
            <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={rows} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
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
                        tick={TICK}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={52}
                        unit={unit}
                        domain={yDomain ?? ['auto', 'auto']}
                        allowDataOverflow={yDomain != null}
                    />
                    <Tooltip
                        cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
                        content={({ active, payload }) => {
                            const p = payload?.[0]?.payload as Record<string, number | string | null> | undefined;
                            if (!active || !p) return null;
                            return (
                                <TooltipShell
                                    title={bucketLabel(String(p.bucket), granularity)}
                                    rows={[
                                        ['Maximum', p[hi] != null ? `${p[hi]}${unit}` : '—'],
                                        ['Median', p[mid] != null ? `${p[mid]}${unit}` : '—'],
                                        ['Minimum', p[lo] != null ? `${p[lo]}${unit}` : '—'],
                                        ['Samples', String(p.n ?? 0)],
                                    ]}
                                />
                            );
                        }}
                    />
                    {thresholds?.map((t) => (
                        <ReferenceLine
                            key={t.label}
                            y={t.value}
                            stroke={t.color}
                            strokeDasharray="4 3"
                            label={{
                                value: t.label,
                                position: 'insideTopLeft',
                                fontSize: 10,
                                fill: t.color,
                            }}
                        />
                    ))}
                    {/* The band is drawn as two stacked areas: an invisible one up to the minimum,
                      * then the min→max span. That is how recharts paints a range without a second
                      * y-axis or a custom shape. */}
                    <Area
                        type="monotone"
                        dataKey={band[0]}
                        stackId="band"
                        stroke="none"
                        fill="none"
                        isAnimationActive={false}
                        legendType="none"
                    />
                    <Area
                        type="monotone"
                        dataKey={band[1]}
                        stackId="band"
                        stroke="none"
                        fill={color}
                        fillOpacity={0.12}
                        isAnimationActive={false}
                        legendType="none"
                    />
                    <Line
                        type="monotone"
                        dataKey={mid}
                        name="Median"
                        stroke={color}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                    />
                </ComposedChart>
            </ResponsiveContainer>
            <Legend
                items={[
                    { color, label: 'Median' },
                    { color, label: 'Min–max range (shaded)' },
                ]}
            />
        </ChartCard>
    );
}

const SAMPLING_NOTE = (
    <p>
        Sampled about every 8.5 minutes. Pack voltage and current move on a one-second timescale,
        so this is the range each period occupied — <strong>not a trace of the actual waveform</strong>.
        A raw line through these points would draw spikes that are artefacts of the sampling rate,
        not events.
    </p>
);

export function VoltageTrendChart({
    data,
    granularity,
}: {
    data: ElectricalData | undefined;
    granularity: Granularity;
}) {
    const rows = (data?.buckets ?? [])
        .filter((b) => b.v_med != null)
        .map((b) => ({
            t: bucketLabel(b.bucket, granularity),
            bucket: b.bucket,
            v_min: b.v_min,
            v_med: b.v_med,
            v_max: b.v_max,
            n: b.n,
            _base: b.v_min ?? 0,
            _span: (b.v_max ?? 0) - (b.v_min ?? 0),
        }));

    const t = data?.thresholds;
    const lastMed = rows.length ? rows[rows.length - 1].v_med : null;

    // Tighten the axis to the voltage the pack actually occupied (± ~2 V of headroom). The old
    // ['auto','auto'] domain folded the far-apart under/over-voltage lines into the extent, so
    // the real band collapsed into a flat strip. Breach lines clip until the pack drifts toward
    // them — which is precisely when they carry information.
    const vMins = rows.map((r) => r.v_min).filter((v): v is number => v != null);
    const vMaxs = rows.map((r) => r.v_max).filter((v): v is number => v != null);
    const vDomain: [number, number] | undefined =
        vMins.length && vMaxs.length
            ? [Math.floor(Math.min(...vMins) - 2), Math.ceil(Math.max(...vMaxs) + 2)]
            : undefined;

    return (
        <EnvelopeChart
            title="Voltage Trend"
            subtitle="Pack voltage per period — the range it occupied and where its middle sat."
            unit=" V"
            rows={rows}
            granularity={granularity}
            lo="v_min"
            mid="v_med"
            hi="v_max"
            band={['_base', '_span']}
            color={VIZ.charged}
            thresholds={
                t
                    ? [
                          { value: t.overVoltageV, label: `Over ${t.overVoltageV} V`, color: VIZ.criticalLine },
                          { value: t.underVoltageV, label: `Under ${t.underVoltageV} V`, color: VIZ.warningLine },
                      ]
                    : undefined
            }
            yDomain={vDomain}
            headline={lastMed != null ? <Headline value={lastMed} unit="V median" sub="latest period" /> : undefined}
            caveat={SAMPLING_NOTE}
        />
    );
}

export function CurrentTrendChart({
    data,
    granularity,
}: {
    data: ElectricalData | undefined;
    granularity: Granularity;
}) {
    const rows = (data?.buckets ?? [])
        .filter((b) => b.i_med != null)
        .map((b) => ({
            t: bucketLabel(b.bucket, granularity),
            bucket: b.bucket,
            i_min: b.i_min,
            i_med: b.i_med,
            i_max: b.i_max,
            n: b.n,
            _base: b.i_min ?? 0,
            _span: (b.i_max ?? 0) - (b.i_min ?? 0),
        }));

    const t = data?.thresholds;
    const peak = rows.length ? Math.max(...rows.map((r) => r.i_max ?? 0)) : null;

    // Current is an unsigned magnitude idling near zero, so the band runs 0→peak. Cap the axis at
    // the observed peak (± a little), not at the far-off over-current line, so the peaks that
    // matter fill the height instead of being squashed into a sliver under a floating threshold.
    const iDomain: [number, number] | undefined =
        peak != null && peak > 0 ? [0, Math.ceil(peak + Math.max(5, peak * 0.08))] : undefined;

    return (
        <EnvelopeChart
            title="Current Trend"
            subtitle="Pack current per period. The BMS reports an unsigned magnitude, so this is the size of the current, not its direction — charge and discharge both read positive."
            unit=" A"
            rows={rows}
            granularity={granularity}
            lo="i_min"
            mid="i_med"
            hi="i_max"
            band={['_base', '_span']}
            color={VIZ.discharged}
            thresholds={
                t ? [{ value: t.overCurrentA, label: `Over ${t.overCurrentA} A`, color: VIZ.criticalLine }] : undefined
            }
            yDomain={iDomain}
            headline={peak != null ? <Headline value={peak} unit="A peak" sub="across the period" /> : undefined}
            caveat={
                <>
                    {SAMPLING_NOTE}
                    <p>
                        The median sits near zero because the pack is idle most of the time. The upper edge
                        of the band is the number that matters: it is what the pack was asked to deliver.
                    </p>
                </>
            }
        />
    );
}

/**
 * Red flags — **observed** breaches.
 *
 * Every count here except temperature is a LOWER BOUND, and the card says so on its face. A
 * real over-voltage transient lasts seconds; we sample every ~510 s, so we catch roughly 1% of
 * them. "0 over-voltage" means we did not see one, not that there was not one. Presenting that
 * as a count would be the most dangerous number on this dashboard — an operator would read
 * "zero faults" off a chart that cannot see faults.
 *
 * Temperature is the exception and is labelled as such: thermal mass moves on a minutes
 * timescale, so an over-temperature event genuinely is observable at this cadence.
 */
export function RedFlagCards({ data }: { data: ElectricalData | undefined }) {
    const b = data?.breaches;
    const t = data?.thresholds;
    if (!b || !t) return null;

    const flags = [
        {
            key: 'underVoltage',
            icon: BatteryLow,
            label: 'Under Voltage',
            value: b.underVoltage,
            detail: `below ${t.underVoltageV} V`,
            observed: true,
        },
        {
            key: 'overVoltage',
            icon: Zap,
            label: 'Over Voltage',
            value: b.overVoltage,
            detail: `above ${t.overVoltageV} V`,
            observed: true,
        },
        {
            key: 'overCurrent',
            icon: AlertTriangle,
            label: 'Over Current',
            value: b.overCurrent,
            detail: `above ${t.overCurrentA} A`,
            observed: true,
        },
        {
            key: 'overTemperature',
            icon: Thermometer,
            label: 'Over Temperature',
            value: b.overTemperature,
            detail: `above ${t.overTemperatureC} °C`,
            // The one flag that fully works at this sampling rate.
            observed: false,
        },
        {
            key: 'weakCharge',
            icon: BatteryLow,
            label: 'Weak Charge',
            value: b.weakCharge,
            detail: `avg current below ${t.weakChargeCurrentA} A during a charge`,
            observed: false,
        },
    ];

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {flags.map((f) => (
                    <div
                        key={f.key}
                        className={cn(
                            'p-4 bg-white rounded-xl border shadow-sm',
                            f.value > 0 ? 'border-red-200' : 'border-gray-100',
                        )}
                    >
                        <div className="flex items-center gap-2 mb-2">
                            {/* Icon + label, never colour alone — a status colour must not be the
                              * only thing carrying the meaning. */}
                            <f.icon className={cn('w-4 h-4', f.value > 0 ? 'text-red-600' : 'text-gray-400')} />
                            <span className="text-xs font-medium text-gray-500">{f.label}</span>
                        </div>
                        <p className={cn('text-xl font-bold', f.value > 0 ? 'text-red-600' : 'text-gray-900')}>
                            {f.value}
                            {f.observed && <span className="text-xs font-medium text-gray-400 ml-1">observed</span>}
                        </p>
                        <p className="text-[11px] text-gray-400 mt-0.5 leading-tight">{f.detail}</p>
                    </div>
                ))}
            </div>

            <div className="flex gap-2.5 p-3.5 rounded-xl bg-amber-50 border border-amber-100">
                <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900 space-y-1.5">
                    <p>
                        <strong>Voltage and current counts are a floor, not a total.</strong> A real
                        electrical transient lasts seconds; this battery is sampled about every{' '}
                        {Math.round((data.summary.medianSampleGapS ?? 510) / 60)} minutes, so we see roughly
                        1% of them. A reading of 0 means <em>we did not catch one</em> — not that none
                        occurred. Detecting transients properly is a job for the BMS-side poller, which sees
                        every frame.
                    </p>
                    <p>
                        <strong>Over Temperature</strong> and <strong>Weak Charge</strong> are exceptions and
                        are trustworthy: heat moves slowly enough to be caught at this rate, and weak charge
                        is measured across a whole charging cycle rather than at an instant.
                    </p>
                </div>
            </div>
        </div>
    );
}
