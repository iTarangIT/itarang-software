"use client";

import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    LabelList,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import {
    AXIS_LINE,
    ChartCard,
    Headline,
    TICK,
    TooltipShell,
    VIZ,
} from "@/components/intellicar/battery/charts/chart-kit";
import { SOC_BANDS, type SocBand } from "@/lib/telemetry/monitor-math";

const LOW = "0-20";

/**
 * Fleet state of charge, as a distribution rather than an average.
 *
 * An average hides the shape: a fleet sitting at 55% mean could be every pack
 * near half, or half the packs full and half of them flat. Only the second needs
 * a van, and only the distribution shows the difference.
 *
 * One measure, so no legend — the title names it. The critical bin is the single
 * exception to one-hue: it is a status highlight, and it carries a direct label
 * and a headline count so the meaning never rests on the colour alone.
 */
export function SocDistribution({
    buckets,
    below20,
    withReading,
    avg,
    fleetSize,
    degraded,
}: {
    buckets: Record<SocBand, number>;
    below20: number;
    withReading: number;
    avg: number | null;
    fleetSize: number;
    degraded?: boolean;
}) {
    const data = SOC_BANDS.map((band) => ({
        band: `${band}%`,
        raw: band,
        vehicles: buckets[band],
    }));

    const missing = fleetSize - withReading;

    return (
        <ChartCard
            title="State of charge"
            subtitle="Vehicles per charge band, from the latest reading on each pack."
            headline={
                degraded ? undefined : (
                    <Headline
                        value={below20}
                        unit={below20 === 1 ? "pack" : "packs"}
                        sub="below 20%"
                    />
                )
            }
            empty={degraded ? "Telemetry database unreachable — nothing measured." : undefined}
            caveat={
                <p>
                    {withReading} of {fleetSize} vehicles reported a charge level
                    {missing > 0 && (
                        <>
                            {" "}
                            — the other {missing} are counted nowhere on this chart. A missing
                            reading is a silent sensor, not a flat pack, so it is never folded into
                            the 0&ndash;20% bar.
                        </>
                    )}
                    {avg !== null && <> Fleet mean {avg}%.</>}
                </p>
            }
        >
            <ResponsiveContainer width="100%" height={230}>
                <BarChart data={data} margin={{ top: 22, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke={VIZ.grid} vertical={false} />
                    <XAxis dataKey="band" tick={TICK} axisLine={AXIS_LINE} tickLine={false} />
                    <YAxis
                        allowDecimals={false}
                        tick={TICK}
                        axisLine={AXIS_LINE}
                        tickLine={false}
                        width={34}
                    />
                    <Tooltip
                        cursor={{ fill: VIZ.grid }}
                        content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const v = Number(payload[0].value) || 0;
                            return (
                                <TooltipShell
                                    title={`${label} charge`}
                                    rows={[
                                        ["Vehicles", String(v)],
                                        [
                                            "Of those reporting",
                                            withReading ? `${Math.round((v / withReading) * 100)}%` : "—",
                                        ],
                                    ]}
                                />
                            );
                        }}
                    />
                    <Bar dataKey="vehicles" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {data.map((d) => (
                            <Cell
                                key={d.raw}
                                fill={d.raw === LOW ? VIZ.criticalLine : VIZ.soc}
                            />
                        ))}
                        <LabelList
                            dataKey="vehicles"
                            position="top"
                            className="fill-gray-400"
                            fontSize={10}
                            formatter={(v) => (Number(v) > 0 ? String(v) : "")}
                        />
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </ChartCard>
    );
}
