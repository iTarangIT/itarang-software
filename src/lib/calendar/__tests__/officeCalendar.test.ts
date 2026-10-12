import { describe, expect, it } from "vitest";

import {
    addWorkingMinutes,
    calendarDaysDueAt,
    isWorkingDay,
    istDay,
    workingDaysDueAt,
    workingDaysSince,
    workingMinutesBetween,
} from "@/lib/calendar/officeCalendar";

const NONE = new Set<string>();
// 2026-10-12 is a Monday. 10:00 IST = 04:30Z, 19:00 IST = 13:30Z.
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);

describe("office calendar (ID 85, Part 1)", () => {
    it("Sunday and an active holiday are not working days", () => {
        expect(isWorkingDay("2026-10-12", NONE)).toBe(true);
        expect(isWorkingDay("2026-10-18", NONE)).toBe(false); // Sunday
        expect(isWorkingDay("2026-10-20", new Set(["2026-10-20"]))).toBe(false);
    });

    it("istDay reads the IST calendar day", () => {
        expect(istDay(new Date("2026-10-12T20:00:00Z"))).toBe("2026-10-13");
    });

    it("working minutes skip nights, Sundays and holidays", () => {
        expect(workingMinutesBetween(ist("2026-10-12", "18:00"), ist("2026-10-13", "11:00"), NONE)).toBe(120);
        // Sat 18:00 → Mon 11:00: Sunday off.
        expect(workingMinutesBetween(ist("2026-10-17", "18:00"), ist("2026-10-19", "11:00"), NONE)).toBe(120);
        // A holiday on the Monday pushes the whole day out.
        expect(workingMinutesBetween(ist("2026-10-17", "18:00"), ist("2026-10-19", "11:00"), new Set(["2026-10-19"]))).toBe(60);
    });

    it("addWorkingMinutes is the inverse, and starts counting at the next opening", () => {
        expect(addWorkingMinutes(ist("2026-10-12", "17:00"), 240, NONE)?.toISOString()).toBe(ist("2026-10-13", "12:00").toISOString());
        // Assigned at 21:00 → counting starts 10:00 next day.
        expect(addWorkingMinutes(ist("2026-10-12", "21:00"), 60, NONE)?.toISOString()).toBe(ist("2026-10-13", "11:00").toISOString());
        // Saturday evening → Monday, or Tuesday when Monday is a holiday.
        expect(addWorkingMinutes(ist("2026-10-17", "18:30"), 60, NONE)?.toISOString()).toBe(ist("2026-10-19", "10:30").toISOString());
        expect(addWorkingMinutes(ist("2026-10-17", "18:30"), 60, new Set(["2026-10-19"]))?.toISOString()).toBe(
            ist("2026-10-20", "10:30").toISOString(),
        );
    });

    it("workingDaysSince counts whole working days after the start day", () => {
        expect(workingDaysSince(ist("2026-10-12", "15:00"), ist("2026-10-12", "18:00"), NONE)).toBe(0);
        expect(workingDaysSince(ist("2026-10-17", "15:00"), ist("2026-10-19", "09:00"), NONE)).toBe(1); // Sun skipped
        expect(workingDaysSince(ist("2026-10-17", "15:00"), ist("2026-10-19", "09:00"), new Set(["2026-10-19"]))).toBe(0);
    });

    it("a limit of N working days falls due at the end of working day N", () => {
        // Fri 16 Oct + 3 working days = Sat 17, Mon 19, Tue 20 → end of Tue.
        expect(workingDaysDueAt(ist("2026-10-16", "15:00"), 3, NONE)?.toISOString()).toBe(new Date("2026-10-20T18:29:59.999Z").toISOString());
        expect(calendarDaysDueAt(ist("2026-10-12", "10:00"), 7).toISOString()).toBe(ist("2026-10-19", "10:00").toISOString());
    });
});
