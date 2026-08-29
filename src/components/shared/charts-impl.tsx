"use client";

import React from 'react';
import {
    LineChart,
    Line,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
    AreaChart,
    Area,
    ComposedChart,
    ReferenceLine
} from 'recharts';

/**
 * E-224 — let a series go below the axis.
 *
 * A derived series can be negative (the CEO chart plots realization =
 * revenue − expense, which is a loss in a bad month), but Recharts' default
 * numeric domain floors at 0. The loss gets clamped onto the axis, so a
 * ₹-4L month and a break-even month draw identically.
 *
 * `Math.min(0, dataMin)` rather than `'auto'` on the low end is deliberate:
 * with `'auto'` an all-positive chart lifts its baseline off zero, and bar
 * LENGTHS stop being proportional to their values — the classic way to make a
 * small difference look like a large one. Zero stays the floor until something
 * is genuinely below it.
 */
const NEGATIVE_AWARE_DOMAIN = [
    (dataMin: number) => Math.min(0, dataMin),
    'auto',
] as [(dataMin: number) => number, 'auto'];

/** Whether any plotted value is negative, i.e. whether a zero line is worth drawing. */
function hasNegativeValue(data: Record<string, unknown>[], dataKeys: string[]): boolean {
    return data.some((row) => dataKeys.some((key) => Number(row[key]) < 0));
}

export interface MetricsChartProps {
    title: string;
    data: Record<string, unknown>[];
    type?: 'line' | 'bar' | 'area' | 'composed';
    dataKeys: string[];
    categoryKey: string;
    height?: number;
    colors?: string[];
    /** Optional formatter for Y-axis ticks and tooltip values (e.g. ₹ lakhs). */
    valueFormatter?: (n: number) => string;
    /** Optional controls rendered on the right of the card header (filters, toggles). */
    headerActions?: React.ReactNode;
    /**
     * `type="composed"` only. Keys drawn as a line rather than a bar — the rest
     * of `dataKeys` stays a bar. Used for a derived series (E-219 plots revenue
     * and expense as bars with realization as the line tracing the gap).
     *
     * Every series shares ONE y-axis, so only put a key here when it is in the
     * same unit and scale as the bars. A second axis would let two unrelated
     * scales be drawn as if comparable.
     */
    lineKeys?: string[];
    /** Human labels for the legend and tooltip, keyed by data key. */
    seriesLabels?: Record<string, string>;
}

function ChartHeader({ title, headerActions }: { title: string; headerActions?: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-900 pt-1">{title}</h3>
            {headerActions ? <div className="flex items-center">{headerActions}</div> : null}
        </div>
    );
}

