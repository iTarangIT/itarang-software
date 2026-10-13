import { describe, expect, it } from "vitest";

import { batteryText, countWithShare, hoursText, share } from "@/lib/dashboard/salesHeadMeasureFormat";

// Tracker ID 88 — how the Sales dashboard words the measures that used to read
// "not tracked yet", and the batteries estimate when invoice lines are missing.

describe("ID 88 — shares and hours", () => {
    it("share is a whole percent, null with nothing to divide by", () => {
        expect(share(1, 3)).toBe(33);
        expect(share(2, 3)).toBe(67);
        expect(share(0, 0)).toBeNull();
    });
    it("countWithShare drops the share when there is none", () => {
        expect(countWithShare(12, 40)).toBe("12 · 40%");
        expect(countWithShare(0, null)).toBe("0");
    });
    it("hours read one decimal, or a dash when not measured", () => {
        expect(hoursText(3.25)).toBe("3.3 h");
        expect(hoursText(null)).toBe("—");
    });
});

describe("ID 88 #4 — batteries when invoice lines are missing", () => {
    const unknown = { state: "unknown" as const, invoices: 4 };
    const partial = { state: "partial" as const, invoices: 4 };
    const complete = { state: "complete" as const, invoices: 4 };

    it("no lines at all: the approved-quote estimate, marked ≈ — never a bare 0", () => {
        const t = batteryText(unknown, "", { units: 6, leads: 2 });
        expect(t.actual).toBe("≈ 6");
        expect(t.estimated).toBe(true);
        expect(t.note).toContain("estimate from 2 approved quotes");
    });
    it("no lines and no estimate: a dash with the reason", () => {
        const t = batteryText(unknown, "", null);
        expect(t.actual).toBe("—");
        expect(t.note).toContain("4 invoices have no item lines");
        expect(batteryText(unknown, "", { units: 0, leads: 1 }).actual).toBe("—");
    });
    it("some lines: the invoice count stays, the estimate sits beside it", () => {
        expect(batteryText(partial, "5", { units: 3, leads: 1 }).actual).toBe("5 + ≈ 3");
        expect(batteryText(partial, "5", null).actual).toBe("5+");
    });
    it("every invoice has lines: the invoice count as is, whatever the estimate", () => {
        expect(batteryText(complete, "7", { units: 3, leads: 1 })).toEqual({ actual: "7", estimated: false });
    });
});
