/**
 * The reference document is docs/ITPI-35 (1).pdf — the format Kartik supplied.
 * Its four lines and four totals are the fixture below, and they are the only
 * externally-verified numbers this feature has. If these break, the quotation
 * no longer matches what the business signed off.
 */
import { describe, expect, it } from "vitest";
import { computeTotals, lineGstAmount, rateSuffix, toPaise } from "../tax";

/** Haryana. iTarang ships from Gurugram, so this is the seller's state. */
const HARYANA = "06";
/** Uttarakhand — ITPI-35's place of supply, and therefore an inter-state supply. */
const UTTARAKHAND = "05";

/** The four lines exactly as printed on ITPI-35. */
const ITPI_35_LINES = [
  { description: "Trontek Li Battery Pack 51v 105Ah", amount: 660_000, gstRatePct: 18 },
  { description: "Trontek EV Charger 48V 25Amp", amount: 97_500, gstRatePct: 5 },
  { description: "LCD Display with Box", amount: 9_000, gstRatePct: 18 },
  { description: "IOT (2 year subscription)", amount: 75_000, gstRatePct: 18 },
];

describe("computeTotals — reproduces ITPI-35", () => {
  const result = computeTotals({
    lines: ITPI_35_LINES,
    sellerStateCode: HARYANA,
    placeOfSupplyStateCode: UTTARAKHAND,
  });

  it("totals the lines to the printed sub total", () => {
    expect(result.subTotal).toBe(841_500);
  });

  it("is an inter-state supply, so IGST and not CGST+SGST", () => {
    expect(result.isIntraState).toBe(false);
    expect(result.taxRows.every((r) => r.label.startsWith("IGST"))).toBe(true);
  });

  it("emits one row per distinct rate, highest first", () => {
    // Three 18% lines and one 5% line produce exactly two rows on the document.
    expect(result.taxRows).toEqual([
      { label: "IGST18 (18%)", amount: 133_920 },
      { label: "IGST5 (5%)", amount: 4_875 },
    ]);
  });

  it("reaches the printed grand total", () => {
    expect(result.total).toBe(980_295);
    expect(result.subTotal + result.taxTotal).toBe(result.total);
  });

  it("reports no unset tax, because every line carries a rate", () => {
    expect(result.hasUnsetTax).toBe(false);
  });
});

describe("computeTotals — intra-state supply splits into CGST + SGST", () => {
  const result = computeTotals({
    lines: ITPI_35_LINES,
    sellerStateCode: HARYANA,
    placeOfSupplyStateCode: HARYANA,
  });

  it("names the two halves at half the rate each", () => {
    expect(result.isIntraState).toBe(true);
    expect(result.taxRows.map((r) => r.label)).toEqual([
      "CGST9 (9%)",
      "SGST9 (9%)",
      "CGST2.5 (2.5%)",
      "SGST2.5 (2.5%)",
    ]);
  });

  it("totals identically to the IGST form — only the registers differ", () => {
    const igst = computeTotals({
      lines: ITPI_35_LINES,
      sellerStateCode: HARYANA,
      placeOfSupplyStateCode: UTTARAKHAND,
    });
    expect(result.total).toBe(igst.total);
    expect(result.taxTotal).toBe(igst.taxTotal);
  });

  it("gives the rounding remainder to SGST so the halves sum exactly", () => {
    // 3 x 1.00 at 5% = 0.15 tax; halving gives 0.07 / 0.08, not 0.08 / 0.08.
    const odd = computeTotals({
      lines: [{ amount: 3, gstRatePct: 5 }],
      sellerStateCode: HARYANA,
      placeOfSupplyStateCode: HARYANA,
    });
    const [cgst, sgst] = odd.taxRows;
    expect(toPaise(cgst.amount + sgst.amount)).toBe(0.15);
    expect(cgst.amount).toBe(0.07);
    expect(sgst.amount).toBe(0.08);
  });
});

describe("an unset rate is not a zero rate", () => {
  it("contributes no tax and raises hasUnsetTax", () => {
    const result = computeTotals({
      lines: [
        { amount: 1_000, gstRatePct: 18 },
        { amount: 500, gstRatePct: null },
      ],
      sellerStateCode: HARYANA,
      placeOfSupplyStateCode: UTTARAKHAND,
    });

    expect(result.hasUnsetTax).toBe(true);
    expect(result.subTotal).toBe(1_500);
    // The untaxed 500 is still in the sub-total; it just carries no tax row.
    expect(result.taxRows).toEqual([{ label: "IGST18 (18%)", amount: 180 }]);
    expect(result.total).toBe(1_680);
  });

  it("distinguishes an explicit 0% from an unset rate", () => {
    const zeroRated = computeTotals({
      lines: [{ amount: 1_000, gstRatePct: 0 }],
      sellerStateCode: HARYANA,
      placeOfSupplyStateCode: UTTARAKHAND,
    });
    // An explicit zero rate is a claim we were told to make: it earns a row.
    expect(zeroRated.hasUnsetTax).toBe(false);
    expect(zeroRated.taxRows).toEqual([{ label: "IGST0 (0%)", amount: 0 }]);

    const unset = computeTotals({
      lines: [{ amount: 1_000, gstRatePct: null }],
      sellerStateCode: HARYANA,
      placeOfSupplyStateCode: UTTARAKHAND,
    });
    expect(unset.hasUnsetTax).toBe(true);
    expect(unset.taxRows).toEqual([]);
  });

  it("treats a NaN rate as unset rather than as tax of NaN", () => {
    const result = computeTotals({
      lines: [{ amount: 1_000, gstRatePct: Number.NaN }],
      sellerStateCode: HARYANA,
      placeOfSupplyStateCode: UTTARAKHAND,
    });
    expect(result.hasUnsetTax).toBe(true);
    expect(result.total).toBe(1_000);
  });
});

describe("an unknown place of supply falls back to inter-state", () => {
  it("uses IGST rather than naming a state it does not know", () => {
    const result = computeTotals({
      lines: [{ amount: 1_000, gstRatePct: 18 }],
      sellerStateCode: HARYANA,
      placeOfSupplyStateCode: null,
    });
    expect(result.isIntraState).toBe(false);
    expect(result.taxRows[0].label).toBe("IGST18 (18%)");
  });

  it("does not treat an empty string as a match for the seller state", () => {
    const result = computeTotals({
      lines: [{ amount: 1_000, gstRatePct: 18 }],
      sellerStateCode: HARYANA,
      placeOfSupplyStateCode: "   ",
    });
    expect(result.isIntraState).toBe(false);
  });
});

describe("line arithmetic", () => {
  it("matches every IGST amount printed on ITPI-35", () => {
    expect(lineGstAmount(660_000, 18)).toBe(118_800);
    expect(lineGstAmount(97_500, 5)).toBe(4_875);
    expect(lineGstAmount(9_000, 18)).toBe(1_620);
    expect(lineGstAmount(75_000, 18)).toBe(13_500);
  });

  it("returns null for an unset rate", () => {
    expect(lineGstAmount(1_000, null)).toBeNull();
  });

  it("formats a rate the way the totals block labels it", () => {
    expect(rateSuffix(18)).toBe("18");
    expect(rateSuffix(2.5)).toBe("2.5");
  });
});
