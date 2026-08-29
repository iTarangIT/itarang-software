import { describe, expect, it } from "vitest";

import { parseRupees } from "../requested-loan-amount-parse";

describe("parseRupees", () => {
  it("parses plain and grouped digits", () => {
    expect(parseRupees("60000")).toBe(60000);
    expect(parseRupees("₹ 1,20,000")).toBe(120000);
    expect(parseRupees("Rs. 75,000/-")).toBe(75000);
  });
  it("parses k and lakh suffixes", () => {
    expect(parseRupees("60k")).toBe(60000);
    expect(parseRupees("1.5 lakh")).toBe(150000);
    expect(parseRupees("2 lacs")).toBe(200000);
    expect(parseRupees("1L")).toBe(100000);
  });
  it("rejects junk and out-of-band values", () => {
    expect(parseRupees("hello")).toBeNull();
    expect(parseRupees("0")).toBeNull();
    expect(parseRupees("5 crore")).toBeNull();
  });
});
