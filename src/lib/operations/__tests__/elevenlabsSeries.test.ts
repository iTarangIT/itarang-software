import { describe, expect, it } from "vitest";

import {
  categoryLabel,
  fillDays,
  istDay,
  istMonth,
  maskPhone,
  momDelta,
  OUTSIDE_CAMPAIGN,
  OUTSIDE_MARKER,
  toIsoDay,
  UNCATEGORISED,
  UNCATEGORISED_MARKER,
} from "../elevenlabsSeries";

/**
 * These are the four decisions on /operations/elevenlabs that can silently
 * produce a wrong-but-plausible page, which is the worst outcome for a
 * monitoring surface: a chart that closes a gap, a delta that compares a part
 * month against a whole one, a residual bucket that swallows a real category,
 * and a phone number rendered in full on an ops screen.
 */

describe("istDay / istMonth", () => {
  it("formats in IST, not UTC", () => {
    // 2026-08-06 19:30 UTC is already 2026-08-07 01:00 in IST (+05:30). A UTC
    // formatter would file this call under the wrong day, and the daily chart
    // would attribute a late-evening calling session to the previous day.
    const late = new Date("2026-08-06T19:30:00Z");
    expect(istDay(late)).toBe("2026-08-07");
    expect(istMonth(late)).toBe("2026-08");
  });

  it("rolls the month over on the IST boundary, not the UTC one", () => {
    // 31 July 19:00 UTC = 1 August 00:30 IST.
    expect(istMonth(new Date("2026-07-31T19:00:00Z"))).toBe("2026-08");
    expect(istMonth(new Date("2026-07-31T18:00:00Z"))).toBe("2026-07");
  });

  it("zero-pads, so string slicing and sorting stay valid", () => {
    expect(istDay(new Date("2026-01-05T06:00:00Z"))).toBe("2026-01-05");
    expect(istDay(new Date("2026-01-05T06:00:00Z")).slice(0, 7)).toBe("2026-01");
  });
});

describe("fillDays", () => {
  const today = new Date("2026-08-06T06:00:00Z"); // 11:30 IST on the 6th

  it("emits one entry per day, oldest first, ending today", () => {
    const days = fillDays(new Map(), 30, today);
    expect(days).toHaveLength(30);
    expect(days[0]!.day).toBe("2026-07-08");
    expect(days[29]!.day).toBe("2026-08-06");
  });

  it("renders a day with no calls as an explicit zero, not a gap", () => {
    // The whole point: a run of quiet days is the "sales stopped using it"
    // signal. Dropping them would let the chart draw straight through a week
    // of silence.
    const found = new Map([["2026-08-06", { calls: 12, cost_paise: 3400 }]]);
    const days = fillDays(found, 3, today);

    expect(days.map((d) => d.day)).toEqual([
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
    ]);
    expect(days.map((d) => d.calls)).toEqual([0, 0, 12]);
    expect(days[0]!.cost_paise).toBe(0);
    expect(days[2]!.cost_paise).toBe(3400);
  });

  it("ignores rows outside the window rather than shifting them in", () => {
    const found = new Map([["2026-01-01", { calls: 99, cost_paise: 9999 }]]);
    const days = fillDays(found, 3, today);
    expect(days.every((d) => d.calls === 0)).toBe(true);
  });
});

describe("momDelta", () => {
  const currentMonth = "2026-08";

  it("compares the two most recent COMPLETE months", () => {
    const delta = momDelta(
      [
        { month: "2026-08", calls: 5, cost_paise: 100 }, // partial — excluded
        { month: "2026-07", calls: 40, cost_paise: 1500 },
        { month: "2026-06", calls: 30, cost_paise: 1000 },
      ],
      currentMonth,
    );
    expect(delta).toBeCloseTo(50);
  });

  it("does not drop the newest row when it is already a complete month", () => {
    // The bug this guards: on 6 August with no August calls yet, there is no
    // August row at all. Dropping monthly[0] blindly would compare June against
    // May and ignore July, the most recent real data.
    const delta = momDelta(
      [
        { month: "2026-07", calls: 40, cost_paise: 2000 },
        { month: "2026-06", calls: 30, cost_paise: 1000 },
        { month: "2026-05", calls: 30, cost_paise: 5000 },
      ],
      currentMonth,
    );
    expect(delta).toBeCloseTo(100); // July vs June, not June vs May
  });

  it("returns null rather than infinity when the base month is zero", () => {
    expect(
      momDelta(
        [
          { month: "2026-07", calls: 40, cost_paise: 2000 },
          { month: "2026-06", calls: 0, cost_paise: 0 },
        ],
        currentMonth,
      ),
    ).toBeNull();
  });

  it("returns null with fewer than two complete months", () => {
    expect(momDelta([], currentMonth)).toBeNull();
    expect(
      momDelta([{ month: "2026-08", calls: 5, cost_paise: 100 }], currentMonth),
    ).toBeNull();
    expect(
      momDelta([{ month: "2026-07", calls: 5, cost_paise: 100 }], currentMonth),
    ).toBeNull();
  });

  it("reports a fall as a negative delta", () => {
    expect(
      momDelta(
        [
          { month: "2026-07", calls: 10, cost_paise: 500 },
          { month: "2026-06", calls: 40, cost_paise: 1000 },
        ],
        currentMonth,
      ),
    ).toBeCloseTo(-50);
  });
});

