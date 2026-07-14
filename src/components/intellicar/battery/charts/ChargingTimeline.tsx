'use client';

import { useMemo, useState } from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceArea,
    Brush,
} from 'recharts';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VIZ, TICK, AXIS_LINE, formatDuration } from './chart-kit';
import type { AhSession, DischargeCycle, SocTimeline } from '../types';

type SegmentKind = 'charge' | 'discharge';

interface Segment {
    kind: SegmentKind;
    from: number;
    to: number;
    /** The cycle record behind this band — everything the detail panel shows. */
    rows: Array<[string, string]>;
    title: string;
}

const timeFmt = (ts: number) =>
    new Date(ts).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });

/**
 * Charging Timeline — SOC over time, with charge and discharge segments shaded.
 *
 * This is the chart that makes cycle detection falsifiable by eye: every rising limb should be
 * green, every falling limb orange, and nothing important left bare. The shading comes from the
 * same aggregates that feed the cards, so what you see here IS what the numbers counted — that
 * was not always true (the chart used to shade runs the cards had thrown away).
 *
 * Expandable, and selectable: clicking a band opens the full record for that cycle beneath the
 * chart, rather than in a modal — a modal would cover the very shape you are trying to read the
 * detail against.
 */
export function ChargingTimeline({
    timeline,
    chargeCycles,
    dischargeCycles,
}: {
    timeline: SocTimeline | undefined;
    chargeCycles: AhSession[];
    dischargeCycles: DischargeCycle[];
}) {
    const [expanded, setExpanded] = useState(false);
    const [selected, setSelected] = useState<Segment | null>(null);

    const data = useMemo(
        () =>
            (timeline?.points ?? []).map((p) => ({
                ts: new Date(p.time).getTime(),
                soc: p.soc_pct,
            })),
        [timeline],
    );

    // Charge bands come from the timeline's own in_cycle flag (server-side, post-validity), and
    // discharge bands from the discharge cycles' start/end times. Both are the authoritative
    // aggregates — neither is re-derived here, so a band cannot disagree with a card.
    const segments = useMemo<Segment[]>(() => {
        const segs: Segment[] = [];

        chargeCycles.forEach((c, i) => {
            segs.push({
                kind: 'charge',
                from: new Date(c.start_time).getTime(),
                to: new Date(c.end_time).getTime(),
                title: `Charge #${i + 1}`,
                rows: [
                    ['Time', `${timeFmt(new Date(c.start_time).getTime())} → ${timeFmt(new Date(c.end_time).getTime())}`],
                    ['Duration', formatDuration(c.duration_s)],
                    ['SOC', c.start_soc != null && c.end_soc != null ? `${c.start_soc}% → ${c.end_soc}%` : '—'],
                    ['SOC gained', c.soc_difference != null ? `${c.soc_difference}%` : '—'],
                    ['Charged', `${c.ah_charged} Ah`],
                    ['Avg current', c.avg_charging_current != null ? `${c.avg_charging_current} A` : '—'],
                    ['Peak current', c.max_charging_current != null ? `${c.max_charging_current} A` : '—'],
                    ['Estimated capacity', c.estimated_capacity_ah != null ? `${c.estimated_capacity_ah} Ah` : 'not estimated'],
                    ['Data coverage', c.coverage_pct != null ? `${c.coverage_pct}%` : '—'],
                    ['CAN samples', String(c.n_samples)],
                ],
            });
        });

        dischargeCycles.forEach((d, i) => {
            segs.push({
                kind: 'discharge',
                from: new Date(d.start_time).getTime(),
                to: new Date(d.end_time).getTime(),
                title: `Discharge #${i + 1}`,
                rows: [
                    ['Time', `${timeFmt(new Date(d.start_time).getTime())} → ${timeFmt(new Date(d.end_time).getTime())}`],
                    ['Duration', formatDuration(d.duration_s)],
                    ['SOC', d.start_soc != null && d.end_soc != null ? `${d.start_soc}% → ${d.end_soc}%` : '—'],
                    ['Depth of discharge', d.dod_pct != null ? `${d.dod_pct}%` : '—'],
                    // Discharge only: a charge cycle happens parked, and a fake-precise
                    // "0.2 km" of GPS jitter on it would invite misreading.
                    [
                        'Distance covered',
                        d.km != null ? `${d.km} km${d.km_source === 'gps' ? ' (GPS lower bound)' : ''}` : '—',
                    ],
                    ['Mileage', d.km_per_ah != null ? `${d.km_per_ah} km/Ah` : '—'],
                    ['Discharged (from SOC)', d.ah_discharged_soc != null ? `${d.ah_discharged_soc} Ah` : '—'],
                    [
                        'Discharged (coulomb)',
                        d.ah_discharged_coulomb != null ? `${d.ah_discharged_coulomb} Ah` : 'too sparse to integrate',
                    ],
                    ['Divergence', d.divergence_pct != null ? `${d.divergence_pct}%` : '—'],
                    ['Peak current', d.max_discharge_current != null ? `${d.max_discharge_current} A` : '—'],
                    ['CAN samples', String(d.n_samples)],
                ],
            });
        });

        return segs.sort((a, b) => a.from - b.from);
    }, [chargeCycles, dischargeCycles]);

    // ReferenceArea has no reliable onClick, so selection goes through the chart's own click and
    // maps the active timestamp back to the band containing it.
    const handleClick = (e: { activeLabel?: string | number } | null) => {
        const ts = Number(e?.activeLabel);
        if (!Number.isFinite(ts)) return;
        const hit = segments.find((s) => ts >= s.from && ts <= s.to);
        setSelected(hit ?? null);
    };

    const height = expanded ? 520 : 300;

    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4 p-6 pb-3">
                <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900">Charging Timeline</h3>
                    <p className="text-xs text-gray-500 mt-1 max-w-xl">
                        SOC over time. Every rising limb should be shaded green and every fall orange — this
                        is how the cycle detection above is verified by eye. Click a band for its full record;
                        drag the slider beneath to zoom.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors shrink-0"
                >
                    {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    {expanded ? 'Collapse' : 'Expand'}
                </button>
            </div>

            {data.length > 0 ? (
                <>
                    <div className="px-2">
                        <ResponsiveContainer width="100%" height={height}>
                            <LineChart
                                data={data}
                                margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                                onClick={handleClick}
                            >
                                <CartesianGrid horizontal vertical={false} stroke={VIZ.grid} />
                                <XAxis
                                    dataKey="ts"
                                    type="number"
                                    scale="time"
                                    domain={['dataMin', 'dataMax']}
                                    tickFormatter={(ts) =>
                                        new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                                    }
                                    tick={TICK}
                                    tickLine={false}
                                    axisLine={AXIS_LINE}
                                    tickMargin={8}
                                />
                                <YAxis
                                    domain={[0, 100]}
                                    tick={TICK}
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={8}
                                    width={44}
                                    unit="%"
                                />
                                <Tooltip
                                    labelFormatter={(ts) => timeFmt(Number(ts))}
                                    formatter={(v: number) => [`${v}%`, 'SOC']}
                                    cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
                                />
                                {segments.map((s) => (
                                    <ReferenceArea
                                        key={`${s.kind}-${s.from}`}
                                        x1={s.from}
                                        x2={s.to}
                                        fill={s.kind === 'charge' ? VIZ.chargeSpan : VIZ.dischargeSpan}
                                        fillOpacity={selected && selected.from === s.from ? 0.32 : 0.12}
                                        stroke="none"
                                    />
                                ))}
                                <Line
                                    type="monotone"
                                    dataKey="soc"
                                    name="SOC"
                                    stroke={VIZ.soc}
                                    strokeWidth={2}
                                    dot={false}
                                    connectNulls
                                    isAnimationActive={false}
                                />
                                <Brush
                                    dataKey="ts"
                                    height={22}
                                    stroke={VIZ.tick}
                                    travellerWidth={8}
                                    tickFormatter={(ts) =>
                                        new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                                    }
                                />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-6 pt-3 text-xs text-gray-500">
                        <span className="inline-flex items-center gap-1.5">
                            <span
                                className="inline-block w-3 h-3 rounded-sm"
                                style={{ backgroundColor: VIZ.chargeSpan, opacity: 0.28 }}
                            />
                            Charging cycle
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                            <span
                                className="inline-block w-3 h-3 rounded-sm"
                                style={{ backgroundColor: VIZ.dischargeSpan, opacity: 0.28 }}
                            />
                            Discharge cycle
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                            <svg width="16" height="10" aria-hidden>
                                <line x1="0" y1="5" x2="16" y2="5" stroke={VIZ.soc} strokeWidth="2" />
                            </svg>
                            State of charge
                        </span>
                    </div>

                    {/* The detail sits BELOW the chart, not in a modal: a modal would cover the shape
                      * you are trying to read the numbers against. */}
                    {selected && (
                        <div className="mx-6 mt-4 mb-5 rounded-xl border border-gray-100 bg-gray-50/70 overflow-hidden">
                            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-100">
                                <span className="inline-flex items-center gap-2 text-sm font-semibold text-gray-900">
                                    <span
                                        className="inline-block w-2.5 h-2.5 rounded-sm"
                                        style={{
                                            backgroundColor:
                                                selected.kind === 'charge' ? VIZ.chargeSpan : VIZ.dischargeSpan,
                                        }}
                                    />
                                    {selected.title}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setSelected(null)}
                                    className="p-1 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                                    aria-label="Close detail"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 px-4 py-3">
                                {selected.rows.map(([label, value]) => (
                                    <div
                                        key={label}
                                        className="flex items-baseline justify-between gap-4 py-[3px] text-xs"
                                    >
                                        <dt className="text-gray-500">{label}</dt>
                                        <dd className="text-gray-900 font-medium tabular-nums text-right">{value}</dd>
                                    </div>
                                ))}
                            </dl>
                        </div>
                    )}

                    {!selected && (
                        <p className={cn('px-6 pb-5 pt-3 text-xs text-gray-400')}>
                            {segments.length} cycles shaded — {chargeCycles.length} charges,{' '}
                            {dischargeCycles.length} discharges. Click any band to open its record.
                        </p>
                    )}
                </>
            ) : (
                <div className="h-48 flex items-center justify-center text-gray-400 text-sm">
                    No telemetry in this period
                </div>
            )}
        </div>
    );
}
