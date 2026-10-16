import { describe, expect, it } from "vitest";

import { buildChart, isTimeAxis } from "../chart";
import { questionTopics, withMetricRules } from "../metricRules";
import type { ResultTable } from "../run-types";

// A35 — a trend question gets a line chart, not bars.

const table = (columns: string[], rows: ResultTable["rows"]): ResultTable => ({ columns, rows, truncated: false });

describe("time axis → line chart (A35)", () => {
    it("recognises dates, months, weeks, quarters and years", () => {
        expect(isTimeAxis(["2026-07", "2026-08", "2026-09"])).toBe(true);
        expect(isTimeAxis(["2026-10-01", "2026-10-02", "2026-10-03"])).toBe(true);
        expect(isTimeAxis(["Jul 2026", "Aug 2026", "Sep 2026"])).toBe(true);
        expect(isTimeAxis(["July", "August", "September"])).toBe(true);
        expect(isTimeAxis(["2026-W40", "2026-W41", "2026-W42"])).toBe(true);
        expect(isTimeAxis(["2026-Q1", "2026-Q2", "2026-Q3"])).toBe(true);
        expect(isTimeAxis(["2024", "2025", "2026"])).toBe(true);
        expect(isTimeAxis(["01 Oct", "02 Oct", "03 Oct"])).toBe(true);
    });

    it("leaves categories and short runs alone", () => {
        expect(isTimeAxis(["Pioneer", "Shakti", "Ayansh"])).toBe(false);
        expect(isTimeAxis(["4850", "5120", "6000"])).toBe(false); // model numbers, not years
        expect(isTimeAxis(["2026-08", "2026-09"])).toBe(false); // two points: a comparison, not a trend
        expect(isTimeAxis(["2026-08", "Pune", "2026-09"])).toBe(false);
    });

    it("a bar chart over months is drawn as a line; a bar chart over dealers stays bars", () => {
        const months = buildChart(
            { type: "bar", x: "month", y: ["revenue"] },
            table(["month", "revenue"], [["2026-07", 10], ["2026-08", 12], ["2026-09", 9]]),
        );
        expect(months.kind === "chart" && months.type).toBe("line");
        const dealers = buildChart(
            { type: "bar", x: "dealer", y: ["revenue"] },
            table(["dealer", "revenue"], [["A", 1], ["B", 2], ["C", 3]]),
        );
        expect(dealers.kind === "chart" && dealers.type).toBe("bar");
    });
});

describe("trend questions carry the line-chart and 2-month forecast rule (A35)", () => {
    it("a trend or forecast question is on the trend topic and gets the rule", () => {
        expect(questionTopics("revenue trend month on month")).toContain("trend");
        expect(questionTopics("forecast batteries sold")).toContain("trend");
        const sent = withMetricRules("Show revenue month-wise and forecast the next months");
        expect(sent).toMatch(/line chart, never bars/);
        expect(sent).toMatch(/next 2 months/);
    });

    it("a plain ranking question does not get it", () => {
        expect(questionTopics("top 5 dealers by revenue")).not.toContain("trend");
    });
});
