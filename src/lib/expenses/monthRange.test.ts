import { describe, it, expect } from "vitest";
import { monthAfter, monthLabel, monthStart, resolveMonthRange } from "./monthRange";

const resolve = (qs: string) => resolveMonthRange(new URLSearchParams(qs));

/** Unwraps a range that is expected to parse; fails loudly if it did not. */
function range(qs: string) {
  const r = resolve(qs);
  if (!r.ok) throw new Error(`expected "${qs}" to parse, got: ${r.error}`);
  return r.range;
}

describe("monthAfter", () => {
  it("steps to the next month", () => {
    expect(monthAfter("2026-07")).toBe("2026-08-01");
  });

  it("rolls December into the next January", () => {
    expect(monthAfter("2026-12")).toBe("2027-01-01");
  });

  it("keeps two-digit months padded", () => {
    expect(monthAfter("2026-08")).toBe("2026-09-01");
    expect(monthStart("2026-01")).toBe("2026-01-01");
  });
});

describe("monthLabel", () => {
  it("names the month without touching the host locale", () => {
    expect(monthLabel("2026-07")).toBe("Jul 2026");
    expect(monthLabel("2025-01")).toBe("Jan 2025");
    expect(monthLabel("2025-12")).toBe("Dec 2025");
  });

  it("passes through anything that is not a month key", () => {
    expect(monthLabel("nonsense")).toBe("nonsense");
  });
});

describe("resolveMonthRange", () => {
  it("treats a single month as a one-month window", () => {
    const r = range("from=2026-07&to=2026-07");
    expect(r.startStr).toBe("2026-07-01");
    expect(r.endStr).toBe("2026-08-01");
    expect(r.slug).toBe("2026-07");
    expect(r.label).toBe("Jul 2026");
  });

  it("spans a multi-month range half-open", () => {
    const r = range("from=2026-04&to=2026-07");
    expect(r.startStr).toBe("2026-04-01");
    // Exclusive end — the whole of July is included, August is not.
    expect(r.endStr).toBe("2026-08-01");
    expect(r.slug).toBe("2026-04_2026-07");
    expect(r.label).toBe("Apr 2026 – Jul 2026");
  });

  it("leaves the upper end open when only `from` is given", () => {
    const r = range("from=2026-04");
    expect(r.startStr).toBe("2026-04-01");
    expect(r.endStr).toBeNull();
    expect(r.label).toBe("Apr 2026 onwards");
    expect(r.bounded).toBe(true);
  });

  it("leaves the lower end open when only `to` is given", () => {
    const r = range("to=2026-04");
    expect(r.startStr).toBeNull();
    expect(r.endStr).toBe("2026-05-01");
    expect(r.label).toBe("up to Apr 2026");
    expect(r.bounded).toBe(true);
  });

  it("is all of time when neither end is given", () => {
    const r = range("");
    expect(r.startStr).toBeNull();
    expect(r.endStr).toBeNull();
    expect(r.bounded).toBe(false);
    expect(r.slug).toBe("all");
  });

  it("swaps ends picked in the wrong order", () => {
    const r = range("from=2026-07&to=2026-04");
    expect(r.startStr).toBe("2026-04-01");
    expect(r.endStr).toBe("2026-08-01");
    expect(r.label).toBe("Apr 2026 – Jul 2026");
  });

  it("still accepts the export's original `month` parameter", () => {
    const r = range("month=2026-07");
    expect(r.startStr).toBe("2026-07-01");
    expect(r.endStr).toBe("2026-08-01");
    expect(r.slug).toBe("2026-07");
  });

  it("does not let `month` be reordered against a stray `from`", () => {
    // `month` wins outright rather than combining, so a leftover param cannot
    // silently widen a single-month export.
    const r = range("month=2026-07&from=2020-01");
    expect(r.startStr).toBe("2026-07-01");
    expect(r.endStr).toBe("2026-08-01");
  });

  it("rejects a malformed month by name", () => {
    expect(resolve("from=2026-7")).toEqual({ ok: false, error: "from must be YYYY-MM" });
    expect(resolve("to=july")).toEqual({ ok: false, error: "to must be YYYY-MM" });
    expect(resolve("month=2026-13")).toEqual({ ok: false, error: "month must be YYYY-MM" });
  });

  it("rejects month 00 and month 13", () => {
    expect(resolve("from=2026-00").ok).toBe(false);
    expect(resolve("from=2026-13").ok).toBe(false);
    expect(resolve("from=2026-12").ok).toBe(true);
  });

  it("ignores blank params rather than failing on them", () => {
    // The tracker leaves an untouched month input empty; that is "no bound",
    // not a validation error.
    const r = range("from=&to=");
    expect(r.bounded).toBe(false);
  });
});
