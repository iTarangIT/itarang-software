"use client";

// B7 row 2 — visits per period as a line chart (total, fresh, repeat, new to
// iTarang — ID 185: Fresh + Repeat = total, the Field card's own split) on
// the shared MetricsChart, the three per-day averages as small text beneath,
// and calls as a SEPARATE bar chart. Calls run 10–30× visits on real data, so
// one axis would flatten the visit lines to the baseline, and MetricsChart
// deliberately has no second y-axis.
//
// Colours are fixed per series (visits / unique / new) and were validated for
// colour-vision separation; the calls chart has one series, so no legend.

import { MetricsChart } from "@/components/shared/charts";
import type { SalesAverages, SalesDashboardGranularity, SalesSeriesRow } from "@/lib/admin/salesDashboardTypes";
import { freshRepeatSplit } from "@/lib/visits/freshRepeat";

export const VISIT_SERIES_COLORS = ["#2e68b2", "#0f766e", "#ea580c", "#7c3aed"];
const CALLS_COLOR = ["#2e68b2"];

export function bucketLabel(iso: string, g: SalesDashboardGranularity): string {
    const d = new Date(`${iso}T00:00:00Z`);
    if (g === "month") {
        return d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
    }
    const day = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
    return g === "week" ? `w/c ${day}` : day;
}

export function SalesCharts({
    series,
    averages,
    granularity,
}: {
    series: SalesSeriesRow[];
    averages: SalesAverages;
    granularity: SalesDashboardGranularity;
}) {
    const data = series.map((r) => ({
        label: bucketLabel(r.bucket, granularity),
        visits: r.visits,
        fresh_visits: freshRepeatSplit(r).fresh,
        repeat_visits: freshRepeatSplit(r).repeat,
        unique_visits: r.unique_visits,
        new_visits: r.new_visits,
        calls: r.calls,
    }));
    return (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
                <MetricsChart
                    title={`Visits per ${granularity}`}
                    type="line"
                    data={data}
                    categoryKey="label"
                    dataKeys={["visits", "fresh_visits", "repeat_visits", "new_visits"]}
                    seriesLabels={{
                        visits: "Total visits",
                        fresh_visits: "Fresh (person's first visit)",
                        repeat_visits: "Repeat",
                        new_visits: "New to iTarang",
                    }}
                    colors={VISIT_SERIES_COLORS}
                    height={280}
                />
                <p className="mt-2 px-1 text-xs text-ink-muted">
                    Averages per day over {averages.days_in_range} days:{" "}
                    <span className="font-medium text-ink">{averages.avg_visits_per_day}</span> visits ·{" "}
                    <span className="font-medium text-ink">{averages.avg_fresh_per_day ?? 0}</span> fresh ·{" "}
                    <span className="font-medium text-ink">
                        {Math.max(0, Math.round(((averages.avg_visits_per_day ?? 0) - (averages.avg_fresh_per_day ?? 0)) * 100) / 100)}
                    </span>{" "}
                    repeat ·{" "}
                    <span className="font-medium text-ink">{averages.avg_unique_per_day}</span> unique dealers ·{" "}
                    <span className="font-medium text-ink">{averages.avg_new_per_day}</span> new to iTarang ·{" "}
                    <span className="font-medium text-ink">{averages.avg_calls_per_day}</span> calls
                </p>
            </div>
            <div>
                <MetricsChart
                    title={`Calls per ${granularity}`}
                    type="bar"
                    data={data}
                    categoryKey="label"
                    dataKeys={["calls"]}
                    seriesLabels={{ calls: "Calls" }}
                    colors={CALLS_COLOR}
                    height={280}
                />
            </div>
        </div>
    );
}
