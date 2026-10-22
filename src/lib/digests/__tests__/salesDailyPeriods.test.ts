import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { salesDailyPeriods, sameSpanLastMonth, addDays, firstOfMonth, lastWorkingDayOnOrBefore } = await import(
    "../kinds/sales-daily"
);
const { isWorkingDay } = await import("@/lib/calendar/officeCalendar");

describe("salesDailyPeriods — the windows a Sales Daily is counted over", () => {
    it("ID 188: Sun 4 Oct 2026 with no calendar — yesterday, the day before, the same day last week, MTD", () => {
        expect(salesDailyPeriods("2026-10-04")).toEqual({
            yesterday: { from: "2026-10-04", to: "2026-10-04" },
            dayBefore: { from: "2026-10-03", to: "2026-10-03" },
            sameDayLastWeek: { from: "2026-09-27", to: "2026-09-27" },
            mtd: { from: "2026-10-01", to: "2026-10-04" },
        });
    });

    it("early in a month: the same day last week falls in the previous month", () => {
        const p = salesDailyPeriods("2026-11-02");
        expect(p.mtd).toEqual({ from: "2026-11-01", to: "2026-11-02" });
        expect(p.dayBefore).toEqual({ from: "2026-11-01", to: "2026-11-01" });
        expect(p.sameDayLastWeek).toEqual({ from: "2026-10-26", to: "2026-10-26" });
    });

    it("same span last month is capped at the shorter month's last day", () => {
        expect(sameSpanLastMonth("2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
        expect(sameSpanLastMonth("2028-03-30")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
        expect(sameSpanLastMonth("2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-15" });
    });

    it("ID 194: on a Monday the covered day is Sunday, so Yesterday is Saturday (office calendar)", () => {
        const working = (d: string) => isWorkingDay(d, new Set());
        // Sun 4 Oct 2026 → Sat 3 Oct; MTD and Last 7 still run to the covered day.
        const p = salesDailyPeriods("2026-10-04", working);
        expect(p.yesterday).toEqual({ from: "2026-10-03", to: "2026-10-03" });
        expect(p.mtd).toEqual({ from: "2026-10-01", to: "2026-10-04" });
        // ID 188: the day before Saturday is Friday; the same day last week is the Saturday before.
        expect(p.dayBefore).toEqual({ from: "2026-10-02", to: "2026-10-02" });
        expect(p.sameDayLastWeek).toEqual({ from: "2026-09-26", to: "2026-09-26" });
        // Tuesday's email (covers Mon 5 Oct): the day before skips Sunday to Saturday.
        expect(salesDailyPeriods("2026-10-05", working).dayBefore).toEqual({ from: "2026-10-03", to: "2026-10-03" });
        // A holiday Friday is stepped over too.
        const withHoliday = (d: string) => isWorkingDay(d, new Set(["2026-10-02"]));
        expect(salesDailyPeriods("2026-10-03", withHoliday).dayBefore).toEqual({ from: "2026-10-01", to: "2026-10-01" });
        // A working day stays itself; a holiday Saturday steps back to Friday.
        expect(lastWorkingDayOnOrBefore("2026-10-06", working)).toBe("2026-10-06");
        expect(lastWorkingDayOnOrBefore("2026-10-04", (d) => isWorkingDay(d, new Set(["2026-10-03"])))).toBe("2026-10-02");
        // No calendar: the covered day as before.
        expect(lastWorkingDayOnOrBefore("2026-10-04")).toBe("2026-10-04");
    });

    it("addDays / firstOfMonth cross month and year ends", () => {
        expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
        expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
        expect(firstOfMonth("2026-10-04")).toBe("2026-10-01");
    });
});
