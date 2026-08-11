import { describe, expect, it } from "vitest";

import type { ElevenLabsFilters } from "../elevenlabsSeries";
import {
  bucketKey,
  creditUsageWindow,
  parseCharacterStats,
} from "../elevenlabsUsage";

/**
 * The historical half of the ElevenLabs page.
 *
 * The defect these cover: the page could only ever show the CURRENT billing
 * period's credit consumption, because /v1/user/subscription is the only vendor
 * endpoint the codebase called. Selecting "Last 6 months" therefore put six
 * months of rupee cost beside a live balance. /v1/usage/character-stats is the
 * vendor's own history and answers the windowed question — provided the window
 * translation and the response parsing are right, which is what is asserted
 * here. Neither touches the network or the database.
 */

const filters = (over: Partial<ElevenLabsFilters> = {}): ElevenLabsFilters => ({
  key: "mtd",
  from: "2026-08-01",
  to: "2026-08-11",
  label: "August 2026",
  short: "Aug 26",
  bucket: "day",
  ...over,
});

describe("creditUsageWindow", () => {
  it("translates the resolved window into epoch milliseconds", () => {
    const w = creditUsageWindow(filters({ from: "2026-05-01", to: "2026-05-31" }));
    expect(w.start_unix).toBe(Date.parse("2026-05-01T00:00:00Z"));
    // The end day is INCLUSIVE, so the bound has to reach the end of it.
    expect(w.end_unix).toBeGreaterThan(Date.parse("2026-05-31T00:00:00Z"));
    expect(w.end_unix).toBeLessThan(Date.parse("2026-06-01T00:00:00Z"));
  });

  it("takes the bucket from the filter rather than deciding again", () => {
    // Two charts of the same period at different granularities is how a
    // dashboard invites a false comparison.
    expect(creditUsageWindow(filters({ bucket: "day" })).interval).toBe("day");
    expect(creditUsageWindow(filters({ bucket: "month" })).interval).toBe(
      "month",
    );
  });

  it("floors an all-time window rather than leaving it unbounded", () => {
    const now = new Date("2026-08-11T06:00:00Z");
    const w = creditUsageWindow(
      filters({ key: "all", from: null, to: null, bucket: "month" }),
      now,
    );
    expect(w.start_unix).toBe(Date.UTC(2023, 0, 1));
    expect(w.end_unix).toBe(now.getTime());
  });

  it("produces DIFFERENT windows for different selections", () => {
    // The whole complaint was that changing the period changed nothing.
    const may = creditUsageWindow(filters({ from: "2026-05-01", to: "2026-05-31" }));
    const june = creditUsageWindow(filters({ from: "2026-06-01", to: "2026-06-30" }));
    expect(may.start_unix).not.toBe(june.start_unix);
    expect(may.end_unix).not.toBe(june.end_unix);
  });
});

describe("bucketKey", () => {
  it("formats month buckets as YYYY-MM", () => {
    // The real value the live account returned for January 2026.
    expect(bucketKey(1767225600000, "month")).toBe("2026-01");
  });

  it("formats day buckets as YYYY-MM-DD", () => {
    expect(bucketKey(1769126400000, "day")).toBe("2026-01-23");
  });

  it("refuses a non-finite or unparseable timestamp instead of guessing", () => {
    expect(bucketKey(NaN, "day")).toBeNull();
    expect(bucketKey(Infinity, "month")).toBeNull();
  });
});

describe("parseCharacterStats", () => {
  it("reads the real monthly response from the live account", () => {
    // Captured verbatim from GET /v1/usage/character-stats
    // ?aggregation_interval=month&metric=credits on 2026-08-11.
    const payload = {
      time: [
        1767225600000, 1769904000000, 1772323200000, 1775001600000,
        1777593600000, 1780272000000, 1782864000000, 1785542400000,
      ],
      usage: { All: [0.0, 0.0, 0.0, 0.0, 159.0, 233995.0, 10533.0, 247.0] },
    };

    const points = parseCharacterStats(payload, "month");
    expect(points).not.toBeNull();
    expect(points).toHaveLength(8);

    const byKey = new Map(points!.map((p) => [p.key, p.credits]));
    expect(byKey.get("2026-05")).toBe(159);
    expect(byKey.get("2026-06")).toBe(233995);
    expect(byKey.get("2026-07")).toBe(10533);
    // Reconciles to the digit with character_count from /v1/user/subscription.
    expect(byKey.get("2026-08")).toBe(247);
  });

  it("sums every series rather than assuming the 'All' key", () => {
    // A breakdown parameter, or an account with per-workspace splits, would
    // otherwise report one slice as the whole.
    const points = parseCharacterStats(
      {
        time: [1767225600000],
        usage: { "workspace-a": [10], "workspace-b": [32] },
      },
      "month",
    );
    expect(points?.[0]?.credits).toBe(42);
  });

  it("returns null — not an empty series — for an unrecognised shape", () => {
    // A changed API must surface as "unavailable", never as zero consumption.
    expect(parseCharacterStats(null, "day")).toBeNull();
    expect(parseCharacterStats({}, "day")).toBeNull();
    expect(parseCharacterStats({ time: "nope", usage: { All: [] } }, "day")).toBeNull();
    expect(parseCharacterStats({ time: [1] }, "day")).toBeNull();
  });

  it("reads an empty `usage` object as a real zero, not a broken payload", () => {
    // Verbatim shape returned for April 2026, a window with no consumption:
    // 30 day buckets and `usage: {}`. Rejecting it put "the endpoint may have
    // changed" on screen for a period whose true consumption is zero. The rule
    // is never to INVENT data — reporting a genuine zero is not that.
    const points = parseCharacterStats(
      { time: [1775001600000, 1775088000000], usage: {} },
      "day",
    );
    expect(points).toEqual([
      { key: "2026-04-01", credits: 0 },
      { key: "2026-04-02", credits: 0 },
    ]);
  });

  it("distinguishes a genuine zero bucket from a missing one", () => {
    const points = parseCharacterStats(
      { time: [1767225600000, 1769904000000], usage: { All: [0, 5] } },
      "month",
    );
    expect(points).toEqual([
      { key: "2026-01", credits: 0 },
      { key: "2026-02", credits: 5 },
    ]);
  });

  it("returns buckets in ascending key order", () => {
    const points = parseCharacterStats(
      { time: [1769904000000, 1767225600000], usage: { All: [5, 1] } },
      "month",
    );
    expect(points?.map((p) => p.key)).toEqual(["2026-01", "2026-02"]);
  });

  it("treats a non-numeric usage entry as zero rather than NaN", () => {
    const points = parseCharacterStats(
      { time: [1767225600000], usage: { All: [null] } },
      "month",
    );
    expect(points?.[0]?.credits).toBe(0);
  });
});
