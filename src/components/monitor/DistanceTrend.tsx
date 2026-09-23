"use client";

import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import {
    AXIS_LINE,
    ChartCard,
    TICK,
    TooltipShell,
    VIZ,
} from "@/components/intellicar/battery/charts/chart-kit";
import type { DistanceDay } from "@/lib/telemetry/monitor-queries";

function dayLabel(iso: string) {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * How many vehicles filed a distance reading on each of the last 14 days.
 *
 * This is the pipeline's pulse over time, where the tiles above are only its
 * pulse right now: a step down that never recovers is a poller that died on a
 * particular day, which no instantaneous count can show.
 *
 * Deliberately ONE line. Kilometres travelled would be the obvious second
 * series and it would need a second y-axis at a different scale — the surest way
 * to imply a relationship between two measures that is an artefact of where the
 * axes were pinned. Distance totals live in the tile beside this card instead,
 * and in this chart's tooltip.
 */
export function DistanceTrend({
    series,
    degraded,
}: {
    series: DistanceDay[];
    degraded?: boolean;
}) {
    const data = series.map((d) => ({ ...d, label: dayLabel(d.day) }));

    const empty = degraded
        ? "Telemetry database unreachable — nothing measured."
        : data.length === 0
          ? "No distance rollups in the last 14 days."
          : undefined;

    return (
        <ChartCard
            title="Vehicles reporting distance, last 14 days"
            subtitle="A sustained step down means the poller stopped, not that the fleet stopped moving."
            empty={empty}
            caveat={
                <p>
                    From <code className="font-mono">distance_rollup</code> at daily buckets, the
                    only distance source on the estate that is actually populated. It is written by
                    the poller rather than derived from GPS, so it is a lower bound.
                </p>
            }
        >
            <ResponsiveContainer width="100%" height={180}>
                <LineChart data={data} margin={{ top: 12, right: 20, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke={VIZ.grid} vertical={false} />
                    <XAxis
                        dataKey="label"
                        tick={TICK}
                        axisLine={AXIS_LINE}
                        tickLine={false}
                        interval="preserveStartEnd"
                        minTickGap={18}
                    />
                    <YAxis
                        allowDecimals={false}
                        tick={TICK}
                        axisLine={AXIS_LINE}
                        tickLine={false}
                        width={34}
                    />
                    <Tooltip
                        cursor={{ stroke: VIZ.axis, strokeWidth: 1 }}
                        content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const row = payload[0].payload as (typeof data)[number];
                            return (
                                <TooltipShell
                                    title={row.label}
                                    rows={[
                                        ["Vehicles reporting", String(row.vehicles)],
                                        ["Distance", `${row.km.toLocaleString()} km`],
                                    ]}
                                />
                            );
                        }}
                    />
                    <Line
                        type="monotone"
                        dataKey="vehicles"
                        name="Vehicles reporting"
                        stroke={VIZ.distance}
                        strokeWidth={2}
                        dot={{ r: 3, fill: VIZ.distance, strokeWidth: 0 }}
                        activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff" }}
                        isAnimationActive={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}
