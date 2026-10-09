import { describe, expect, it } from "vitest";

import { buildCallTimingGrid, MIN_DIALS_PER_HOUR, suggestCallingHours } from "../callTimingShape";

const row = (dow: number, hour: number, dials: number, answered: number, talked: number) => ({
    dow,
    hour,
    dials,
    answered,
    talked,
});

describe("buildCallTimingGrid", () => {
    it("places each row in its weekday × hour cell and totals every axis", () => {
        const g = buildCallTimingGrid([row(1, 10, 30, 12, 6), row(1, 11, 10, 2, 1), row(7, 10, 5, 1, 0)]);
        expect(g.cells[0][10]).toEqual({ dials: 30, answered: 12, talked: 6 });
        expect(g.cells[6][10]).toEqual({ dials: 5, answered: 1, talked: 0 });
        expect(g.byHour[10]).toEqual({ dials: 35, answered: 13, talked: 6 });
        expect(g.byWeekday[0]).toEqual({ dials: 40, answered: 14, talked: 7 });
        expect(g.total).toEqual({ dials: 45, answered: 15, talked: 7 });
    });

    it("ignores rows outside the grid", () => {
        const g = buildCallTimingGrid([row(0, 10, 5, 1, 1), row(8, 10, 5, 1, 1), row(1, 24, 5, 1, 1)]);
        expect(g.total.dials).toBe(0);
        expect(g.suggestion).toBeNull();
    });
});

describe("suggestCallingHours", () => {
    it("spans the first to the last hour that beats the overall talk rate", () => {
        const g = buildCallTimingGrid([
            row(2, 9, 40, 10, 2), // 5% — below
            row(2, 11, 40, 20, 12), // 30% — above
            row(2, 13, 40, 8, 4), // 10% — below, but inside the window
            row(2, 16, 40, 22, 14), // 35% — above
            row(2, 19, 40, 6, 2), // 5% — below
        ]);
        expect(g.suggestion).toMatchObject({
            window_start: "11:00",
            window_end: "17:00",
            best_hours: [11, 16],
        });
        expect(g.suggestion!.window_talk_rate).toBeGreaterThan(g.suggestion!.overall_talk_rate);
    });

    it("does not trust an hour with too few dials", () => {
        const g = buildCallTimingGrid([
            row(3, 8, MIN_DIALS_PER_HOUR - 1, 10, 10), // perfect, but too small
            row(3, 12, 50, 20, 10),
            row(3, 15, 50, 10, 2),
        ]);
        expect(g.suggestion?.best_hours).toEqual([12]);
        expect(g.suggestion?.window_start).toBe("12:00");
        expect(g.suggestion?.window_end).toBe("13:00");
    });

    it("says nothing when nobody talked", () => {
        expect(
            suggestCallingHours(
                Array.from({ length: 24 }, () => ({ dials: 50, answered: 5, talked: 0 })),
                { dials: 1200, answered: 120, talked: 0 },
            ),
        ).toBeNull();
    });

    it("ends a window reaching midnight at 23:59 (a campaign window is HH:MM)", () => {
        const g = buildCallTimingGrid([row(4, 23, 30, 20, 15), row(4, 10, 30, 5, 1)]);
        expect(g.suggestion?.window_end).toBe("23:59");
    });
});
