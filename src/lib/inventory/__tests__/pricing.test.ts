import { describe, expect, it } from "vitest";
import { gstAmount, inventoryPriceFields, priceInclusiveGst } from "../pricing";

describe("inventory pricing", () => {
  it("adds GST on the base value", () => {
    expect(gstAmount(10_000, 18)).toBe(1_800);
    expect(priceInclusiveGst(10_000, 18)).toBe(11_800);
  });

  it("is the identity at 0% / unset GST", () => {
    expect(priceInclusiveGst(10_000, 0)).toBe(10_000);
    expect(priceInclusiveGst(10_000, null)).toBe(10_000);
    expect(gstAmount(10_000, undefined)).toBe(0);
  });

  it("rounds to paise", () => {
    expect(gstAmount(999.99, 18)).toBe(180);
    expect(priceInclusiveGst(999.99, 18)).toBe(1_179.99);
    expect(priceInclusiveGst(36_000, 20)).toBe(43_200);
  });

  it("coerces string inputs the way CSV rows arrive", () => {
    expect(inventoryPriceFields("36000", "20")).toEqual({
      gstPercent: 20,
      gstAmount: 7_200,
      priceInclusiveGst: 43_200,
    });
    expect(priceInclusiveGst("abc", 18)).toBe(0);
  });
});
