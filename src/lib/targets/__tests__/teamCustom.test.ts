import { describe, expect, it } from "vitest";

import { customMetricKey, customTeamTotal, customUnitNotSummable, type CustomEntry } from "../teamCustom";

const e = (user_id: string, label: string, unit: string | null, manual_actual: number | null, user_name = user_id): CustomEntry => ({
    user_id,
    user_name,
    label,
    unit,
    manual_actual,
});

describe("ID 189 — team total of a custom metric", () => {
    it("matches the same metric by name + unit, ignoring case and spacing", () => {
        expect(customMetricKey("  Fleet  Demos ", "Demos")).toBe(customMetricKey("fleet demos", " demos"));
        expect(customMetricKey("Fleet demos", "demos")).not.toBe(customMetricKey("Fleet demos", "km"));
    });

    it("adds the manager's and each member's hand-entered progress", () => {
        const r = customTeamTotal({
            managerId: "m",
            label: "Fleet demos",
            unit: "demos",
            entries: [e("m", "Fleet demos", "demos", 3), e("a", "fleet demos", "Demos", 4.25), e("b", "Fleet demos", "demos", 2)],
            teamIds: ["m", "a", "b"],
        });
        expect(r).toEqual({ value: 9.3, reason: null });
    });

    it("a member without that metric adds nothing; other metrics and outsiders are ignored", () => {
        const r = customTeamTotal({
            managerId: "m",
            label: "Fleet demos",
            unit: null,
            entries: [e("m", "Fleet demos", null, 5), e("a", "Something else", null, 99), e("x", "Fleet demos", null, 50)],
            teamIds: new Set(["m", "a", "b"]),
        });
        expect(r).toEqual({ value: 5, reason: null });
    });

    it("money units add up", () => {
        expect(customUnitNotSummable("₹")).toBeNull();
        expect(customUnitNotSummable("units")).toBeNull();
        expect(customUnitNotSummable(null)).toBeNull();
    });

    it("someone who carries it but has not entered it: no total, and the reason names them", () => {
        const r = customTeamTotal({
            managerId: "m",
            label: "Fleet demos",
            unit: null,
            entries: [e("m", "Fleet demos", null, null), e("a", "Fleet demos", null, 4, "Asha"), e("b", "Fleet demos", null, null, "Bilal")],
            teamIds: ["m", "a", "b"],
        });
        expect(r.value).toBeNull();
        expect(r.reason).toMatch(/Not entered yet by you, Bilal/);
        expect(r.reason).not.toMatch(/not measured/i);
    });

    it("a rate or a share cannot be added across people — says why", () => {
        for (const unit of ["%", "percent", "per day", "km/day", "avg", "Rating", "score"]) {
            const r = customTeamTotal({
                managerId: "m",
                label: "Conversion",
                unit,
                entries: [e("m", "Conversion", unit, 40), e("a", "Conversion", unit, 60)],
                teamIds: ["m", "a"],
            });
            expect(r.value).toBeNull();
            expect(r.reason).toMatch(/cannot be added into one team total/);
        }
    });
});
