import { describe, expect, it } from "vitest";

import {
  ROW_DESC_MAX,
  ROW_TITLE_MAX,
  downPaymentText,
  loanRange,
  num,
  optionLabel,
  pctRange,
  productLines,
  range,
  rowDescription,
  rowTitle,
} from "../scheme-format";

const product = {
  loanAmountMin: 30000,
  loanAmountMax: 73999,
  tenureMonthsMin: 12,
  tenureMonthsMax: 12,
  minRoiPct: "14.00",
  maxRoiPct: "14.00",
  downPaymentPct: "0.00",
};

describe("num", () => {
  it("strips the trailing zeros a numeric(x,2) column always carries", () => {
    expect(num("20.00")).toBe("20");
    expect(num("11.10")).toBe("11.1");
    expect(num(14)).toBe("14");
  });

  it("does NOT round — a down payment is money the customer actually pays", () => {
    expect(num("11.11")).toBe("11.11");
  });

  it("never renders NaN into a customer's message", () => {
    expect(num(null)).toBe("—");
    expect(num("")).toBe("—");
    expect(num("n/a")).toBe("n/a");
  });
});

describe("range / pctRange / loanRange", () => {
  it("collapses a band whose ends are equal", () => {
    // This is the defect from the report: "12–12 months" and "20.00–20.00%".
    expect(range(12, 12, "months")).toBe("12 months");
    expect(pctRange("20.00", "20.00")).toBe("20%");
    expect(loanRange(30000, 30000)).toBe("₹30,000");
  });

  it("keeps a genuine band", () => {
    expect(range(12, 24, "months")).toBe("12–24 months");
    expect(pctRange("14.00", "18.50")).toBe("14–18.5%");
    expect(loanRange(30000, 73999)).toBe("₹30,000–₹73,999");
  });
});

describe("downPaymentText", () => {
  it("says zero positively — '0% down payment' reads like a missing value", () => {
    expect(downPaymentText("0.00")).toBe("No down payment");
    expect(downPaymentText(0)).toBe("No down payment");
    expect(downPaymentText(null)).toBe("No down payment");
  });

  it("states a real down payment exactly", () => {
    expect(downPaymentText("11.11")).toBe("11.11% down payment");
    expect(downPaymentText("15.00")).toBe("15% down payment");
  });
});

describe("optionLabel / rowTitle", () => {
  it("labels products positionally, never by name", () => {
    expect(optionLabel(0)).toBe("Option A");
    expect(optionLabel(1)).toBe("Option B");
    expect(optionLabel(25)).toBe("Option Z");
    expect(optionLabel(26)).toBe("Option 27");
  });

  it("gives two products of ONE lender different row titles", () => {
    // The shipped bug: both rows were titled with the scheme alone, so a lender
    // offering two products produced two identical rows.
    expect(rowTitle(0, 0)).not.toBe(rowTitle(0, 1));
    expect(rowTitle(0, 0)).toBe("Scheme 1 · Option A");
  });

  it("stays inside Meta's 24-char row-title cap at the worst case", () => {
    for (let scheme = 0; scheme < 10; scheme += 1) {
      for (let opt = 0; opt < 26; opt += 1) {
        expect(rowTitle(scheme, opt).length).toBeLessThanOrEqual(ROW_TITLE_MAX);
      }
    }
  });
});

describe("rowDescription", () => {
  it("carries the terms that differ, inside the 72-char cap", () => {
    const d = rowDescription(product);
    expect(d).toBe("14% · 12 months · no down payment");
    expect(d.length).toBeLessThanOrEqual(ROW_DESC_MAX);
  });

  it("stays inside the cap on a wide band", () => {
    const wide = {
      ...product,
      tenureMonthsMin: 12,
      tenureMonthsMax: 60,
      minRoiPct: "13.25",
      maxRoiPct: "27.75",
      downPaymentPct: "22.22",
    };
    expect(rowDescription(wide).length).toBeLessThanOrEqual(ROW_DESC_MAX);
  });
});

describe("masking", () => {
  // The whole point of this module. `productName` is NOT one of its inputs, so
  // a lender's brand cannot reach a rendered string even by accident — this test
  // is what stops someone re-adding it "just for clarity", which is exactly how
  // the leak got in the first time.
  it("renders nothing derived from the lender or its product name", () => {
    const rendered = [
      productLines(product, 0),
      rowTitle(0, 0),
      rowDescription(product),
    ].join(" ");
    for (const brand of ["Bajaj", "Finserv", "NBFC-", "iTarang Finance"]) {
      expect(rendered).not.toContain(brand);
    }
  });

  it("puts the option label and the numbers in the body", () => {
    const lines = productLines(product, 1);
    expect(lines).toContain("Option B");
    expect(lines).toContain("14%");
    expect(lines).toContain("12 months");
    expect(lines).toContain("No down payment");
    expect(lines).toContain("₹30,000–₹73,999");
  });
});
