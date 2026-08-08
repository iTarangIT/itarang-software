import { describe, expect, it } from "vitest";

import {
  addMonths,
  DEFAULT_RANGE,
  fillMonths,
  fillRange,
  formatDayLabel,
  isCustomRange,
  monthEnd,
  monthLabel,
  monthOptions,
  monthStart,
  parseRange,
  prevRange,
  resolveRange,
} from "../elevenlabsSeries";

/**
 * The date filter behind /operations/elevenlabs.
 *
 * Everything here is calendar arithmetic, which is the part of this feature that
 * can be wrong while looking right: a February that ends on the 28th in a leap
 * year, a December that rolls into month 13, a "current month" that charts a
 * week of future zeros, or a historical month whose series runs on through
 * today. Each of those renders a plausible page carrying the wrong numbers,
 * which on a monitoring surface is worse than an error.
 *
 * No DB here by design — elevenlabs.ts imports @/lib/db, which throws at import
 * time without DATABASE_URL. Same split, and same reason, as elevenlabsSeries.
 */

/** 7 Aug 2026, 11:30 IST. Mid-month and mid-day, so nothing sits on a boundary. */
const NOW = new Date("2026-08-07T06:00:00Z");

describe("addMonths", () => {
  it("rolls the year over in both directions", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-08", -12)).toBe("2025-08");
  });

  it("zero-pads so the strings stay sortable and sliceable", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-10", -1)).toBe("2026-09");
  });
});

describe("monthStart / monthEnd", () => {
  it("ends February on the 29th in a leap year", () => {
    // The single likeliest bug in this file. 2024 is a leap year; 2026 is not.
    expect(monthEnd("2024-02")).toBe("2024-02-29");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    // 2000 was a leap year, 1900 was not — the century rule, which we get for
    // free from Date.UTC rather than implementing ourselves.
    expect(monthEnd("2000-02")).toBe("2000-02-29");
  });

  it("handles 30- and 31-day months and the December rollover", () => {
    expect(monthEnd("2026-04")).toBe("2026-04-30");
    expect(monthEnd("2026-01")).toBe("2026-01-31");
    expect(monthEnd("2026-12")).toBe("2026-12-31");
  });

  it("starts every month on the 1st", () => {
    expect(monthStart("2026-02")).toBe("2026-02-01");
  });
});

describe("monthLabel", () => {
  it("renders the exact format the requirement names", () => {
    // "January 2026", not "Jan 2026" and not "2026-01".
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2026-02")).toBe("February 2026");
    expect(monthLabel("2026-12")).toBe("December 2026");
  });
});

describe("parseRange", () => {
  it("accepts every preset", () => {
    for (const key of ["mtd", "3m", "6m", "all"]) {
      expect(parseRange({ range: key }, NOW)).toBe(key);
    }
  });

  it("accepts a valid past or current month", () => {
    expect(parseRange({ range: "2026-02" }, NOW)).toBe("2026-02");
    expect(parseRange({ range: "2026-08" }, NOW)).toBe("2026-08");
    expect(parseRange({ range: "2019-11" }, NOW)).toBe("2019-11");
  });

  it("rejects a future month — it can only be a typo", () => {
    expect(parseRange({ range: "2026-09" }, NOW)).toBe(DEFAULT_RANGE);
    expect(parseRange({ range: "2030-01" }, NOW)).toBe(DEFAULT_RANGE);
  });

  it("rejects malformed values rather than passing them to SQL", () => {
    for (const bad of [
      "2026-13",
      "2026-00",
      "2026-2",
      "26-02",
      "2026-02-01",
      "../../etc/passwd",
      "'; DROP TABLE ai_call_logs; --",
      "6M",
      "",
      undefined,
    ]) {
      expect(parseRange({ range: bad }, NOW)).toBe(DEFAULT_RANGE);
    }
  });

  it("takes the first entry when Next hands back an array", () => {
    expect(parseRange({ range: ["6m", "3m"] }, NOW)).toBe("6m");
  });

  it("defaults when the param is absent entirely", () => {
    expect(parseRange({}, NOW)).toBe("mtd");
  });
});

