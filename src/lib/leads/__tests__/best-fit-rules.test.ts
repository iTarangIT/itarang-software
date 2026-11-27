import { describe, expect, it } from "vitest";

import { rankBestFit, type BestFitCandidate } from "../best-fit-rules";

const c = (nbfcId: number, loanProductId: number, minRoiPct: number, extra: Partial<BestFitCandidate> = {}): BestFitCandidate => ({
  nbfcId,
  nbfcName: `NBFC${nbfcId}`,
  loanProductId,
  productName: `P${loanProductId}`,
  minRoiPct,
  processingFeeRupees: null,
  fileChargeFixedRupees: null,
  disbursementTatHours: null,
  ...extra,
});

describe("rankBestFit", () => {
  // The four options from the 27 Nov screenshot (Robin Kumar, Nashik).
  const screenshot = [
    c(1, 10, 12.5), // Bajaj — E-Rickshaw Finance 2026
    c(1, 11, 12.5), // Bajaj — treawgf
    c(2, 20, 14), // xyz finance — Test Loan Product
    c(3, 30, 16), // Electro F — Diwali Offer 2
  ];

  it("with no other signal, picks the lowest interest rate, ties to the older product", () => {
    const r = rankBestFit(screenshot);
    expect(r[0].loanProductId).toBe(10);
    expect(r[0].reason).toBe("lowest interest rate (from 12.5%) among 4 fitting products");
  });

  it("a pinned default beats everything", () => {
    const r = rankBestFit(screenshot, { pinnedKey: "3:30" });
    expect(r[0].loanProductId).toBe(30);
    expect(r[0].reason).toContain("default loan product");
  });

  it("the dealer's approval history beats a cheaper rate", () => {
    const history = new Map([[2, { approved: 3, sent: 4 }]]);
    const r = rankBestFit(screenshot, { history });
    expect(r[0].nbfcId).toBe(2);
    expect(r[0].reason).toBe("NBFC2 approved 3 earlier files from this dealer");
  });

  it("same rate → lower upfront charges, then faster TAT", () => {
    const r = rankBestFit([
      c(1, 1, 12, { processingFeeRupees: 2500, disbursementTatHours: 24 }),
      c(2, 2, 12, { processingFeeRupees: 1000, disbursementTatHours: 72 }),
    ]);
    expect(r[0].nbfcId).toBe(2);
    const t = rankBestFit([c(1, 1, 12, { disbursementTatHours: 72 }), c(2, 2, 12, { disbursementTatHours: 24 })]);
    expect(t[0].nbfcId).toBe(2);
  });

  it("one candidate is simply the only fit; none → empty", () => {
    expect(rankBestFit([c(1, 1, 12)])[0].reason).toBe("the only loan product that fits this lead");
    expect(rankBestFit([])).toEqual([]);
  });
});

describe("rankBestFit reason", () => {
  it("explains against a lender with a different name (one lender can be two NBFC records)", () => {
    const r = rankBestFit([
      c(1, 1, 12.5, { nbfcName: "Bajaj Finance" }),
      c(9, 2, 12.5, { nbfcName: "Bajaj Finance" }),
      c(2, 3, 14, { nbfcName: "xyz" }),
    ]);
    expect(r[0].reason).toBe("lowest interest rate (from 12.5%) among 3 fitting products");
  });
});
