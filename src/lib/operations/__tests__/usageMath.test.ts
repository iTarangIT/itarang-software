import { describe, expect, it } from "vitest";

import {
  DEFAULT_USAGE_DAYS,
  engagedSeconds,
  isUuid,
  MAX_USAGE_ROWS,
  parseUsageFilters,
  percentile,
} from "../usageMath";

/**
 * The claims /operations/usage makes about people, and the arithmetic behind
 * them. These matter more than a normal chart helper: the page reports how long
 * named individuals were in the CRM, so a number that is wrong-but-plausible is
 * not a cosmetic bug — it is a false statement about somebody's working day.
 *
 * No DB here: usage.ts imports @/lib/db, which throws at import time without
 * DATABASE_URL. Same split, same reason, as elevenlabsSeries.
 */

describe("engagedSeconds", () => {
  it("credits a single-ping session with one interval, not zero", () => {
    // Somebody who opened the CRM, did one thing and left was there; zero would
    // erase them from every duration statistic.
    expect(engagedSeconds(1, 0)).toBe(300);
  });

  it("counts pings, not wall-clock, for a normal session", () => {
    // 12 pings over 65 minutes: ping-derived (3600s) is under the span cap.
    expect(engagedSeconds(12, 3900)).toBe(3600);
  });

  it("does NOT bill a sleeping laptop as time in the CRM", () => {
    // THE test this function exists for. A tab left open while the machine
    // sleeps sends 2 heartbeats across a 3-hour span. Reporting the span would
    // claim 10,800 seconds of work that never happened.
    expect(engagedSeconds(2, 10_800)).toBe(600);
  });

  it("caps a clock-skewed or looping client at the wall-clock span", () => {
    // 500 pings inside 10 minutes cannot mean 41 hours of usage.
    expect(engagedSeconds(500, 600)).toBe(900);
  });

  it("survives nonsense input rather than emitting NaN into a chart", () => {
    // An unreadable ping count reports ZERO, not one free interval: when the
    // evidence is corrupt the honest bias on a page that measures people is to
    // under-claim, never to invent time somebody cannot be shown to have spent.
    expect(engagedSeconds(Number.NaN, 600)).toBe(0);
    // An unreadable span still has real pings behind it, and the +interval floor
    // applies, so this one is credited.
    expect(engagedSeconds(3, Number.NaN)).toBe(300);
    expect(engagedSeconds(-5, -5)).toBe(0);
  });

  it("honours a non-default heartbeat interval", () => {
    expect(engagedSeconds(4, 600, 60)).toBe(240);
  });
});

describe("percentile", () => {
  it("returns null for an empty window, never zero", () => {
    // A zero would render as "0m" and read as "sessions are instantaneous" —
    // a confident claim about data we do not have. The page shows "—" instead.
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([], 0.9)).toBeNull();
  });

  it("handles a single sample", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.9)).toBe(42);
  });

  it("computes the median of an odd and an even set", () => {
    expect(percentile([1, 2, 3], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("interpolates the 90th percentile", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
  });

  it("does not care about input order", () => {
    expect(percentile([9, 1, 5, 3, 7], 0.5)).toBe(5);
  });

  it("drops non-finite values instead of poisoning the result", () => {
    expect(percentile([1, Number.NaN, 3], 0.5)).toBe(2);
  });
});

describe("isUuid", () => {
  it("accepts a real uuid in either case", () => {
    expect(isUuid("41b185f9-fa65-4b73-9f8c-ee6d3006916e")).toBe(true);
    expect(isUuid("41B185F9-FA65-4B73-9F8C-EE6D3006916E")).toBe(true);
  });

  it("rejects anything that could reach SQL as a surprise", () => {
    for (const bad of [
      "",
      "' OR 1=1 --",
      "41b185f9-fa65-4b73-9f8c-ee6d300691",
      "41b185f9fa654b739f8cee6d3006916e",
      "../../etc/passwd",
      null,
      undefined,
      42,
    ]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe("parseUsageFilters", () => {
  it("defaults to a week when nothing is supplied", () => {
    expect(parseUsageFilters({}).days).toBe(DEFAULT_USAGE_DAYS);
  });

  it("accepts each offered window", () => {
    for (const d of [1, 7, 30, 90]) {
      expect(parseUsageFilters({ days: String(d) }).days).toBe(d);
    }
  });

  it("falls back to the default rather than clamping an absurd window", () => {
    // A clamp would turn ?days=999999 into a silent 90 and leave the URL lying
    // about what is on screen.
    for (const bad of ["999999", "0", "-7", "14", "abc", ""]) {
      expect(parseUsageFilters({ days: bad }).days).toBe(DEFAULT_USAGE_DAYS);
    }
  });

  it("keeps a valid user filter and drops an invalid one", () => {
    const good = "41b185f9-fa65-4b73-9f8c-ee6d3006916e";
    expect(parseUsageFilters({ user: good }).user).toBe(good);
    expect(parseUsageFilters({ user: "'; DROP TABLE users; --" }).user)
      .toBeUndefined();
    expect(parseUsageFilters({}).user).toBeUndefined();
  });

  it("takes the first entry when Next hands back an array", () => {
    expect(parseUsageFilters({ days: ["30", "1"] }).days).toBe(30);
  });

  it("caps the history at a reviewable size", () => {
    // The per-person view should answer a question, not export a dataset.
    expect(MAX_USAGE_ROWS).toBeLessThanOrEqual(500);
  });
});
