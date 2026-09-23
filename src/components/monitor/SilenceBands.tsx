"use client";

import {
    Bar,
    BarChart,
    CartesianGrid,
    LabelList,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import { AXIS_LINE, ChartCard, Legend, TICK, TooltipShell, VIZ } from "@/components/intellicar/battery/charts/chart-kit";
import { SILENCE_BANDS, SILENCE_BAND_LABELS, type SilenceBand } from "@/lib/telemetry/monitor-math";

const SERIES = [
    { key: "battery" as const, label: "Battery", color: VIZ.charged },
    { key: "gps" as const, label: "GPS", color: VIZ.discharged },
];

type Row = { band: string; battery: number; gps: number };

/**
 * How long each channel has been quiet, as a count of vehicles per band.
 *
 * The bands are ORDERED, so the order is carried by axis position rather than by
 * a five-step colour ramp — position is the stronger encoding for ordered data,
 * and it leaves colour free to do the one job it is good at here: telling the
 * two channels apart. Two hues also means the palette passes CVD separation with
 * room to spare, which a five-step amber-to-red ramp does not.
 *
 * Battery and GPS are shown separately because they fail separately: a device
 * can hold its GPS fix while the BMS link drops, and a single merged "last seen"
 * number hides exactly that.
 */
export function SilenceBands({
    silence,
    fleetSize,
    degraded,
}: {
    silence: Record<"battery" | "gps", Record<SilenceBand, number>>;
    fleetSize: number;
    degraded?: boolean;
}) {
    const data: Row[] = SILENCE_BANDS.map((band) => ({
        band: SILENCE_BAND_LABELS[band],
        battery: silence.battery[band],
        gps: silence.gps[band],
    }));

    return (
        <ChartCard
            title="Time since last signal"
            subtitle="Vehicles by how long each channel has been quiet. Battery and GPS fail independently."
            empty={degraded ? "Telemetry database unreachable — nothing measured." : undefined}
            caveat={
                <p>
                    Measured from <code className="font-mono">last_battery_at</code> and{" "}
                    <code className="font-mono">last_gps_at</code>, not{" "}
                    <code className="font-mono">last_seen</code> — that column is stamped every poll
                    cycle whether or not the device answered, so it reads under an hour old for
                    every vehicle including ones silent for months. &ldquo;Never&rdquo; means the
                    channel has no reading at all, usually a device that was never installed.
                </p>
            }
        >
            <Legend items={SERIES.map((s) => ({ color: s.color, label: s.label }))} />
            <ResponsiveContainer width="100%" height={230}>
                <BarChart
                    data={data}
                    layout="vertical"
                    margin={{ top: 8, right: 44, bottom: 4, left: 8 }}
                    barGap={2}
                >
                    <CartesianGrid stroke={VIZ.grid} horizontal={false} />
                    <XAxis
                        type="number"
                        allowDecimals={false}
                        domain={[0, Math.max(1, fleetSize)]}
                        tick={TICK}
                        axisLine={AXIS_LINE}
                        tickLine={false}
                    />
                    <YAxis
                        type="category"
                        dataKey="band"
                        width={58}
                        tick={TICK}
                        axisLine={AXIS_LINE}
                        tickLine={false}
                    />
                    <Tooltip
                        cursor={{ fill: VIZ.grid }}
                        content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            return (
                                <TooltipShell
                                    title={String(label)}
                                    sub={`of ${fleetSize}`}
                                    rows={payload.map((p) => [
                                        String(p.name),
                                        `${p.value} vehicles`,
                                    ])}
                                />
                            );
                        }}
                    />
                    {SERIES.map((s) => (
                        <Bar
                            key={s.key}
                            dataKey={s.key}
                            name={s.label}
                            fill={s.color}
                            radius={[0, 4, 4, 0]}
                            barSize={11}
                            isAnimationActive={false}
                        >
                            {/* Direct labels: with only two series the value belongs on the
                                mark, so the chart reads without crossing to a legend. */}
                            <LabelList
                                dataKey={s.key}
                                position="right"
                                className="fill-gray-400"
                                fontSize={10}
                                formatter={(v) => (Number(v) > 0 ? String(v) : "")}
                            />
                        </Bar>
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}
