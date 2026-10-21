/**
 * targets/rules.workingDaysBetween now delegates to the office calendar
 * (18 Oct row 40). Same answers as the old private loop on every fixture.
 */
import { describe, expect, it } from "vitest";
import { workingDaysBetween } from "../rules";

/** The loop rules.ts had before 18 Oct, kept here as the reference. */
function oldWorkingDaysBetween(from: string, to: string, holidays: ReadonlySet<string>): number {
    if (to < from) return 0;
    let n = 0;
    const d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (d.getTime() <= end.getTime()) {
        const iso = d.toISOString().slice(0, 10);
        if (d.getUTCDay() !== 0 && !holidays.has(iso)) n++;
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return n;
}

const FIXTURES: Array<[string, string, string[]]> = [
    ["2026-09-01", "2026-09-30", []],
    ["2026-09-01", "2026-09-30", ["2026-09-17"]],
    ["2026-10-01", "2026-10-31", ["2026-10-02", "2026-10-20", "2026-10-04"]],
    ["2026-10-04", "2026-10-04", []],
    ["2026-10-05", "2026-10-05", []],
    ["2026-09-10", "2026-09-09", []],
    ["2026-02-01", "2026-02-28", ["2026-02-15"]],
    ["2025-12-25", "2026-01-10", ["2025-12-25", "2026-01-01"]],
];

describe("workingDaysBetween — parity with the old loop", () => {
    it.each(FIXTURES)("%s → %s", (from, to, hol) => {
        const set = new Set(hol);
        expect(workingDaysBetween(from, to, set)).toBe(oldWorkingDaysBetween(from, to, set));
    });

    it("takes the office hours' weekdays when given", () => {
        expect(workingDaysBetween("2026-10-01", "2026-10-31", new Set(), { startHour: 10, endHour: 19, weekdays: [1, 2, 3, 4, 5] })).toBe(22);
    });
});