export function MetricsChart({
    title,
    data,
    type = 'area',
    dataKeys,
    categoryKey,
    height = 300,
    colors = ["#10b981", "#3b82f6", "#f59e0b", "#6366f1"],
    valueFormatter,
    headerActions,
    lineKeys,
    seriesLabels
}: MetricsChartProps) {
    // Colour is keyed to the series' position in `dataKeys`, which the caller
    // fixes — so hiding or reordering a series never repaints the others.
    const colorFor = (key: string) =>
        colors[Math.max(0, dataKeys.indexOf(key)) % colors.length];
    const labelFor = (key: string) => seriesLabels?.[key] ?? key;
    const tooltipFormatter = valueFormatter
        ? (value: number | string) => valueFormatter(Number(value))
        : undefined;
    const yTickFormatter = valueFormatter
        ? (value: number) => valueFormatter(Number(value))
        : undefined;
    // Only drawn when something actually crosses. The axis line itself is
    // hidden (axisLine={false}), so without this a negative series would dip
    // below a boundary the reader cannot see.
    const showZeroLine = Array.isArray(data) && hasNegativeValue(data, dataKeys);
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) {
        return (
            <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm h-full flex flex-col">
                <ChartHeader title={title} headerActions={headerActions} />
                <div className="flex-1" style={{ width: '100%', minHeight: height || 300, height: height || 300 }} />
            </div>
        );
    }

    if (!Array.isArray(data) || data.length === 0) {
        return (
            <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm h-full flex flex-col">
                <ChartHeader title={title} headerActions={headerActions} />
                <div
                    className="flex-1 flex items-center justify-center text-sm text-gray-400"
                    style={{ minHeight: height || 300 }}
                >
                    No data to display for this period.
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm h-full flex flex-col">
            <ChartHeader title={title} headerActions={headerActions} />
            <div className="flex-1" style={{ width: '100%', minHeight: height || 300, height: height || 300, minWidth: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                    {type === 'area' ? (
                        <AreaChart data={data}>
                            <defs>
                                {dataKeys.map((key, i) => (
                                    <linearGradient key={key} id={`color_${key}`} x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor={colors[i % colors.length]} stopOpacity={0.1} />
                                        <stop offset="95%" stopColor={colors[i % colors.length]} stopOpacity={0} />
                                    </linearGradient>
                                ))}
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                            <XAxis
                                dataKey={categoryKey}
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 12, fill: '#94a3b8' }}
                                dy={10}
                            />
                            <YAxis
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 12, fill: '#94a3b8' }}
                                tickFormatter={yTickFormatter}
                                domain={NEGATIVE_AWARE_DOMAIN}
                            />
                            <Tooltip
                                formatter={tooltipFormatter}
                                contentStyle={{
                                    borderRadius: '12px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                                }}
                            />
                            {showZeroLine && <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />}
                            {dataKeys.map((key, i) => (
                                <Area
                                    key={key}
                                    type="monotone"
                                    dataKey={key}
                                    stroke={colors[i % colors.length]}
                                    fillOpacity={1}
                                    fill={`url(#color_${key})`}
                                    strokeWidth={2}
                                />
                            ))}
                        </AreaChart>
                    ) : type === 'composed' ? (
                        // Bars and a line on ONE shared axis. Recharts would
                        // happily take a second <YAxis yAxisId>, but two scales
                        // drawn as one picture is the classic way to make
                        // unrelated series look correlated — so there is only
                        // ever the one axis here.
                        <ComposedChart data={data} barGap={2}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                            <XAxis
                                dataKey={categoryKey}
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 12, fill: '#94a3b8' }}
                                dy={10}
                            />
                            <YAxis
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 12, fill: '#94a3b8' }}
                                tickFormatter={yTickFormatter}
                                domain={NEGATIVE_AWARE_DOMAIN}
                            />
                            <Tooltip
                                cursor={{ fill: '#f8fafc' }}
                                formatter={tooltipFormatter}
                                contentStyle={{
                                    borderRadius: '12px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                                }}
                            />
                            {showZeroLine && <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />}
                            {/* Named series, so identity is never carried by
                                colour alone — which also covers the fills
                                sitting under 3:1 against the card surface. */}
                            <Legend
                                verticalAlign="top"
                                align="right"
                                iconType="circle"
                                iconSize={8}
                                wrapperStyle={{ fontSize: 12, color: '#64748b', paddingBottom: 12 }}
                            />
                            {dataKeys
                                .filter((key) => !lineKeys?.includes(key))
                                .map((key) => (
                                    <Bar
                                        key={key}
                                        dataKey={key}
                                        name={labelFor(key)}
                                        fill={colorFor(key)}
                                        radius={[4, 4, 0, 0]}
                                    />
                                ))}
                            {(lineKeys ?? []).map((key) => (
                                <Line
                                    key={key}
                                    type="monotone"
                                    dataKey={key}
                                    name={labelFor(key)}
                                    stroke={colorFor(key)}
                                    strokeWidth={2}
                                    dot={{ r: 4, fill: colorFor(key), strokeWidth: 2, stroke: '#fff' }}
                                    activeDot={{ r: 6, strokeWidth: 0 }}
                                />
                            ))}
                        </ComposedChart>
                    ) : type === 'bar' ? (
                        <BarChart data={data}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                            <XAxis
                                dataKey={categoryKey}
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 12, fill: '#94a3b8' }}
                                dy={10}
                            />
                            <YAxis
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 12, fill: '#94a3b8' }}
                                tickFormatter={yTickFormatter}
                                domain={NEGATIVE_AWARE_DOMAIN}
                            />
                            <Tooltip
                                cursor={{ fill: '#f8fafc' }}
                                formatter={tooltipFormatter}
                                contentStyle={{
                                    borderRadius: '12px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                                }}
                            />
                            {showZeroLine && <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />}
                            {dataKeys.map((key, i) => (
                                <Bar
                                    key={key}
                                    dataKey={key}
                                    fill={colors[i % colors.length]}
                                    radius={[4, 4, 0, 0]}
                                    barSize={dataKeys.length > 1 ? undefined : 32}
                                />
                            ))}
                        </BarChart>
                    ) : (
                        <LineChart data={data}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                            <XAxis
                                dataKey={categoryKey}
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 12, fill: '#94a3b8' }}
                                dy={10}
                            />
                            <YAxis
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 12, fill: '#94a3b8' }}
                                tickFormatter={yTickFormatter}
                                domain={NEGATIVE_AWARE_DOMAIN}
                            />
                            <Tooltip
                                formatter={tooltipFormatter}
                                contentStyle={{
                                    borderRadius: '12px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                                }}
                            />
                            {showZeroLine && <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />}
                            {dataKeys.map((key, i) => (
                                <Line
                                    key={key}
                                    type="monotone"
                                    dataKey={key}
                                    stroke={colors[i % colors.length]}
                                    strokeWidth={2}
                                    dot={{ r: 4, fill: colors[i % colors.length], strokeWidth: 2, stroke: '#fff' }}
                                    activeDot={{ r: 6, strokeWidth: 0 }}
                                />
                            ))}
                        </LineChart>
                    )}
                </ResponsiveContainer>
            </div>
        </div>
    );
}