describe("resolveRange", () => {
  it("mtd runs from the 1st to today, never past it", () => {
    const r = resolveRange("mtd", NOW);
    expect(r.from).toBe("2026-08-01");
    // NOT 2026-08-31 — charting the rest of the month as zeros would read as a
    // collapse in usage.
    expect(r.to).toBe("2026-08-07");
    expect(r.bucket).toBe("day");
    expect(r.short).toBe("MTD");
  });

  it("3m and 6m start on a calendar month boundary, not N days back", () => {
    // A fragment bucket at the far edge reads as a collapse rather than as a
    // partial month — the same reasoning already applied to the 6-month query.
    expect(resolveRange("3m", NOW).from).toBe("2026-06-01");
    expect(resolveRange("6m", NOW).from).toBe("2026-03-01");
    expect(resolveRange("3m", NOW).to).toBe("2026-08-07");
  });

  it("switches to month bars only once day bars stop being readable", () => {
    expect(resolveRange("3m", NOW).bucket).toBe("day");
    expect(resolveRange("6m", NOW).bucket).toBe("month");
    expect(resolveRange("all", NOW).bucket).toBe("month");
  });

  it("all time is unbounded at both ends", () => {
    const r = resolveRange("all", NOW);
    expect(r.from).toBeNull();
    expect(r.to).toBeNull();
    expect(r.label).toBe("All time");
  });

  it("a historical month is bounded by that month, not by today", () => {
    const r = resolveRange("2026-02", NOW);
    expect(r.from).toBe("2026-02-01");
    expect(r.to).toBe("2026-02-28");
    expect(r.label).toBe("February 2026");
    expect(r.bucket).toBe("day");
  });

  it("a leap February resolves to the 29th", () => {
    expect(resolveRange("2024-02", NOW).to).toBe("2024-02-29");
  });

  it("December resolves to the 31st without rolling into the next year", () => {
    expect(resolveRange("2025-12", NOW).to).toBe("2025-12-31");
  });

  it("the current month named explicitly still clamps to today", () => {
    // ?range=2026-08 on 7 August must not chart 8-31 August as zeros.
    const r = resolveRange("2026-08", NOW);
    expect(r.to).toBe("2026-08-07");
  });

  it("resolves against the IST boundary, not the UTC one", () => {
    // 31 July 19:00 UTC is already 1 August in IST.
    const justPastIstMidnight = new Date("2026-07-31T19:00:00Z");
    expect(resolveRange("mtd", justPastIstMidnight).from).toBe("2026-08-01");
    // An hour earlier is still July in IST.
    expect(resolveRange("mtd", new Date("2026-07-31T18:00:00Z")).from).toBe(
      "2026-07-01",
    );
  });

  it("echoes the key back so links can round-trip it", () => {
    expect(resolveRange("2026-02", NOW).key).toBe("2026-02");
    expect(resolveRange("6m", NOW).key).toBe("6m");
  });
});

