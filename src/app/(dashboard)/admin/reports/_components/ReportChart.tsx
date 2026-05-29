"use client";

// Per-report-type recharts visualization (BRD §0.11). Brand-palette colours,
// rendered above the data table on /admin/reports.

import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { ReportResult, ReportRow } from "@/lib/admin/types";

const ROYAL = "#2e68b2";
const SKY = "#138fc6";
const SUCCESS = "#1e7e34";
const DANGER = "#c0392b";
const WARNING = "#b45309";

const GRID = "#e3e8ef";
const tick = { fontSize: 11, fill: "#5a6877" };
const tooltipStyle = {
    borderRadius: 10,
    border: "1px solid #e3e8ef",
    boxShadow: "0 12px 40px -12px rgba(2,49,78,0.18)",
    fontSize: 12,
};

const n = (v: unknown) => Number(v ?? 0);

export function ReportChart({ result }: { result: ReportResult }) {
    if (result.rows.length === 0) return null;

    return (
        <div className="h-72 w-full px-2 pt-4">
            <ResponsiveContainer width="100%" height="100%">
                {renderChart(result)}
            </ResponsiveContainer>
        </div>
    );
}

function renderChart(result: ReportResult): React.ReactElement {
    const rows = result.rows;

    switch (result.type) {
        case "daily_activity": {
            // Aggregate per-rep rows into a daily total, oldest → newest.
            const byDay = new Map<string, { touchpoints: number; connected: number }>();
            for (const r of rows) {
                const d = String(r.day);
                const cur = byDay.get(d) ?? { touchpoints: 0, connected: 0 };
                cur.touchpoints += n(r.total_touchpoints);
                cur.connected += n(r.connected_calls);
                byDay.set(d, cur);
            }
            const data = [...byDay.entries()]
                .map(([day, v]) => ({ day, ...v }))
                .sort((a, b) => a.day.localeCompare(b.day));
            return (
                <LineChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: -8 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="day" tick={tick} stroke={GRID} />
                    <YAxis tick={tick} stroke={GRID} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                        type="monotone"
                        dataKey="touchpoints"
                        name="Touchpoints"
                        stroke={ROYAL}
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                    />
                    <Line
                        type="monotone"
                        dataKey="connected"
                        name="Connected calls"
                        stroke={SKY}
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                    />
                </LineChart>
            );
        }

        case "lead_funnel":
            return (
                <BarChart
                    layout="vertical"
                    data={rows}
                    margin={{ top: 4, right: 24, bottom: 4, left: 40 }}
                >
                    <CartesianGrid stroke={GRID} horizontal={false} />
                    <XAxis type="number" tick={tick} stroke={GRID} allowDecimals={false} />
                    <YAxis
                        type="category"
                        dataKey="stage"
                        tick={tick}
                        stroke={GRID}
                        width={150}
                    />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f4f7fa" }} />
                    <Bar dataKey="count" name="Leads" fill={ROYAL} radius={[0, 4, 4, 0]} />
                </BarChart>
            );

        case "lost_analysis": {
            const data = rows.filter((r) => n(r.count) > 0);
            return (
                <BarChart
                    layout="vertical"
                    data={data}
                    margin={{ top: 4, right: 24, bottom: 4, left: 60 }}
                >
                    <CartesianGrid stroke={GRID} horizontal={false} />
                    <XAxis type="number" tick={tick} stroke={GRID} allowDecimals={false} />
                    <YAxis
                        type="category"
                        dataKey="reason"
                        tick={tick}
                        stroke={GRID}
                        width={160}
                    />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f4f7fa" }} />
                    <Bar dataKey="count" name="Count" radius={[0, 4, 4, 0]}>
                        {data.map((r: ReportRow, i) => (
                            <Cell
                                key={i}
                                fill={
                                    r.category === "Onboarding dropout"
                                        ? WARNING
                                        : DANGER
                                }
                            />
                        ))}
                    </Bar>
                </BarChart>
            );
        }

        case "ai_score_accuracy":
            return (
                <BarChart data={rows} margin={{ top: 4, right: 16, bottom: 4, left: -8 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="bucket" tick={tick} stroke={GRID} />
                    <YAxis tick={tick} stroke={GRID} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f4f7fa" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="converted" name="Converted" fill={SUCCESS} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="lost" name="Lost" fill={DANGER} radius={[4, 4, 0, 0]} />
                </BarChart>
            );

        case "source_performance":
            return (
                <BarChart data={rows} margin={{ top: 4, right: 16, bottom: 4, left: -8 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="source" tick={tick} stroke={GRID} />
                    <YAxis tick={tick} stroke={GRID} unit="%" />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f4f7fa" }} />
                    <Bar
                        dataKey="conversion_rate"
                        name="Conversion %"
                        fill={SKY}
                        radius={[4, 4, 0, 0]}
                    />
                </BarChart>
            );

        case "asm_handoff":
            return (
                <BarChart data={rows} margin={{ top: 4, right: 16, bottom: 4, left: -8 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="asm_name" tick={tick} stroke={GRID} />
                    <YAxis tick={tick} stroke={GRID} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f4f7fa" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="handoffs" name="Handoffs" fill={ROYAL} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="converted" name="Converted" fill={SUCCESS} radius={[4, 4, 0, 0]} />
                </BarChart>
            );
    }
}
