import { describe, expect, it } from "vitest";

import { buildHolidayBook } from "@/lib/calendar/holidayBook";
import { workingMinutesBetween } from "@/lib/leads/workingHours";

// ID 85 #6 (22 Oct) — a wait that has ENDED is measured with the holidays as
// they stood when it ended (asOf(end)), the way the Sales dashboard median,
// the daily email's MTD median, decided CEO quote waits and the events export
// now read it. Adding a past holiday afterwards must not change it.
describe("finished waits use the holidays as they stood when they ended (ID 85 #6)", () => {
    // Fri 16 Oct 10:00 IST → Mon 19 Oct 10:00 IST; Sat 17 Oct declared a holiday on 20 Oct.
    const start = new Date("2026-10-16T04:30:00Z");
    const end = new Date("2026-10-19T04:30:00Z");
    const book = buildHolidayBook(
        [{ date: "2026-10-17", active: true }],
        [{ date: "2026-10-17", action: "add", at: new Date("2026-10-20T05:00:00Z") }],
    );

    it("a holiday added after the wait ended does not shorten it", () => {
        const asOf = workingMinutesBetween(start, end, book(end));
        const today = workingMinutesBetween(start, end, book(new Date("2026-11-01T00:00:00Z")));
        expect(asOf).toBeGreaterThan(today);
        expect(asOf).toBe(workingMinutesBetween(start, end, new Set()));
    });

    it("a wait that ends after the holiday was added does skip it", () => {
        const later = new Date("2026-10-20T06:00:00Z");
        expect(workingMinutesBetween(start, later, book(later))).toBe(
            workingMinutesBetween(start, later, new Set(["2026-10-17"])),
        );
    });
});