describe("prevRange", () => {
  it("compares a whole month against the whole previous month", () => {
    expect(prevRange(resolveRange("2026-02", NOW))).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("compares month-to-date against the SAME stretch of last month", () => {
    // 1-7 August vs 1-7 July. Comparing against all of July would show a fake
    // collapse every time someone opened the page early in a month.
    expect(prevRange(resolveRange("mtd", NOW))).toEqual({
      from: "2026-07-01",
      to: "2026-07-07",
    });
  });

  it("clamps when the previous month is shorter", () => {
    // 30 days used, but February has 28 — do not produce 2026-02-30.
    const march = resolveRange("2026-03", NOW);
    expect(prevRange(march)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("steps a multi-month preset back by its FULL span, not by one month", () => {
    // "Last 3 months" on 7 Aug is 1 Jun - 7 Aug (68 days). Its predecessor is
    // 1 Mar - 7 May, which is also 68 days — equal length AND month-aligned.
    // Shifting by a single month (the original bug) would have compared three
    // months against one; running to 31 May would compare 68 days against 92.
    expect(prevRange(resolveRange("3m", NOW))).toEqual({
      from: "2026-03-01",
      to: "2026-05-07",
    });
  });

  it("steps 6m back by six months", () => {
    expect(prevRange(resolveRange("6m", NOW))).toEqual({
      from: "2025-09-01",
      to: "2026-02-07",
    });
  });

  it("has no predecessor for all time", () => {
    expect(prevRange(resolveRange("all", NOW))).toBeNull();
  });
});

describe("monthOptions", () => {
  it("runs newest-first from the current month back to the first call", () => {
    const opts = monthOptions(new Date("2026-05-20T06:00:00Z"), NOW);
    expect(opts.map((o) => o.value)).toEqual([
      "2026-08",
      "2026-07",
      "2026-06",
      "2026-05",
    ]);
    expect(opts[0]!.label).toBe("August 2026");
  });

  it("offers exactly the current month when there is no history at all", () => {
    // This is also what the page's error path renders, where no view exists.
    // An empty or disabled control would read as broken rather than as empty.
    const opts = monthOptions(null, NOW);
    expect(opts).toEqual([{ value: "2026-08", label: "August 2026" }]);
  });

  it("offers one month when the first call is inside the current month", () => {
    expect(monthOptions(new Date("2026-08-02T06:00:00Z"), NOW)).toHaveLength(1);
  });

  it("caps a long history rather than rendering a 60-option select", () => {
    const opts = monthOptions(new Date("2015-01-01T06:00:00Z"), NOW);
    expect(opts).toHaveLength(36);
  });

  it("crosses the year boundary in order", () => {
    const opts = monthOptions(new Date("2025-11-01T06:00:00Z"), NOW);
    expect(opts.map((o) => o.value)).toContain("2025-12");
    expect(opts.map((o) => o.value)).toContain("2026-01");
  });
});

describe("fillRange", () => {
  const found = new Map([["2026-02-03", { calls: 5, cost_paise: 900 }]]);

  it("emits an explicit zero for a day with no calls", () => {
    // The whole point: a closed gap draws a continuous line over a week of
    // silence, and silence is the most important reading on this page.
    const out = fillRange(found, "2026-02-01", "2026-02-05");
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ day: "2026-02-01", calls: 0, cost_paise: 0 });
    expect(out[2]).toEqual({ day: "2026-02-03", calls: 5, cost_paise: 900 });
  });

  it("is inclusive of both bounds", () => {
    const out = fillRange(new Map(), "2026-02-01", "2026-02-28");
    expect(out).toHaveLength(28);
    expect(out.at(-1)!.day).toBe("2026-02-28");
  });

  it("does NOT run past `to` for a historical month", () => {
    // fillDays could not express this — it always ends at today. A February
    // chart that ran on to August is the bug this function exists to prevent.
    const out = fillRange(new Map(), "2026-02-01", "2026-02-28");
    expect(out.every((d) => d.day.startsWith("2026-02"))).toBe(true);
  });

  it("handles a single-day range", () => {
    expect(fillRange(new Map(), "2026-02-03", "2026-02-03")).toHaveLength(1);
  });

  it("crosses a month and a leap-day boundary", () => {
    const out = fillRange(new Map(), "2024-02-27", "2024-03-01");
    expect(out.map((d) => d.day)).toEqual([
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("returns nothing when the range is inverted", () => {
    expect(fillRange(new Map(), "2026-02-05", "2026-02-01")).toEqual([]);
  });
});

describe("fillMonths", () => {
  it("emits every month in the window oldest-first, zeros included", () => {
    const found = new Map([["2026-05", { calls: 12, cost_paise: 4200 }]]);
    const out = fillMonths(found, "2026-03-01", "2026-08-07");
    expect(out.map((m) => m.month)).toEqual([
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(out[2]).toEqual({ month: "2026-05", calls: 12, cost_paise: 4200 });
    expect(out[0]!.calls).toBe(0);
  });

  it("crosses the year boundary", () => {
    const out = fillMonths(new Map(), "2025-11-01", "2026-02-28");
    expect(out.map((m) => m.month)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

// ------------------------------------------------------------ custom range --
//
// An arbitrary start/end window, which is NOT constrained to whole calendar
// months. These are the cases where a plausible-looking range can silently
// describe a different window than the URL claims.

describe("parseRange — custom windows", () => {
  it("accepts the from/to pair the date form submits", () => {
    expect(parseRange({ from: "2026-01-12", to: "2026-04-27" }, NOW)).toBe(
      "2026-01-12..2026-04-27",
    );
  });

  it("accepts the canonical a..b form every internal link uses", () => {
    expect(parseRange({ range: "2026-01-12..2026-04-27" }, NOW)).toBe(
      "2026-01-12..2026-04-27",
    );
  });

  it("resolves both URL shapes to the identical key", () => {
    // The whole point of canonicalising: a pasted form URL and a generated
    // link must describe the same window, not two windows that merely agree.
    const a = parseRange({ from: "2026-02-01", to: "2026-03-01" }, NOW);
    const b = parseRange({ range: "2026-02-01..2026-03-01" }, NOW);
    expect(a).toBe(b);
    expect(resolveRange(a, NOW)).toEqual(resolveRange(b, NOW));
  });

  it("lets the pair win when both a preset and a pair are present", () => {
    // Only reachable by hand-writing a URL — a GET form replaces the whole
    // query string — but the precedence must be defined rather than emergent.
    expect(parseRange({ range: "6m", from: "2026-02-01", to: "2026-02-05" }, NOW))
      .toBe("2026-02-01..2026-02-05");
  });

  it("accepts a single-day window", () => {
    expect(parseRange({ from: "2026-08-05", to: "2026-08-05" }, NOW)).toBe(
      "2026-08-05..2026-08-05",
    );
  });

  it("rejects an inverted range rather than silently swapping it", () => {
    // Swapping would render a window the user never asked for while the URL
    // kept claiming the one they typed.
    expect(parseRange({ from: "2026-04-27", to: "2026-01-12" }, NOW)).toBe(
      DEFAULT_RANGE,
    );
  });

  it("clamps a future end date instead of discarding the range", () => {
    // A date picker defaulting to end-of-month is the common case; future days
    // hold no data, so trimming changes nothing that is displayed.
    expect(parseRange({ from: "2026-08-01", to: "2026-12-31" }, NOW)).toBe(
      "2026-08-01..2026-08-07",
    );
  });

  it("rejects a window that lies entirely in the future", () => {
    expect(parseRange({ from: "2027-01-01", to: "2027-02-01" }, NOW)).toBe(
      DEFAULT_RANGE,
    );
  });

  it("rejects dates that match the pattern but do not exist", () => {
    // 2026-02-31 and 2025-02-29 both pass a regex and neither is a real day.
    expect(parseRange({ from: "2026-02-01", to: "2026-02-31" }, NOW)).toBe(
      DEFAULT_RANGE,
    );
    expect(parseRange({ from: "2025-02-29", to: "2025-03-01" }, NOW)).toBe(
      DEFAULT_RANGE,
    );
    // ...but a real leap day is fine.
    expect(parseRange({ from: "2024-02-29", to: "2024-03-01" }, NOW)).toBe(
      "2024-02-29..2024-03-01",
    );
  });

  it("rejects a span beyond the fill ceiling rather than truncating the chart", () => {
    // 400 is MAX_FILL_DAYS. Truncating would draw a chart that silently stops
    // short of the window named in the URL.
    expect(parseRange({ from: "2020-01-01", to: "2026-08-07" }, NOW)).toBe(
      DEFAULT_RANGE,
    );
  });

  it("rejects malformed halves", () => {
    for (const [from, to] of [
      ["2026-1-12", "2026-04-27"],
      ["2026-01-12", "27-04-2026"],
      ["2026-01-12", ""],
      ["'; DROP TABLE ai_call_logs; --", "2026-04-27"],
      ["2026-01-12", "2026-04-27T00:00:00Z"],
    ]) {
      expect(parseRange({ from, to }, NOW)).toBe(DEFAULT_RANGE);
    }
    expect(parseRange({ range: "2026-01-12..bogus" }, NOW)).toBe(DEFAULT_RANGE);
    expect(parseRange({ range: "2026-01-12.." }, NOW)).toBe(DEFAULT_RANGE);
  });

  it("still needs BOTH halves — one alone is not a window", () => {
    expect(parseRange({ from: "2026-01-12" }, NOW)).toBe(DEFAULT_RANGE);
    expect(parseRange({ to: "2026-04-27" }, NOW)).toBe(DEFAULT_RANGE);
  });
});

describe("resolveRange — custom windows", () => {
  it("uses the exact bounds, not the enclosing months", () => {
    // The requirement: a range must NOT be rounded out to whole months.
    const r = resolveRange("2026-01-12..2026-04-27", NOW);
    expect(r.from).toBe("2026-01-12");
    expect(r.to).toBe("2026-04-27");
  });

  it("buckets by span using the same rule as the presets", () => {
    // A few days stays daily...
    expect(resolveRange("2026-08-01..2026-08-08", NOW).bucket).toBe("day");
    // ...92 days is the boundary, still daily...
    expect(resolveRange("2026-05-08..2026-08-07", NOW).bucket).toBe("day");
    // ...and a long window switches to month bars rather than a 3,000px SVG.
    expect(resolveRange("2026-01-12..2026-08-07", NOW).bucket).toBe("month");
  });

  it("labels a multi-day window readably", () => {
    const r = resolveRange("2026-01-12..2026-04-27", NOW);
    expect(r.label).toBe("12 Jan 2026 – 27 Apr 2026");
  });

  it("collapses a single-day window to one date", () => {
    const r = resolveRange("2026-08-05..2026-08-05", NOW);
    expect(r.label).toBe("5 Aug 2026");
    expect(r.short).toBe("5 Aug");
  });

  it("keeps the badge short within one year and disambiguates across years", () => {
    expect(resolveRange("2026-01-12..2026-04-27", NOW).short).toBe("12 Jan–27 Apr");
    expect(resolveRange("2025-12-20..2026-01-05", NOW).short).toBe(
      "20 Dec–5 Jan 2026",
    );
  });

  it("echoes the key so links round-trip", () => {
    expect(resolveRange("2026-01-12..2026-04-27", NOW).key).toBe(
      "2026-01-12..2026-04-27",
    );
  });
});

describe("custom windows reuse the existing machinery", () => {
  it("prevRange gives an equal-length preceding window", () => {
    // 5-8 Aug is 4 days; its predecessor is the 4 days ending 4 Aug.
    expect(prevRange(resolveRange("2026-08-05..2026-08-08", NOW))).toEqual({
      from: "2026-08-01",
      to: "2026-08-04",
    });
  });

  it("fillRange enumerates exactly the window, both bounds included", () => {
    const out = fillRange(new Map(), "2026-08-05", "2026-08-08");
    expect(out.map((d) => d.day)).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]);
  });

  it("fillRange does not run past a window that ended in the past", () => {
    const out = fillRange(new Map(), "2026-02-10", "2026-02-12");
    expect(out).toHaveLength(3);
    expect(out.at(-1)!.day).toBe("2026-02-12");
  });

  it("an empty window still yields zero-filled buckets to chart", () => {
    // Not fabricated data — explicit zeros, which is what "no calls" looks like.
    const out = fillRange(new Map(), "2026-03-01", "2026-03-03");
    expect(out.every((d) => d.calls === 0 && d.cost_paise === 0)).toBe(true);
  });
});

describe("isCustomRange / formatDayLabel", () => {
  it("distinguishes custom windows from presets and months", () => {
    expect(isCustomRange("2026-01-12..2026-04-27")).toBe(true);
    for (const k of ["mtd", "3m", "6m", "all", "2026-02"]) {
      expect(isCustomRange(k)).toBe(false);
    }
  });

  it("formats a day the way the caption reads it", () => {
    expect(formatDayLabel("2026-01-12")).toBe("12 Jan 2026");
    expect(formatDayLabel("2026-12-05")).toBe("5 Dec 2026");
  });
});
