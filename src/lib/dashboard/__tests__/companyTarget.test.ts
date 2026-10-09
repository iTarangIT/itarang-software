import { describe, expect, it } from "vitest";

import { summariseCompanyTargets, targetVerdict } from "../companyTarget";

const row = (metric: string, monthly: number, mtd: number) => ({
    metric,
    progress: { monthly_target: monthly, mtd_target: mtd },
});

describe("summariseCompanyTargets", () => {
    it("sums people, uses to-date for the current month and full for past months", () => {
        const t = summariseCompanyTargets(
            [
                { month: "2026-09", rows: [row("revenue", 100, 100), row("revenue", 50, 50)] },
                { month: "2026-10", rows: [row("revenue", 300, 90), row("batteries_sold", 32, 9)] },
            ],
            ["2026-09", "2026-10"],
            "2026-10",
        );
        expect(t.revenue).toEqual({ sum: 240, missing: [] });
        expect(t.batteries_sold).toEqual({ sum: 9, missing: ["2026-09"] });
    });

    it("treats a zero monthly target as no target", () => {
        const t = summariseCompanyTargets([{ month: "2026-09", rows: [row("revenue", 0, 0)] }], ["2026-09"], "2026-10");
        expect(t.revenue).toEqual({ sum: 0, missing: ["2026-09"] });
    });

    it("does not call the current month missing on the 1st (to-date target 0)", () => {
        const t = summariseCompanyTargets([{ month: "2026-10", rows: [row("revenue", 300, 0)] }], ["2026-10"], "2026-10");
        expect(t.revenue).toEqual({ sum: 0, missing: [] });
    });

    it("ignores other metrics", () => {
        const t = summariseCompanyTargets([{ month: "2026-10", rows: [row("dealer_visits", 40, 10)] }], ["2026-10"], "2026-10");
        expect(t.revenue.missing).toEqual(["2026-10"]);
    });
});

describe("targetVerdict", () => {
    const fy = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];

    it("the reported bug: FY revenue against October-only target is partial, not 20,766 %", () => {
        const v = targetVerdict({ sum: 139_000, missing: fy.slice(0, 6) }, 28_900_000, fy, "2026-10");
        expect(v).toEqual({ kind: "partial", goal: 139_000, covered: ["2026-10"], includesThisMonth: true });
    });

    it("gives a % when every month has a target", () => {
        expect(targetVerdict({ sum: 139_000, missing: [] }, 123_710, ["2026-10"], "2026-10")).toEqual({
            kind: "set",
            goal: 139_000,
            pct: 89,
        });
    });

    it("no target when nothing is set", () => {
        expect(targetVerdict({ sum: 0, missing: ["2026-10"] }, 5, ["2026-10"], "2026-10")).toEqual({ kind: "none" });
        expect(targetVerdict(undefined, 5, ["2026-10"], "2026-10")).toEqual({ kind: "none" });
    });

    it("target set but actual still loading → no %", () => {
        expect(targetVerdict({ sum: 10, missing: [] }, null, ["2026-10"], "2026-10")).toEqual({ kind: "set", goal: 10, pct: null });
    });
});
