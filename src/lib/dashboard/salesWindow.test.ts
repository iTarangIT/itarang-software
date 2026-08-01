import { afterEach, describe, expect, it, vi } from "vitest";
import {
    defaultGranularity,
    resolveWindow,
    resolveWindowParams,
} from "./salesWindow";

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

// ── E-219: the CEO overview filter bar ──────────────────────────────────────
// The bar offers MTD / YTD / FY / Inception / a custom range, and one window
// drives four cards, a drill-down and a chart at once. The cases below pin the
// three periods the bar added; MTD and FY are covered above.

describe("resolveWindow — year to date", () => {
    it("starts on 1 January of the current calendar year, open-ended", () => {
        at("2026-07-28T10:00:00+05:30");
        const w = resolveWindow(null, "ytd");
        expect(w.startStr).toBe("2026-01-01");
        expect(w.endStr).toBeNull();
        expect(w.period).toBe("ytd");
    });

    // YTD and FY are offered as separate buttons, so they must not agree in
    // Jan–Mar: YTD is still this calendar year while FY reaches back to April.
    it("differs from FY in the Jan-March overlap", () => {
        at("2026-02-10T10:00:00+05:30");
        expect(resolveWindow(null, "ytd").startStr).toBe("2026-01-01");
        expect(resolveWindow(null, "fy").startStr).toBe("2025-04-01");
    });
});

describe("resolveWindow — inception", () => {
    // A null start means "no lower bound" rather than some sentinel early date,
    // so callers omit the predicate entirely instead of scanning from year zero.
    it("has no lower bound at all", () => {
        at("2026-07-28T10:00:00+05:30");
        const w = resolveWindow(null, "inception");
        expect(w.startStr).toBeNull();
        expect(w.endStr).toBeNull();
        expect(w.period).toBe("inception");
    });
});

describe("resolveWindow — custom range", () => {
    it("makes the end date inclusive by rolling it forward one day", () => {
        const w = resolveWindow(null, null, null, { from: "2026-04-01", to: "2026-07-15" });
        expect(w.startStr).toBe("2026-04-01");
        expect(w.endStr).toBe("2026-07-16");
        expect(w.period).toBe("range");
    });

    it("rolls a month-end date into the next month", () => {
        const w = resolveWindow(null, null, null, { from: "2026-01-01", to: "2026-01-31" });
        expect(w.endStr).toBe("2026-02-01");
    });

    // Reading a backwards range as empty would look exactly like a broken
    // filter, so the ends are swapped to what the user plainly meant.
    it("swaps ends given in the wrong order", () => {
        const w = resolveWindow(null, null, null, { from: "2026-07-15", to: "2026-04-01" });
        expect(w.startStr).toBe("2026-04-01");
        expect(w.endStr).toBe("2026-07-16");
    });

    it("accepts a half-open range from one end alone", () => {
        const openEnd = resolveWindow(null, null, null, { from: "2026-04-01", to: null });
        expect(openEnd.startStr).toBe("2026-04-01");
        expect(openEnd.endStr).toBeNull();

        const openStart = resolveWindow(null, null, null, { from: null, to: "2026-04-30" });
        expect(openStart.startStr).toBeNull();
        expect(openStart.endStr).toBe("2026-05-01");
    });

    // The bar sends period=range alongside from/to; an explicit range must win
    // over the keyword, or picking dates would silently show the wrong window.
    it("wins over a period keyword", () => {
        at("2026-07-28T10:00:00+05:30");
        const w = resolveWindow(null, "fy", null, { from: "2026-06-01", to: "2026-06-30" });
        expect(w.startStr).toBe("2026-06-01");
        expect(w.endStr).toBe("2026-07-01");
    });

    it("is ignored when both ends are absent", () => {
        at("2026-07-28T10:00:00+05:30");
        const w = resolveWindow(null, "ytd", null, { from: null, to: null });
        expect(w.period).toBe("ytd");
    });
});

describe("defaultGranularity", () => {
    it("buckets a month-to-date window by day", () => {
        at("2026-07-28T10:00:00+05:30");
        expect(defaultGranularity(resolveWindow(null, "mtd"))).toBe("day");
    });

    it("buckets an explicit calendar month by day", () => {
        expect(defaultGranularity(resolveWindow("2026-06", null))).toBe("day");
    });

    it("buckets the long periods by month", () => {
        at("2026-07-28T10:00:00+05:30");
        expect(defaultGranularity(resolveWindow(null, "ytd"))).toBe("month");
        expect(defaultGranularity(resolveWindow(null, "fy"))).toBe("month");
        expect(defaultGranularity(resolveWindow(null, "inception"))).toBe("month");
        expect(defaultGranularity(resolveWindow(null, null, "2025"))).toBe("month");
    });

    // A short custom range gets daily bars; a long one would draw hundreds of
    // them, so it falls back to months at the two-month mark.
    it("picks day or month by the span of a custom range", () => {
        const short = resolveWindow(null, null, null, { from: "2026-06-01", to: "2026-06-30" });
        expect(defaultGranularity(short)).toBe("day");

        const long = resolveWindow(null, null, null, { from: "2026-01-01", to: "2026-06-30" });
        expect(defaultGranularity(long)).toBe("month");
    });

    it("buckets an unbounded range by month", () => {
        const openEnd = resolveWindow(null, null, null, { from: "2020-01-01", to: null });
        expect(defaultGranularity(openEnd)).toBe("month");
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

    it("reads a custom range off from/to", () => {
        const r = resolveWindowParams(sp("period=range&from=2026-04-01&to=2026-07-15"));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.window.startStr).toBe("2026-04-01");
            expect(r.window.endStr).toBe("2026-07-16");
        }
    });

    // A silently-ignored bad date would show the current month under a range
    // the user can see they picked — the one failure mode a finance filter
    // must not have.
    it("rejects a malformed range end", () => {
        expect(resolveWindowParams(sp("from=2026-04-01&to=15-07-2026"))).toEqual({
            ok: false,
            error: "invalid date range",
        });
    });

    it("rejects a date that does not exist", () => {
        expect(resolveWindowParams(sp("from=2026-02-30")).ok).toBe(false);
    });

    it("accepts the inception period", () => {
        const r = resolveWindowParams(sp("period=inception"));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.window.startStr).toBeNull();
            expect(r.window.period).toBe("inception");
        }
    });
});
