import { describe, expect, it } from "vitest";

import {
  MAX_MARGIN_PERCENT,
  MAX_MARGIN_RUPEES,
  marginAmount,
  marginLabel,
  parseMarginInput,
} from "../dealer-margin";

describe("parseMarginInput — rupees", () => {
  it("takes a bare number", () => {
    expect(parseMarginInput("rupees", "3000")).toEqual({ ok: true, value: 3000 });
  });

  it("strips the decorations a dealer actually types", () => {
    for (const raw of ["₹3000", " 3,000 ", "3000 rs", "3000rupees", "₹ 3,000 INR"]) {
      expect(parseMarginInput("rupees", raw)).toEqual({ ok: true, value: 3000 });
    }
  });

  it("rounds to whole rupees", () => {
    expect(parseMarginInput("rupees", "2999.6")).toEqual({ ok: true, value: 3000 });
  });

  it("refuses prose rather than salvaging a number from it", () => {
    // "about 5k" parsing as 5 would be worse than asking again.
    for (const raw of ["about 5k", "5k", "three thousand", "-500", "0x1f", ""]) {
      expect(parseMarginInput("rupees", raw).ok).toBe(false);
    }
  });

  it("refuses a figure above the typo guard", () => {
    expect(parseMarginInput("rupees", String(MAX_MARGIN_RUPEES + 1)).ok).toBe(false);
    expect(parseMarginInput("rupees", String(MAX_MARGIN_RUPEES)).ok).toBe(true);
  });
});

describe("parseMarginInput — percent", () => {
  it("keeps two decimals", () => {
    expect(parseMarginInput("percent", "7.5")).toEqual({ ok: true, value: 7.5 });
    expect(parseMarginInput("percent", "5%")).toEqual({ ok: true, value: 5 });
  });

  it("refuses more than 100% — the rupees-in-the-percent-box typo", () => {
    const res = parseMarginInput("percent", "3000");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("₹3000");
    expect(parseMarginInput("percent", String(MAX_MARGIN_PERCENT)).ok).toBe(true);
  });
});

describe("marginAmount", () => {
  it("is a percentage of the item subtotal, to the rupee", () => {
    expect(marginAmount("percent", 5, 73080)).toBe(3654);
    expect(marginAmount("percent", 7.5, 73080)).toBe(5481);
  });

  it("passes a rupee figure straight through", () => {
    expect(marginAmount("rupees", 3000, 73080)).toBe(3000);
  });

  it("is zero when nothing was added", () => {
    expect(marginAmount("rupees", 0, 73080)).toBe(0);
    expect(marginAmount("percent", 0, 73080)).toBe(0);
  });
});

describe("marginLabel", () => {
  it("reads the way the dealer typed it", () => {
    expect(marginLabel("percent", 7.5)).toBe("7.5%");
    expect(marginLabel("percent", 5)).toBe("5%");
    expect(marginLabel("rupees", 3000)).toBe("₹3,000");
  });
});
