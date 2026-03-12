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
    ResponsiveContainer,
    AreaChart,
    Area
} from 'recharts';

interface MetricsChartProps {
    title: string;
    data: Record<string, unknown>[];
    type?: 'line' | 'bar' | 'area';
    dataKeys: string[];
    categoryKey: string;
    height?: number;
    colors?: string[];
}

export function MetricsChart({
    title,
    data,
    type = 'area',
    dataKeys,
    categoryKey,
    height = 300,
    colors = ["#10b981", "#3b82f6", "#f59e0b", "#6366f1"]
}: MetricsChartProps) {
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) {
        return (
            <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm h-full flex flex-col">
                <h3 className="text-sm font-semibold text-gray-900 mb-6">{title}</h3>
                <div className="flex-1" style={{ width: '100%', minHeight: height || 300, height: height || 300 }} />
            </div>
        );
    }

    return (
        <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm h-full flex flex-col">
            <h3 className="text-sm font-semibold text-gray-900 mb-6">{title}</h3>
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
                            />
                            <Tooltip
                                contentStyle={{
                                    borderRadius: '12px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                                }}
                            />
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
                            />
                            <Tooltip
                                cursor={{ fill: '#f8fafc' }}
                                contentStyle={{
                                    borderRadius: '12px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                                }}
                            />
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
                            />
                            <Tooltip
                                contentStyle={{
                                    borderRadius: '12px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                                }}
                            />
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
