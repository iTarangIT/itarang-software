import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWindow, resolveWindowParams } from "./salesWindow";

// E-218 consolidated four hand-copied window resolvers into this one. Every CEO
// expense figure — the card, its drill-down, the bucket tiles and the trend —
// now derives its [start, end) from here, so an off-by-one month boundary is no
// longer a bug in one route but a wrong number in all of them at once.
//
// The date-dependent cases pin a fake clock; the explicit-window cases do not
// need one and deliberately do not use it.

const at = (iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
};

afterEach(() => {
    vi.useRealTimers();
});

describe("resolveWindow — explicit month", () => {
    it("returns the month as a half-open range", () => {
        const w = resolveWindow("2026-06", null);
        expect(w.startStr).toBe("2026-06-01");
        expect(w.endStr).toBe("2026-07-01");
        expect(w.period).toBe("2026-06");
    });

    it("rolls the end into the next year for December", () => {
        const w = resolveWindow("2026-12", null);
        expect(w.startStr).toBe("2026-12-01");
        expect(w.endStr).toBe("2027-01-01");
    });

    it("wins over both period and year", () => {
        const w = resolveWindow("2026-06", "fy", "2024");
        expect(w.startStr).toBe("2026-06-01");
        expect(w.endStr).toBe("2026-07-01");
    });
});

describe("resolveWindow — year", () => {
    it("covers Jan to Dec of that year", () => {
        const w = resolveWindow(null, null, "2025");
        expect(w.startStr).toBe("2025-01-01");
        expect(w.endStr).toBe("2026-01-01");
        expect(w.period).toBe("year-2025");
        expect(w.label).toBe("Year 2025");
    });

    // The drill-down passes ?year= straight through from the query string. A
    // malformed one used to be regex-guarded there; the guard now lives here,
    // because "NaN-01-01" is a query that matches nothing and reports zero
    // spend rather than failing visibly.
    it("ignores a malformed year instead of producing NaN dates", () => {
        at("2026-07-28T10:00:00+05:30");
        const w = resolveWindow(null, null, "abcd");
        expect(w.startStr).toBe("2026-07-01");
        expect(w.period).toBe("mtd");
    });
});

describe("resolveWindow — financial year", () => {
    it("starts on 1 April of the current FY and stays open-ended", () => {
        at("2026-07-28T10:00:00+05:30");
        const w = resolveWindow(null, "fy");
        expect(w.startStr).toBe("2026-04-01");
        expect(w.endStr).toBeNull();
    });

    // India's FY starts in April, so anything in Jan–Mar belongs to the FY that
    // began the PREVIOUS calendar year.
    it("reaches back to last April when the date is before April", () => {
        at("2026-02-10T10:00:00+05:30");
        const w = resolveWindow(null, "fy");
        expect(w.startStr).toBe("2025-04-01");
        expect(w.endStr).toBeNull();
    });
});

describe("resolveWindow — default month-to-date", () => {
    it("covers the current calendar month", () => {
        at("2026-07-28T10:00:00+05:30");
        const w = resolveWindow(null, null);
        expect(w.startStr).toBe("2026-07-01");
        expect(w.endStr).toBe("2026-08-01");
        expect(w.period).toBe("mtd");
    });

    it("rolls into next year in December", () => {
        at("2026-12-15T10:00:00+05:30");
        const w = resolveWindow(null, null);
        expect(w.startStr).toBe("2026-12-01");
        expect(w.endStr).toBe("2027-01-01");
    });
});

describe("resolveWindowParams", () => {
    const sp = (q: string) => new URLSearchParams(q);

    it("accepts a well-formed month", () => {
        const r = resolveWindowParams(sp("month=2026-06"));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.window.startStr).toBe("2026-06-01");
    });

    it("rejects a month outside 1-12", () => {
        const r = resolveWindowParams(sp("month=2026-13"));
        expect(r).toEqual({ ok: false, error: "invalid month" });
    });

    it("rejects a malformed month", () => {
        expect(resolveWindowParams(sp("month=june")).ok).toBe(false);
    });

    it("rejects an out-of-range year", () => {
        expect(resolveWindowParams(sp("year=1799"))).toEqual({
            ok: false,
            error: "invalid year",
        });
    });

    // A month wins over a year in resolveWindow, so validating the year the
    // request will never use would 400 a request that is actually answerable.
    it("does not reject a bad year that a valid month overrides", () => {
        const r = resolveWindowParams(sp("month=2026-06&year=abcd"));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.window.startStr).toBe("2026-06-01");
    });

    it("falls back to month-to-date with no params", () => {
        at("2026-07-28T10:00:00+05:30");
        const r = resolveWindowParams(sp(""));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.window.period).toBe("mtd");
            expect(r.window.startStr).toBe("2026-07-01");
        }
    });
});
