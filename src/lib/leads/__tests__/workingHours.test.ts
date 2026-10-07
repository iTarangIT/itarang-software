import { describe, expect, it } from "vitest";

import { workingHoursBetween, workingMinutesBetween } from "../workingHours";

// Times written in IST (+05:30). 2026-10-07 is a Wednesday; 2026-10-11 a Sunday.
const ist = (s: string) => new Date(`${s}+05:30`);

describe("workingMinutesBetween", () => {
    it("counts plain time inside one working day", () => {
        expect(workingHoursBetween(ist("2026-10-07T11:00:00"), ist("2026-10-07T15:30:00"))).toBe(4.5);
    });

    it("ignores time before 10:00 and after 19:00", () => {
        expect(workingHoursBetween(ist("2026-10-07T08:00:00"), ist("2026-10-07T21:00:00"))).toBe(9);
    });

    it("carries over the night: 17:00 → next day 12:00 is 4 hours", () => {
        expect(workingHoursBetween(ist("2026-10-07T17:00:00"), ist("2026-10-08T12:00:00"))).toBe(4);
    });

    it("skips Sunday", () => {
        // Sat 18:00 → Mon 11:00 = 1 h Saturday + 1 h Monday.
        expect(workingHoursBetween(ist("2026-10-10T18:00:00"), ist("2026-10-12T11:00:00"))).toBe(2);
    });

    it("assigned on a Sunday starts the clock on Monday at 10:00", () => {
        expect(workingHoursBetween(ist("2026-10-11T15:00:00"), ist("2026-10-12T13:00:00"))).toBe(3);
    });

    it("is 0 when the end is not after the start", () => {
        expect(workingMinutesBetween(ist("2026-10-07T12:00:00"), ist("2026-10-07T12:00:00"))).toBe(0);
        expect(workingMinutesBetween(ist("2026-10-07T12:00:00"), ist("2026-10-07T11:00:00"))).toBe(0);
    });
});