describe("categoryLabel", () => {
  it("maps the residual marker to a non-campaign bucket", () => {
    expect(categoryLabel(OUTSIDE_MARKER)).toEqual({
      category: OUTSIDE_CAMPAIGN,
      is_campaign: false,
    });
  });

  it("maps a categoryless campaign to its own labelled bucket", () => {
    // Distinct from "outside campaign": these calls DID come from a campaign,
    // and merging the two would hide the fact that campaigns are running
    // untagged.
    expect(categoryLabel(UNCATEGORISED_MARKER)).toEqual({
      category: UNCATEGORISED,
      is_campaign: true,
    });
  });

  it("passes a real category through untouched", () => {
    expect(categoryLabel("dealer_outreach")).toEqual({
      category: "dealer_outreach",
      is_campaign: true,
    });
  });

  it("does not let a campaign named like the bucket masquerade as the residual", () => {
    // The markers are deliberately not user-facing strings for exactly this.
    expect(categoryLabel(OUTSIDE_CAMPAIGN)).toEqual({
      category: OUTSIDE_CAMPAIGN,
      is_campaign: true,
    });
  });
});

describe("maskPhone", () => {
  it("keeps only the last four digits", () => {
    expect(maskPhone("+919876543210")).toBe("••••3210");
  });

  it("returns null for empty, blank or non-string input", () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone("")).toBeNull();
    expect(maskPhone("   ")).toBeNull();
    expect(maskPhone(9876543210)).toBeNull();
  });

  it("does not pad a short number into looking longer than it is", () => {
    expect(maskPhone("123")).toBe("123");
    expect(maskPhone("1234")).toBe("1234");
    expect(maskPhone("12345")).toBe("••••2345");
  });
});

/**
 * The regression that emptied every day-bucketed chart on the page.
 *
 * postgres.js parses a `date` column (oid 1082) into a JS Date, so the old
 * `String(r.date).slice(0, 10)` produced "Mon Jun 22" and never matched the
 * "2026-06-22" keys fillRange builds. Month buckets were unaffected because
 * TO_CHAR returns a real string — which is why only "Current month" and "Last
 * 3 months" looked broken while "Last 6 months" looked fine.
 */
describe("toIsoDay", () => {
  it("reads a Date back as the calendar day it was selected as", () => {
    // Exactly what postgres.js builds from the wire value "2026-06-22".
    expect(toIsoDay(new Date("2026-06-22"))).toBe("2026-06-22");
  });

  it("is what the old String().slice() was NOT", () => {
    const fromDriver = new Date("2026-06-22");
    expect(String(fromDriver).slice(0, 10)).not.toBe("2026-06-22");
    expect(toIsoDay(fromDriver)).toBe("2026-06-22");
  });

  it("accepts a plain string too, so a driver change cannot reintroduce the bug", () => {
    expect(toIsoDay("2026-06-22")).toBe("2026-06-22");
    expect(toIsoDay("2026-06-22T00:00:00.000Z")).toBe("2026-06-22");
  });

  it("returns null rather than a plausible-looking wrong day", () => {
    expect(toIsoDay(null)).toBeNull();
    expect(toIsoDay(undefined)).toBeNull();
    expect(toIsoDay(12345)).toBeNull();
    expect(toIsoDay("not-a-date")).toBeNull();
    expect(toIsoDay(new Date("nonsense"))).toBeNull();
  });

  it("agrees with the key fillDays builds, for every day of a month", () => {
    // The two must agree on every day or the maps silently half-intersect.
    for (let day = 1; day <= 31; day++) {
      const iso = `2026-01-${String(day).padStart(2, "0")}`;
      expect(toIsoDay(new Date(iso))).toBe(iso);
    }
  });
});

describe("momDelta adjacency", () => {
  const m = (month: string, cost_paise: number) => ({
    month,
    calls: 1,
    cost_paise,
  });

  it("compares two adjacent complete months", () => {
    const delta = momDelta(
      [m("2026-08", 500), m("2026-07", 200), m("2026-06", 100)],
      "2026-08",
    );
    expect(delta).toBe(100);
  });

  it("refuses to call July-against-May a month-over-month", () => {
    // June is missing entirely — the exact shape spend.ts's ungapped burn query
    // returns when a month has no invoices.
    expect(
      momDelta([m("2026-08", 500), m("2026-07", 200), m("2026-05", 100)], "2026-08"),
    ).toBeNull();
  });

  it("still returns null on a zero base rather than infinity", () => {
    expect(
      momDelta([m("2026-08", 500), m("2026-07", 200), m("2026-06", 0)], "2026-08"),
    ).toBeNull();
  });

  it("handles a year boundary as adjacent", () => {
    expect(
      momDelta([m("2026-02", 0), m("2026-01", 150), m("2025-12", 100)], "2026-02"),
    ).toBe(50);
  });
});
