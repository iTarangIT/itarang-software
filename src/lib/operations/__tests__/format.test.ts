import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatCount,
  formatDuration,
  formatMetricValue,
  formatMinutesAgo,
  formatPercent,
  toNumber,
} from "../format";

/**
 * One formatter for the pages, the Excel export and the alert emails — so a
 * threshold breach reads the same in the email as on the page it links to. The
 * failure this prevents is an alert saying "disk at 0.91" against a dashboard
 * that says "91%".
 */

describe("toNumber", () => {
  it("parses the strings Postgres numeric returns", () => {
    // THE trap in this codebase: `numeric` comes back as text to avoid float
    // precision loss, so every read path has to convert. Missing this is what
    // made formatMetricValue throw .toFixed on a threshold.
    expect(toNumber("70.0000")).toBe(70);
    expect(toNumber("-12.5")).toBe(-12.5);
    expect(toNumber(42)).toBe(42);
  });

  it("returns null for anything that is not a finite number", () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber(Infinity)).toBeNull();
  });
});

describe("formatBytes", () => {
  it("scales through the units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("keeps one decimal above KB so 1.9 GB is not read as 2 GB", () => {
    expect(formatBytes(Math.round(1.9 * 1024 ** 3))).toBe("1.9 GB");
  });

  it("renders a dash for no value", () => {
    expect(formatBytes(null)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("keeps a decimal below 10 so a creeping 2.4% is not flattened", () => {
    expect(formatPercent(2.4)).toBe("2.4%");
    expect(formatPercent(9.9)).toBe("9.9%");
  });

  it("rounds above 10 — nobody needs 87.3% CPU to a tenth", () => {
    expect(formatPercent(87.3)).toBe("87%");
    expect(formatPercent(100)).toBe("100%");
  });
});

describe("formatDuration", () => {
  it("uses at most two units", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe("2d 3h");
  });

  it("renders a dash for no value", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatMinutesAgo", () => {
  it("says never rather than showing a dash", () => {
    // "never" is a meaningful state for a collector that has not run.
    expect(formatMinutesAgo(null)).toBe("never");
  });

  it("renders an age", () => {
    expect(formatMinutesAgo(90)).toBe("1h 30m ago");
  });
});

describe("formatMetricValue", () => {
  it("renders money from INR paise", () => {
    // ai_call_logs.*_cost_cents and expense_submissions are both stored as
    // paise; formatINR only divides by 100. Never an FX rate.
    expect(formatMetricValue(4395400, "inr_paise")).toContain("43,954");
  });

  it("renders booleans as a state, not a number", () => {
    expect(formatMetricValue(1, "bool")).toBe("Yes");
    expect(formatMetricValue(0, "bool")).toBe("No");
  });

  it("renders ms below and above the second boundary", () => {
    expect(formatMetricValue(342, "ms")).toBe("342 ms");
    expect(formatMetricValue(2500, "ms")).toBe("2.50 s");
  });

  it("uses the Indian grouping for counts", () => {
    expect(formatCount(253404)).toBe("2,53,404");
  });

  it("renders a dash for no value in every unit", () => {
    for (const unit of ["percent", "bytes", "ms", "inr_paise", "bool", "count"] as const) {
      expect(formatMetricValue(null, unit)).toBe("—");
    }
  });
});
