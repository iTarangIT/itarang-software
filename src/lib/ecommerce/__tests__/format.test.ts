import { describe, expect, it } from "vitest";

import { formatPrice, formatPriceRange, minorToRupees, rupeesToMinor } from "../format";

/**
 * Amounts are integers in the smallest currency unit. The rupee<->paise
 * conversion is the most dangerous arithmetic in the write path: a factor-of-100
 * slip prices a product at Rs 12.34 instead of Rs 1,234 and publishes it live.
 */

describe("rupeesToMinor", () => {
  it("converts whole and fractional rupees exactly", () => {
    expect(rupeesToMinor("1234.56")).toBe(123456);
    expect(rupeesToMinor("1")).toBe(100);
    expect(rupeesToMinor("0.01")).toBe(1);
    expect(rupeesToMinor("49999")).toBe(4999900);
  });

  it("does not lose paise to floating point", () => {
    // 1234.56 * 100 === 123455.99999999999 in IEEE-754, which floors to 123455
    // and silently underprices by a paisa. String assembly avoids it entirely.
    for (const [input, expected] of [
      ["1234.56", 123456],
      ["8.29", 829],
      ["70.07", 7007],
      ["19.99", 1999],
    ] as const) {
      expect(rupeesToMinor(input)).toBe(expected);
    }
  });

  it("tolerates padding and thousands separators", () => {
    expect(rupeesToMinor("  1234.5  ")).toBe(123450);
    expect(rupeesToMinor("1,234.56")).toBe(123456);
  });

  it("rejects anything that is not a positive 2-decimal amount", () => {
    // The API requires an integer >= 1, so each of these must fail loudly rather
    // than round into something plausible.
    for (const bad of ["0", "0.00", "-5", "1.234", "abc", "", "1e3", "1.2.3", "."]) {
      expect(rupeesToMinor(bad)).toBeNull();
    }
  });
});

describe("minorToRupees", () => {
  it("round-trips through rupeesToMinor", () => {
    for (const minor of [1, 100, 1999, 123456, 4999900]) {
      expect(rupeesToMinor(minorToRupees(minor))).toBe(minor);
    }
  });

  it("returns a plain editable string with no symbol or grouping", () => {
    expect(minorToRupees(123456)).toBe("1234.56");
    expect(minorToRupees(100)).toBe("1.00");
  });
});

describe("formatPrice / formatPriceRange", () => {
  const price = (amountMinor: number | null) => ({
    amountMinor,
    saleAmountMinor: null,
    currencyCode: "inr",
  });

  it("divides by the currency exponent rather than showing raw minor units", () => {
    // 100 paise is Rs 1.00 — rendering "100" would overstate by 100x.
    expect(formatPrice(price(100))).toContain("1.00");
    expect(formatPrice(price(123456))).toContain("1,234.56");
  });

  it("renders an em-dash for a missing price instead of zero", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(price(null))).toBe("—");
  });

  it("collapses a single-value range and spans a real one", () => {
    const single = formatPriceRange({ minMinor: 100, maxMinor: 100, currencyCode: "inr" });
    expect(single).not.toContain("–");
    expect(formatPriceRange({ minMinor: 100, maxMinor: 500, currencyCode: "inr" })).toContain("–");
    expect(formatPriceRange(null)).toBe("—");
  });
});
