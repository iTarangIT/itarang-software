import { describe, expect, it } from "vitest";
import { barWidth, checkRows, pct, periodLabel, rate1, stepBase } from "../analysesShared";

const row = { leads_in: 200, not_with_sales: 80, assigned: 120, called: 90, quote_sent: 30, won: 12, converted: 9 };

describe("pct / rate1", () => {
    it("shows whole numbers from 10% and one decimal below", () => {
        expect(pct(50, 200)).toBe("25%");
        expect(pct(9, 200)).toBe("4.5%");
        expect(rate1(9, 200)).toBe("4.5%");
        expect(rate1(50, 200)).toBe("25.0%");
    });
    it("never divides by zero", () => {
        expect(pct(0, 0)).toBe("—");
        expect(rate1(3, 0)).toBe("—");
    });
});

describe("stepBase", () => {
    it("share mode is always Leads in", () => {
        expect(stepBase(row, "converted", "share")).toBe(200);
    });
    it("step mode divides by the step before; the first split is of Leads in", () => {
        expect(stepBase(row, "not_with_sales", "step")).toBe(200);
        expect(stepBase(row, "assigned", "step")).toBe(200);
        expect(stepBase(row, "called", "step")).toBe(120);
        expect(stepBase(row, "quote_sent", "step")).toBe(90);
        expect(stepBase(row, "won", "step")).toBe(30);
        expect(stepBase(row, "converted", "step")).toBe(12);
    });
});

describe("barWidth", () => {
    it("scales to the best rate with a 2% floor, 0 for nothing", () => {
        expect(barWidth(0.05, 0.1)).toBe(50);
        expect(barWidth(0.0001, 0.1)).toBe(2);
        expect(barWidth(0, 0.1)).toBe(0);
        expect(barWidth(0.1, 0)).toBe(0);
    });
});

describe("checkRows", () => {
    it("holds when every row passes", () => {
        expect(checkRows("sum", [{ a: 1 }], (r) => r.a === 1, () => "x")).toEqual({ label: "sum", holds: true, detail: "" });
    });
    it("names the first three broken rows and counts the rest", () => {
        const rows = ["A", "B", "C", "D", "E"].map((name) => ({ name }));
        const c = checkRows("sum", rows, () => false, (r) => r.name);
        expect(c.holds).toBe(false);
        expect(c.detail).toBe("Breaks on A, B, C and 2 more.");
    });
});

describe("periodLabel", () => {
    it("shortens within a month and spells both ends across months and years", () => {
        expect(periodLabel({ from: "2026-09-01", to: "2026-09-26" })).toBe("1 – 26 Sep 2026");
        expect(periodLabel({ from: "2026-07-01", to: "2026-09-26" })).toBe("1 Jul – 26 Sep 2026");
        expect(periodLabel({ from: "2025-12-20", to: "2026-01-05" })).toBe("20 Dec 2025 – 5 Jan 2026");
    });
});
