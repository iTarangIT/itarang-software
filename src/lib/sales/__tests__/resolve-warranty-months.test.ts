import { describe, expect, it } from "vitest";

import { DEFAULT_WARRANTY_MONTHS, resolveWarrantyMonths } from "../warranty-months";

describe("resolveWarrantyMonths", () => {
  it("prefers the inventory row's own duration", () => {
    expect(
      resolveWarrantyMonths({
        inventory_warranty_months: 36,
        product_warranty_months: 12,
        oem_warranty_months: 18,
      }),
    ).toBe(36);
  });

  it("treats zero as unknown, not as no-warranty (the stubbed-product bug)", () => {
    expect(
      resolveWarrantyMonths({
        inventory_warranty_months: 0,
        product_warranty_months: 0,
        oem_warranty_months: null,
      }),
    ).toBe(DEFAULT_WARRANTY_MONTHS);
    expect(
      resolveWarrantyMonths({ inventory_warranty_months: 0, product_warranty_months: 24 }),
    ).toBe(24);
  });

  it("falls through inventory → product → OEM → default", () => {
    expect(
      resolveWarrantyMonths({ inventory_warranty_months: null, product_warranty_months: null, oem_warranty_months: 18 }),
    ).toBe(18);
    expect(resolveWarrantyMonths({})).toBe(DEFAULT_WARRANTY_MONTHS);
  });

  it("ignores negative and non-finite values", () => {
    expect(
      resolveWarrantyMonths({ inventory_warranty_months: -3, product_warranty_months: Number.NaN }),
    ).toBe(DEFAULT_WARRANTY_MONTHS);
  });
});
