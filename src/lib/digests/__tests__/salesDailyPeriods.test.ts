import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { salesDailyPeriods, sameSpanLastMonth, addDays, firstOfMonth, lastWorkingDayOnOrBefore } = await import(
    "../kinds/sales-daily"
);
const { isWorkingDay } = await import("@/lib/calendar/officeCalendar");

describe("salesDailyPeriods — the windows a Sales Daily is counted over", () => {
    it("Sun 4 Oct 2026: yesterday = that day, last 7 = 28 Sep–4 Oct, MTD = 1–4 Oct, last month = 1–4 Sep", () => {
        // The sample mail that was questioned: every Block A count reconciled
        // to these exact windows on db-2.
        expect(salesDailyPeriods("2026-10-04")).toEqual({
            yesterday: { from: "2026-10-04", to: "2026-10-04" },
            last7: { from: "2026-09-28", to: "2026-10-04" },
            mtd: { from: "2026-10-01", to: "2026-10-04" },
            lastMonth: { from: "2026-09-01", to: "2026-09-04" },
        });
    });

    it("the 1st of a month: MTD is that single day, last month is the 1st of the previous", () => {
        const p = salesDailyPeriods("2026-11-01");
        expect(p.mtd).toEqual({ from: "2026-11-01", to: "2026-11-01" });
        expect(p.last7).toEqual({ from: "2026-10-26", to: "2026-11-01" });
        expect(p.lastMonth).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    });

    it("on the 1st–7th, MTD sits inside last 7 days (so MTD ≤ last 7 for any count)", () => {
        for (let d = 1; d <= 7; d++) {
            const day = `2026-10-0${d}`;
            const p = salesDailyPeriods(day);
            expect(p.last7.from <= p.mtd.from).toBe(true);
            expect(p.last7.to).toBe(p.mtd.to);
        }
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
        expect(p.last7).toEqual({ from: "2026-09-28", to: "2026-10-04" });
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
