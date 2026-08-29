import { describe, expect, it } from "vitest";

import {
  defaultSpendWindow,
  parseSpendWindow,
  resolveSpendWindow,
  spendWindowOptions,
  TRAILING_30,
} from "../spendWindow";

/**
 * The Spend page used to render two windows side by side with nothing naming
 * either: month-to-date in the burn card, trailing 30 days in the
 * reconciliation table directly below it. Both numbers were correct and they
 * could not be reconciled, which is how a correct Hostinger total (₹28,387.88,
 * legitimately including two July invoices) got reported as a wrong one.
 *
 * These tests pin the three things that fix has to get right: one window drives
 * both halves, the default agrees with the burn chart, and the trailing span is
 * actually the length it claims.
 */

// 10 August 2026, 11:30 IST (06:00 UTC) — mid-month, so "month to date" and
// "the whole month" are distinguishable.
const NOW = new Date("2026-08-10T06:00:00Z");

describe("defaultSpendWindow", () => {
  it("defaults to the current month, not trailing 30 days", () => {
    // This IS the fix. A trailing-30 default is what put an unlabelled 30-day
    // figure under a month-to-date one.
    expect(defaultSpendWindow(NOW)).toBe("2026-08");
  });
});

describe("parseSpendWindow", () => {
  it("accepts the trailing preset and a real month", () => {
    expect(parseSpendWindow({ window: TRAILING_30 }, NOW)).toBe("30d");
    expect(parseSpendWindow({ window: "2026-06" }, NOW)).toBe("2026-06");
  });

  it("accepts the current month", () => {
    expect(parseSpendWindow({ window: "2026-08" }, NOW)).toBe("2026-08");
  });

  it("rejects a FUTURE month rather than querying a guaranteed-empty window", () => {
    // An empty result renders as "no spend", which is indistinguishable from a
    // real answer — so a typo would look like a finding.
    expect(parseSpendWindow({ window: "2026-09" }, NOW)).toBe("2026-08");
    expect(parseSpendWindow({ window: "2027-01" }, NOW)).toBe("2026-08");
  });

  it("falls back to the default on junk instead of throwing", () => {
    expect(parseSpendWindow({}, NOW)).toBe("2026-08");
    expect(parseSpendWindow({ window: "" }, NOW)).toBe("2026-08");
    expect(parseSpendWindow({ window: "last-month" }, NOW)).toBe("2026-08");
    expect(parseSpendWindow({ window: "2026-13" }, NOW)).toBe("2026-08");
    expect(parseSpendWindow({ window: "2026-00" }, NOW)).toBe("2026-08");
    expect(parseSpendWindow({ window: "26-08" }, NOW)).toBe("2026-08");
  });

  it("takes the first value when the param is repeated", () => {
    expect(parseSpendWindow({ window: ["2026-06", "2026-07"] }, NOW)).toBe(
      "2026-06",
    );
  });
});

describe("resolveSpendWindow", () => {
  it("gives the current month bounds that stop TODAY, not at month end", () => {
    const w = resolveSpendWindow("2026-08", NOW);
    expect(w.kind).toBe("month");
    expect(w.from).toBe("2026-08-01");
    expect(w.to).toBe("2026-08-10");
    expect(w.partial).toBe(true);
  });

  it("gives a finished month its whole span", () => {
    const w = resolveSpendWindow("2026-06", NOW);
    expect(w.from).toBe("2026-06-01");
    expect(w.to).toBe("2026-06-30");
    expect(w.partial).toBe(false);
  });

  it("handles a 31-day month and February", () => {
    expect(resolveSpendWindow("2026-07", NOW).to).toBe("2026-07-31");
    expect(resolveSpendWindow("2026-02", NOW).to).toBe("2026-02-28");
  });

  it("makes the trailing window 30 days INCLUSIVE of today", () => {
    // The old billed query used `> today - 30`, a strict comparison giving 29
    // days against the metered half's 30 — quietly breaking the card's own
    // "the same trailing 30 days" claim.
    const w = resolveSpendWindow(TRAILING_30, NOW);
    expect(w.to).toBe("2026-08-10");
    expect(w.from).toBe("2026-07-12");

    const from = Date.parse(`${w.from}T00:00:00Z`);
    const to = Date.parse(`${w.to}T00:00:00Z`);
    const inclusiveDays = (to - from) / 86_400_000 + 1;
    expect(inclusiveDays).toBe(30);
  });

  it("crosses a year boundary correctly", () => {
    const jan = new Date("2026-01-05T06:00:00Z");
    expect(resolveSpendWindow("2025-12", jan).to).toBe("2025-12-31");
    expect(resolveSpendWindow(TRAILING_30, jan).from).toBe("2025-12-07");
  });

  it("labels the current month as month-to-date and a past one plainly", () => {
    expect(resolveSpendWindow("2026-08", NOW).label).toContain("month to date");
    expect(resolveSpendWindow("2026-06", NOW).label).not.toContain(
      "month to date",
    );
  });

  it("never returns a `to` before `from`", () => {
    for (const key of [TRAILING_30, "2026-08", "2026-07", "2026-01"]) {
      const w = resolveSpendWindow(key, NOW);
      expect(w.from <= w.to).toBe(true);
    }
  });
});

describe("spendWindowOptions", () => {
  it("offers trailing 30 days first, then months newest-first", () => {
    const options = spendWindowOptions(NOW);
    expect(options[0]!.key).toBe(TRAILING_30);
    expect(options[1]!.key).toBe("2026-08");
    expect(options[2]!.key).toBe("2026-07");
  });

  it("always contains the default, so the select never shows a blank value", () => {
    const options = spendWindowOptions(NOW);
    expect(options.some((o) => o.key === defaultSpendWindow(NOW))).toBe(true);
  });

  it("walks back across a year boundary without producing month 00", () => {
    const options = spendWindowOptions(new Date("2026-02-10T06:00:00Z"));
    const keys = options.map((o) => o.key);
    expect(keys).toContain("2025-12");
    expect(keys).toContain("2025-03");
    expect(keys.every((k) => k === TRAILING_30 || /^\d{4}-(0[1-9]|1[0-2])$/.test(k))).toBe(
      true,
    );
  });
});
