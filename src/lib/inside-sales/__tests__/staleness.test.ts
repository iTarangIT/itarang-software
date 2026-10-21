/**
 * Stale-row cues now run on the one office calendar (18 Oct row 40): IST days,
 * not the browser's weekday or the UTC date.
 */
import { describe, expect, it } from "vitest";
import { idleSeverity, isWorkingDay, staleSeverity, workingDaysBetween, workingDaysSince } from "../staleness";

const none = new Set<string>();

describe("staleness on the office calendar (IST)", () => {
    it("reads the IST day, not the UTC one", () => {
        // 2026-10-04T20:00Z is Monday 5 Oct 01:30 IST — a working day (UTC says Sunday).
        expect(isWorkingDay(new Date("2026-10-04T20:00:00Z"), none)).toBe(true);
        // 2026-10-03T20:00Z is Sunday 4 Oct 01:30 IST — off (UTC says Saturday).
        expect(isWorkingDay(new Date("2026-10-03T20:00:00Z"), none)).toBe(false);
    });

    it("counts a touch at 01:00 IST on its own IST day", () => {
        // Touched Tue 6 Oct 01:00 IST (= Mon 19:30 UTC); now Wed 7 Oct 12:00 IST → 1 working day.
        expect(workingDaysSince("2026-10-05T19:30:00Z", none, new Date("2026-10-07T06:30:00Z"))).toBe(1);
    });

    it("skips Sundays and holidays, 0 when not later", () => {
        // Sat 3 Oct → Mon 5 Oct: Sunday off = 1.
        expect(workingDaysBetween(new Date("2026-10-03T06:30:00Z"), new Date("2026-10-05T06:30:00Z"), none)).toBe(1);
        expect(workingDaysBetween(new Date("2026-10-03T06:30:00Z"), new Date("2026-10-05T06:30:00Z"), new Set(["2026-10-05"]))).toBe(0);
        expect(workingDaysBetween(new Date("2026-10-05T06:30:00Z"), new Date("2026-10-03T06:30:00Z"), none)).toBe(0);
        expect(workingDaysSince(null, none)).toBeNull();
        expect(workingDaysSince("not a date", none)).toBeNull();
    });

    it("takes the office hours' weekdays", () => {
        const monFri = { startHour: 10, endHour: 19, weekdays: [1, 2, 3, 4, 5] };
        // Fri 2 Oct → Mon 5 Oct: Saturday off too = 1.
        expect(workingDaysBetween(new Date("2026-10-02T06:30:00Z"), new Date("2026-10-05T06:30:00Z"), none, monFri)).toBe(1);
        expect(workingDaysBetween(new Date("2026-10-02T06:30:00Z"), new Date("2026-10-05T06:30:00Z"), none)).toBe(2);
    });

    it("keeps the cue bands", () => {
        expect(staleSeverity(null)).toBe("normal");
        expect(staleSeverity(14, { yellow: 5, red: 10, critical: 14 })).toBe("critical");
        expect(staleSeverity(5, { yellow: 5, red: 10, critical: 14 })).toBe("yellow");
    });
});

describe("ISR idle limit row cue (18 Oct row 33)", () => {
    it("red at the idle limit (past limit), critical at twice it, yellow the day before", () => {
        expect(idleSeverity(null, 5)).toBe("normal");
        expect(idleSeverity(3, 5)).toBe("normal");
        expect(idleSeverity(4, 5)).toBe("yellow");
        expect(idleSeverity(5, 5)).toBe("red");
        expect(idleSeverity(10, 5)).toBe("critical");
        expect(idleSeverity(0, 1)).toBe("normal");
        expect(idleSeverity(1, 1)).toBe("red");
    });
});
