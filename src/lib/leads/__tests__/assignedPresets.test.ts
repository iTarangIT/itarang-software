import { describe, expect, it } from "vitest";
import {
    assignedPresetRange,
    matchAssignedPreset,
    toLocalIsoDate,
} from "../assignedPresets";

// Local-time constructor, so the expectations do not depend on the machine TZ.
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 15, 30);

describe("assignedPresetRange", () => {
    const now = at(2026, 9, 8);

    it("day presets are a single date", () => {
        expect(assignedPresetRange("today", now)).toEqual({ from: "2026-09-08", to: "2026-09-08" });
        expect(assignedPresetRange("yesterday", now)).toEqual({ from: "2026-09-07", to: "2026-09-07" });
    });

    it("lookback presets run from N ago up to today", () => {
        expect(assignedPresetRange("2d", now)).toEqual({ from: "2026-09-06", to: "2026-09-08" });
        expect(assignedPresetRange("1w", now)).toEqual({ from: "2026-09-01", to: "2026-09-08" });
        expect(assignedPresetRange("2w", now)).toEqual({ from: "2026-08-25", to: "2026-09-08" });
        expect(assignedPresetRange("1m", now)).toEqual({ from: "2026-08-08", to: "2026-09-08" });
        expect(assignedPresetRange("2m", now)).toEqual({ from: "2026-07-08", to: "2026-09-08" });
    });

    it("crosses month and year boundaries on the local calendar", () => {
        expect(assignedPresetRange("yesterday", at(2026, 1, 1)).from).toBe("2025-12-31");
        expect(assignedPresetRange("1w", at(2026, 3, 3)).from).toBe("2026-02-24");
        expect(assignedPresetRange("2m", at(2026, 1, 15)).from).toBe("2025-11-15");
    });

    it("clamps month steps to the shorter month instead of rolling over", () => {
        expect(assignedPresetRange("1m", at(2026, 3, 31)).from).toBe("2026-02-28");
        expect(assignedPresetRange("2m", at(2026, 5, 31)).from).toBe("2026-03-31");
    });
});

describe("matchAssignedPreset", () => {
    const now = at(2026, 9, 8);

    it("is empty when no range is set", () => {
        expect(matchAssignedPreset("", "", now)).toBe("");
    });

    it("recognises every preset's own range", () => {
        for (const key of ["today", "yesterday", "2d", "1w", "2w", "1m", "2m"] as const) {
            const r = assignedPresetRange(key, now);
            expect(matchAssignedPreset(r.from, r.to, now)).toBe(key);
        }
    });

    it("reports custom for a hand-picked or half-open range", () => {
        expect(matchAssignedPreset("2026-09-01", "2026-09-03", now)).toBe("custom");
        expect(matchAssignedPreset("2026-09-01", "", now)).toBe("custom");
    });
});

describe("toLocalIsoDate", () => {
    it("zero-pads month and day", () => {
        expect(toLocalIsoDate(at(2026, 1, 5))).toBe("2026-01-05");
    });
});
