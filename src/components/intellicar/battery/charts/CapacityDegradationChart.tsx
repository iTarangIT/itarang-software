'use client';

import { ChevronRight, Gauge } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceLine,
    ReferenceArea,
} from 'recharts';
import { capacityAxis } from '../capacity-axis';
import { capacityBands } from '@/lib/telemetry/thresholds-math';
import { VIZ } from './chart-kit';
import {
    CAPACITY_COLOR,
    type AhSession,
    type AhSummary,
    type BatteryThresholds,
    type CapacityPoint,
} from '../types';

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' });

/**
 * A count with its name. Four paragraphs of prose said what five chips say at a glance, and the
 * chips are the part that actually changes when you switch battery or period.
 */
function Chip({
    tone,
    value,
    label,
}: {
    tone: 'brand' | 'muted' | 'danger';
    value: number;
    label: string;
}) {
    return (
        <span
            className={cn(
                'inline-flex items-baseline gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border',
                tone === 'brand' && 'bg-violet-50 border-violet-100 text-violet-700',
                tone === 'muted' && 'bg-gray-50 border-gray-100 text-gray-500',
                tone === 'danger' && 'bg-red-50 border-red-100 text-red-600',
            )}
        >
            <span className="tabular-nums font-semibold">{value}</span>
            <span className="font-normal">{label}</span>
        </span>
    );
}

/**
 * Filled marker for a well-sampled cycle, hollow for one whose capacity leans on
 * interpolation across telemetry gaps. Both are real points on the trend — the shape
 * says how much weight to put on each, which a uniform dot would hide.
 */
interface DotPayload extends CapacityPoint {
    offScale?: boolean;
    offScaleUp?: boolean;
}

function CapacityDot(props: { cx?: number; cy?: number; payload?: DotPayload }) {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null || !payload) return null;

    // An off-scale point is clamped to the axis edge so it stays visible. A circle there would be
    // read as its value, which would be a lie — a 1,199 Ah fault would look like a 170 Ah battery.
    // A caret says "this continues past the edge", which is the truth.
    if (payload.offScale) {
        const dir = payload.offScaleUp ? -1 : 1;
        return (
            <polygon
                points={`${cx},${cy + dir * 6} ${cx - 5},${cy - dir * 3} ${cx + 5},${cy - dir * 3}`}
                fill="#ffffff"
                stroke={VIZ.criticalLine}
                strokeWidth={2}
            />
        );
    }

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
    const interval =
        p.samples > 1 && p.durationS > 0
            ? Math.round((p.durationS / (p.samples - 1)) * 10) / 10
            : null;
    const rows: Array<[string, string]> = [
        ['Time', `${clockFmt(p.startTime)} – ${clockFmt(p.endTime)}`],
        ['Duration', formatDuration(p.durationS)],
        ['SOC', p.startSoc != null && p.endSoc != null ? `${p.startSoc}% → ${p.endSoc}%` : '—'],
        ['SOC gained', p.socDiff != null ? `${p.socDiff}%` : '—'],
        ['Charged', `${p.ahCharged} Ah`],
        ['Avg current', p.avgCurrent != null ? `${p.avgCurrent} A` : '—'],
        // The three inputs to the confidence grade, so the grade is never a black box.
        ['Samples', String(p.samples)],
        ['Sampled every', interval != null ? `${Math.round(interval / 60)} min` : '—'],
        ['Coverage', p.coverage != null ? `${p.coverage}%` : '—'],
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
                {/* The badge does the work the paragraph used to. */}
                {!p.plausible ? (
                    <p className="mt-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-red-50 text-red-600">
                        Telemetry fault — impossible vs {rated} Ah
                    </p>
                ) : p.confidence !== 'high' ? (
                    <p className="mt-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700">
                        {p.confidence === 'low' ? 'Low confidence' : 'Medium confidence'} — read with care
                    </p>
                ) : (
                    <p className="mt-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-violet-50 text-violet-700">
                        Trusted
                    </p>
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
 * One point per *plottable* cycle. Cycles without a capacity estimate are dropped rather
 * than carried as null holes: this is a degradation trend, and a point we declined to
 * compute is not a point on it. Cycle numbers still count every detected cycle, so #3 → #7
 * in the tooltip is a visible, honest gap.
 */
export function toCapacityPoints(sessions: AhSession[]): CapacityPoint[] {
    return sessions
        .map((s) => ({ ...s, cycleNo: s.cycle_no }))
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
            confidence: s.capacity_confidence,
            lowConfidence: s.capacity_confidence !== 'high',
            plausible: s.capacity_plausible,
        }));
}

/**
 * AH Trend — the battery-health chart.
 *
 * Plots Estimated Capacity, NOT AH charged per session: AH charged scales with the starting
 * SOC (20%→100% adds more than 80%→100% on an identical pack), so a trend of it tracks
 * charging habits rather than battery health. Capacity normalises that out —
 * Total AH ÷ (SOC difference / 100). See docs/intellicar-calculations.md §5–6.
 */
