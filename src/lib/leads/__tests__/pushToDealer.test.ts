import { describe, expect, it } from "vitest";

import { canUsePushToDealer, tenDigitMobile } from "../pushToDealer";

describe("tenDigitMobile", () => {
  it("normalises the usual Indian formats", () => {
    expect(tenDigitMobile("9876543210")).toBe("9876543210");
    expect(tenDigitMobile("+91 98765 43210")).toBe("9876543210");
    expect(tenDigitMobile("919876543210")).toBe("9876543210");
    expect(tenDigitMobile("09876543210")).toBe("9876543210");
  });
  it("rejects anything that is not a mobile", () => {
    expect(tenDigitMobile("")).toBeNull();
    expect(tenDigitMobile(null)).toBeNull();
    expect(tenDigitMobile("12345")).toBeNull();
    expect(tenDigitMobile("1234567890")).toBeNull();
  });
});

describe("canUsePushToDealer", () => {
  const house = "DLR-HOUSE";
  it("admits internal roles", () => {
    expect(canUsePushToDealer({ role: "admin", dealerId: null, houseDealerCode: house })).toBe(true);
    expect(canUsePushToDealer({ role: "sales_head", dealerId: null, houseDealerCode: house })).toBe(true);
  });
  it("admits the house dealer login only", () => {
    expect(canUsePushToDealer({ role: "dealer", dealerId: house, houseDealerCode: house })).toBe(true);
    expect(canUsePushToDealer({ role: "dealer", dealerId: "DLR-OTHER", houseDealerCode: house })).toBe(false);
    expect(canUsePushToDealer({ role: "dealer", dealerId: house, houseDealerCode: null })).toBe(false);
  });
  it("refuses everyone else", () => {
    expect(canUsePushToDealer({ role: "nbfc_partner", dealerId: null, houseDealerCode: house })).toBe(false);
    expect(canUsePushToDealer({ role: "inside_sales_rep", dealerId: null, houseDealerCode: house })).toBe(false);
  });
});
