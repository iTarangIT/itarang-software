import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOURS,
  MAX_HOURS,
  MAX_SEARCH_CHARS,
  parseFilters,
  parseHours,
} from "../logsMath";

/**
 * parseFilters() is the only thing between a query string and four SQL
 * statements, and it had no test — it lived in logs.ts, which imports @/lib/db
 * and therefore cannot be loaded without a live DATABASE_URL. That structural
 * gap is how the fractional-hours crash below survived.
 */

describe("parseHours", () => {
  it("defaults an absent, empty or unparseable value", () => {
    expect(parseHours(undefined)).toBe(DEFAULT_HOURS);
    expect(parseHours("abc")).toBe(DEFAULT_HOURS);
    expect(parseHours("")).toBe(DEFAULT_HOURS);
    expect(parseHours("NaN")).toBe(DEFAULT_HOURS);
  });

  it("defaults zero and negatives rather than inverting the window", () => {
    expect(parseHours("0")).toBe(DEFAULT_HOURS);
    expect(parseHours("-5")).toBe(DEFAULT_HOURS);
  });

  it("ALWAYS returns a whole number", () => {
    // The regression this file exists for. A fractional value reached
    // MAKE_INTERVAL(hours => $1), whose parameter Postgres types as integer, so
    // ?hours=0.5 replaced the entire Logs page with an error card containing a
    // raw SQL dump.
    for (const raw of ["0.5", "1.7", "23.99", "336.5", "1e2", "12.000001"]) {
      const out = parseHours(raw);
      expect(Number.isInteger(out), `${raw} -> ${out}`).toBe(true);
    }
  });

  it("floors a fraction to the narrowest real window, not to the default", () => {
    // 0.5 means "less than an hour"; answering with 24 would silently widen the
    // window by 48x, which is the opposite of what was asked.
    expect(parseHours("0.5")).toBe(1);
    expect(parseHours("1.9")).toBe(1);
  });

  it("truncates rather than rounds, so a window never widens", () => {
    expect(parseHours("23.9")).toBe(23);
    expect(parseHours("2.99")).toBe(2);
  });

  it("clamps to the retention window", () => {
    expect(parseHours("999999")).toBe(MAX_HOURS);
    expect(parseHours("1e9")).toBe(MAX_HOURS);
    expect(parseHours(String(MAX_HOURS))).toBe(MAX_HOURS);
  });

  it("rejects Infinity", () => {
    expect(parseHours("Infinity")).toBe(DEFAULT_HOURS);
    expect(parseHours("-Infinity")).toBe(DEFAULT_HOURS);
  });
});

describe("parseFilters", () => {
  it("returns the default window for an empty query string", () => {
    expect(parseFilters({})).toEqual({
      host: undefined,
      service: undefined,
      level: undefined,
      q: undefined,
      hours: DEFAULT_HOURS,
      fingerprint: undefined,
    });
  });

  it("accepts the three known levels and rejects anything else", () => {
    expect(parseFilters({ level: "error" }).level).toBe("error");
    expect(parseFilters({ level: "WARN" }).level).toBe("warn");
    expect(parseFilters({ level: "Info" }).level).toBe("info");
    // normaliseLevel() maps these at ingest, so nothing else can be stored —
    // passing one through would produce a guaranteed-empty query.
    expect(parseFilters({ level: "fatal" }).level).toBeUndefined();
    expect(parseFilters({ level: "debug" }).level).toBeUndefined();
    expect(parseFilters({ level: "" }).level).toBeUndefined();
  });

  it("only accepts a full sha256 hex fingerprint", () => {
    const good = "a".repeat(64);
    expect(parseFilters({ fingerprint: good }).fingerprint).toBe(good);

    for (const bad of [
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64), // uppercase: the column stores lowercase hex
      "g".repeat(64), // not hex
      "'; DROP TABLE ops_log_events--",
      "",
    ]) {
      expect(parseFilters({ fingerprint: bad }).fingerprint).toBeUndefined();
    }
  });

  it("takes the first value when a param is repeated", () => {
    // ?level=error&level=info — Next hands these over as an array.
    expect(parseFilters({ level: ["error", "info"] }).level).toBe("error");
    expect(parseFilters({ hours: ["6", "336"] }).hours).toBe(6);
  });

  it("trims, and treats a whitespace-only value as absent", () => {
    expect(parseFilters({ host: "  prod-1  " }).host).toBe("prod-1");
    expect(parseFilters({ host: "   " }).host).toBeUndefined();
    expect(parseFilters({ q: "  \t " }).q).toBeUndefined();
  });

  it("caps the free-text fields at their column widths", () => {
    const long = "x".repeat(5000);
    expect(parseFilters({ host: long }).host).toHaveLength(32);
    expect(parseFilters({ service: long }).service).toHaveLength(120);
    expect(parseFilters({ q: long }).q).toHaveLength(MAX_SEARCH_CHARS);
  });

  it("passes a search term through verbatim within the cap", () => {
    // Bound as a parameter downstream, so wildcards and quotes are data. What
    // matters here is that the term is not mangled before it gets there.
    expect(parseFilters({ q: "100% CPU" }).q).toBe("100% CPU");
    expect(parseFilters({ q: "o'brien" }).q).toBe("o'brien");
    expect(parseFilters({ q: "_underscore_" }).q).toBe("_underscore_");
  });

  it("ignores unknown parameters instead of carrying them into SQL", () => {
    const filters = parseFilters({ evil: "1", hours: "6" });
    expect(filters.hours).toBe(6);
    expect(Object.keys(filters).sort()).toEqual([
      "fingerprint",
      "host",
      "hours",
      "level",
      "q",
      "service",
    ]);
  });
});