export function CapacityDegradationChart({
    sessions,
    summary,
    periodLabel,
    thresholds,
}: {
    sessions: AhSession[];
    summary: AhSummary | undefined;
    periodLabel: string;
    thresholds?: BatteryThresholds;
}) {
    const rated = summary?.ratedCapacityAh ?? null;
    const chartData = toCapacityPoints(sessions);

    // Bands are fractions of THIS pack's own BMS nameplate, not fixed numbers. On the 105 Ah
    // packs in this fleet that gives 94.5 / 84 Ah — the 95/85 that was asked for — but it
    // generalises to a pack of any rating. A battery that reports no nameplate gets NO bands
    // rather than being judged against a number invented for it.
    //
    // capacityBands() is that rule, and it is the tested one (thresholds-math.ts is pure, so it
    // imports cleanly here). This used to recompute `rated x frac` inline: the same arithmetic in
    // two places, one of them covered. The thresholds a reader is judged against must not be able
    // to disagree with the thresholds the tests pin.
    const bands = thresholds ? capacityBands(rated, thresholds) : null;

    // ── The axis domain ──────────────────────────────────────────────────────────
    //
    // Scaled to the PLAUSIBLE points (within 0.3×–1.5× of the nameplate), not to every point.
    //
    // A capacity is Ah ÷ (ΔSOC/100), so a cycle that gained 1% SOC amplifies any error in its Ah
    // total a hundredfold. On the reference battery exactly one such cycle — ΔSOC 1%, two samples —
    // extrapolates to **1,199 Ah on a 105 Ah pack**. Letting that set the scale stretches the axis
    // to 0–1200 and crushes the other 42 cycles, the three threshold rules and every tick into a
    // five-pixel smear at the bottom of the canvas. The chart becomes unreadable because of one
    // number that is already known to be a measurement fault.
    //
    // So the domain ignores the implausible points — and `allowDataOverflow` on the YAxis is what
    // makes that stick. Recharts defaults it to FALSE, which silently EXPANDS whatever domain you
    // give it to fit the data; computing a careful domain and not setting this flag means the
    // domain is quietly discarded, which is exactly what happened here.
    const plausiblePoints = chartData.filter((d) => d.plausible).map((d) => d.capacity as number);
    const domainSource = plausiblePoints.length > 0
        ? plausiblePoints
        : chartData.map((d) => d.capacity as number);

    const yAxis = capacityAxis(
        bands ? [...domainSource, bands.critical] : domainSource,
        rated,
    );
    const [lo, hi] = yAxis.domain;

    // ONE line through EVERY cycle, in order.
    //
    // The confidence still shows — in the MARKER, not by breaking the line: filled = trusted,
    // hollow = the evidence is thin, caret = the value runs off the scale. So the shape of the
    // battery's life is continuous and readable, and the weight to give any single point is still
    // right there on the point.
    //
    // Read the hollow ones with care. Capacity is Ah ÷ (ΔSOC/100), so a cycle that gained 2% SOC
    // multiplies any error in its Ah total fiftyfold — a dip or a spike through a run of hollow
    // markers is far more likely to be the poller than the pack.
    //
    // Off-scale points are CLAMPED to the axis edge, never dropped: a cycle reading 1,199 Ah on a
    // 105 Ah pack is a fault worth seeing. Clamping keeps it on screen and keeps the line
    // continuous; the caret says the true value is beyond the edge, so its position on the axis is
    // never mistaken for its value.
    const clamp = (v: number) => Math.min(Math.max(v, lo), hi);
    const series = chartData.map((d) => {
        const cap = d.capacity as number;
        const offScale = cap > hi || cap < lo;
        return {
            ...d,
            offScale,
            offScaleUp: cap > hi,
            cap: clamp(cap),
        };
    });

    const offScaleCount = series.filter((d) => d.offScale).length;

    const capacities = chartData
        .filter((d) => d.confidence === 'high')
        .map((d) => d.capacity as number);

    const meanCapacity = capacities.length
        ? Math.round((capacities.reduce((a, b) => a + b, 0) / capacities.length) * 10) / 10
        : null;
    const pctOfRated = meanCapacity != null && rated ? Math.round((meanCapacity / rated) * 100) : null;

    const minSoc = summary?.gates.minSocDifference ?? 20;
    const minCoverage = summary?.gates.minCoveragePct ?? 0;
    const minSamples = summary?.gates.minSamples ?? 5;

    const conf = summary?.capacityConfidence ?? { high: 0, medium: 0, low: 0 };
    const topUps = summary?.topUpCycles ?? 0;
    const faults = summary?.implausibleCycles ?? 0;

    // The X labels are dates, but the X *key* is the cycle number — several cycles can land on one
    // day, and repeating "14 Jun" four times in a row is noise. Show a date only when it changes.
    const tickLabel = (i: number) => {
        const t = chartData[i]?.t;
        return t && t !== chartData[i - 1]?.t ? t : '';
    };

    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4 p-6 pb-4">
                <div className="min-w-0">
                    <h3 className="text-base font-semibold text-gray-900">Capacity Degradation</h3>
                    <p className="text-xs text-gray-500 mt-1">
                        Estimated capacity per charging cycle, against the {rated ?? '—'} Ah nameplate.
                    </p>
                </div>
                {meanCapacity != null && (
                    <div className="text-right shrink-0">
                        <p className="text-2xl font-semibold text-gray-900 tabular-nums leading-none">
                            {meanCapacity}
                            <span className="text-sm font-medium text-gray-400 ml-1">Ah avg</span>
                        </p>
                        <p className="text-xs text-gray-400 mt-1.5">
                            {pctOfRated != null && <>{pctOfRated}% of rated · </>}
                            {periodLabel}
                        </p>
                    </div>
                )}
            </div>

            {chartData.length > 0 ? (
                <>
                    <div className="px-2 pb-1">
                        <ResponsiveContainer width="100%" height={300}>
                            <LineChart data={series} margin={{ top: 16, right: 64, left: 8, bottom: 8 }}>
                                {/* Horizontal rules only: the X axis is ordinal cycles, so vertical
                                  * rules would imply a continuous time scale the axis doesn't have. */}
                                <CartesianGrid horizontal vertical={false} stroke={VIZ.grid} />
                                {/* Only the ZONES THAT MEAN SOMETHING BAD are shaded.
                                  *
                                  * A green wash over everything above the warning line covered two
                                  * thirds of the canvas and said nothing — "healthy" is the default,
                                  * and colouring the default just adds ink. Shading only the warning
                                  * and critical bands leaves the eye nowhere to go except the trouble. */}
                                {bands && (
                                    <>
                                        <ReferenceArea
                                            y1={bands.critical}
                                            y2={bands.warning}
                                            fill={VIZ.bandWarning}
                                            fillOpacity={0.08}
                                            stroke="none"
                                        />
                                        <ReferenceArea
                                            y1={yAxis.domain[0]}
                                            y2={bands.critical}
                                            fill={VIZ.bandCritical}
                                            fillOpacity={0.06}
                                            stroke="none"
                                        />
                                    </>
                                )}
                                <XAxis
                                    dataKey="cycleNo"
                                    type="category"
                                    interval="preserveStartEnd"
                                    minTickGap={28}
                                    // A date only where it changes — several cycles share a day, and
                                    // "14 Jun 14 Jun 14 Jun" is noise, not information.
                                    tickFormatter={(_v, i) => tickLabel(i)}
                                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                                    tickLine={false}
                                    axisLine={{ stroke: '#e2e8f0' }}
                                    tickMargin={10}
                                />
                                <YAxis
                                    domain={yAxis.domain}
                                    ticks={yAxis.ticks}
                                    // WITHOUT THIS, RECHARTS DISCARDS THE DOMAIN ABOVE. It defaults
                                    // to false, meaning "grow the domain to fit the data" — so a
                                    // single 1,199 Ah measurement fault silently rescaled the whole
                                    // chart and flattened the real trend into a hairline.
                                    allowDataOverflow
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
                                {/* The three rules live in the RIGHT GUTTER, not over the plot.
                                  *
                                  * They used to be labelled `insideLeft`, where all three landed on
                                  * top of each other and on the Y-axis ticks — an unreadable pile of
                                  * red and amber. Rated / Warning / Critical are only 10 Ah apart, so
                                  * on any sane axis their labels WILL collide unless they are moved
                                  * off the data entirely. The right margin exists for them. */}
                                {rated != null && (
                                    <ReferenceLine
                                        y={rated}
                                        stroke="#cbd5e1"
                                        strokeDasharray="5 4"
                                        label={{
                                            value: `Rated ${rated}`,
                                            position: 'right',
                                            fontSize: 10,
                                            fill: '#94a3b8',
                                        }}
                                    />
                                )}
                                {bands && (
                                    <>
                                        <ReferenceLine
                                            y={bands.warning}
                                            stroke={VIZ.warningLine}
                                            strokeDasharray="4 3"
                                            label={{
                                                value: `Warn ${bands.warning}`,
                                                position: 'right',
                                                fontSize: 10,
                                                fill: VIZ.warningLine,
                                            }}
                                        />
                                        <ReferenceLine
                                            y={bands.critical}
                                            stroke={VIZ.criticalLine}
                                            strokeDasharray="4 3"
                                            label={{
                                                value: `Crit ${bands.critical}`,
                                                position: 'right',
                                                fontSize: 10,
                                                fill: VIZ.criticalLine,
                                            }}
                                        />
                                    </>
                                )}
                                {/* ONE line, every cycle, in order.
                                  *
                                  * Straight segments and circular markers: each point is one measured
                                  * cycle, and a smoothing curve would invent capacity between them.
                                  * The marker — filled, hollow, or caret — carries the confidence, so
                                  * the line can stay continuous without pretending every point is
                                  * equally solid. */}
                                <Line
                                    type="linear"
                                    dataKey="cap"
                                    name="Estimated Capacity"
                                    stroke={CAPACITY_COLOR}
                                    strokeWidth={2}
                                    connectNulls
                                    dot={<CapacityDot />}
                                    activeDot={{ r: 6, fill: CAPACITY_COLOR, stroke: '#fff', strokeWidth: 2 }}
                                    isAnimationActive={false}
                                />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>

                    {/* The line joins every cycle; the MARKER says how much to trust each one. That
                      * is a second encoding, so it has to be named. */}
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-6 pt-3 text-xs text-gray-500">
                        <span className="inline-flex items-center gap-1.5">
                            <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill={CAPACITY_COLOR} /></svg>
                            Trusted estimate
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                            <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" fill="#fff" stroke={CAPACITY_COLOR} strokeWidth="2" /></svg>
                            Thin evidence — read with care
                        </span>
                        {offScaleCount > 0 && (
                            <span className="inline-flex items-center gap-1.5">
                                <svg width="12" height="10" aria-hidden>
                                    <polygon points="6,1 1,8 11,8" fill="#fff" stroke={VIZ.criticalLine} strokeWidth="2" />
                                </svg>
                                Off the scale — hover for its real value
                            </span>
                        )}
                        <span className="inline-flex items-center gap-1.5">
                            <svg width="16" height="10" aria-hidden><line x1="0" y1="5" x2="16" y2="5" stroke="#cbd5e1" strokeWidth="2" strokeDasharray="5 4" /></svg>
                            Rated capacity
                        </span>
                    </div>

                    {/* The reasoning used to live here as four paragraphs. It was correct and nobody
                      * would ever read it — a wall of text under a chart is not an explanation, it
                      * is an apology. The counts are the part that changes and the part that
                      * matters, so they become chips; the reasoning goes behind a disclosure for the
                      * one reader in twenty who wants it. Nothing is lost, nothing is shouted. */}
                    <div className="px-6 pb-5 pt-4 border-t border-gray-50 mt-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Chip tone="brand" value={conf.high} label="trusted" />
                            {conf.medium > 0 && <Chip tone="muted" value={conf.medium} label="medium" />}
                            {conf.low > 0 && <Chip tone="muted" value={conf.low} label="low confidence" />}
                            {topUps > 0 && <Chip tone="muted" value={topUps} label="top-ups" />}
                            {faults > 0 && <Chip tone="danger" value={faults} label="telemetry faults" />}
                        </div>

                        <details className="group mt-3">
                            <summary className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 cursor-pointer select-none list-none">
                                <ChevronRight className="w-3.5 h-3.5 transition-transform group-open:rotate-90" />
                                How these are graded
                            </summary>
                            <div className="mt-2 text-xs text-gray-400 leading-relaxed max-w-3xl space-y-1.5">
                                <p>
                                    Capacity = Total Ah ÷ (SOC difference ÷ 100). Every cycle gets one — none is
                                    withheld — but the division amplifies error by 100 ÷ SOC swing, so a small charge
                                    can be off by {Math.round(100 / minSoc)}× or more.
                                </p>
                                <p>
                                    An estimate is <strong>trusted</strong> (filled dot) only when the swing is ≥{' '}
                                    {minSoc}%, the cycle has ≥ {minSamples} samples, and ≥ {minCoverage}% of its
                                    duration was actually sampled. The line joins every cycle; the hollow dots are the
                                    ones whose evidence is thin, so a spike or dip through a run of them is far more
                                    likely to be the poller than the pack.
                                </p>
                                {faults > 0 && (
                                    <p>
                                        A <strong>telemetry fault</strong> is an estimate that contradicts the{' '}
                                        {rated} Ah nameplate — a broken reading on that cycle, not a degraded battery.
                                    </p>
                                )}
                            </div>
                        </details>
                    </div>
                </>
            ) : (
                <div className="h-56 flex flex-col items-center justify-center text-center px-8 pb-6">
                    <Gauge className="w-7 h-7 text-gray-200 mb-3" />
                    <p className="text-sm text-gray-500">No charging cycle in this period</p>
                    <p className="text-xs text-gray-400 mt-1 max-w-xs">
                        Try a wider period, or another battery.
                    </p>
                </div>
            )}
        </div>
    );
}
