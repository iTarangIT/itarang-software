/**
 * These tests exist because of a bug that shipped and was found by rendering a
 * real quotation on sandbox, not by a unit test.
 *
 * Place of supply came from `states.code`, which holds POSTAL alpha codes
 * ('MH', 'HR'), while the seller's code comes from our GSTIN as '06'. The
 * equality that decides IGST vs CGST+SGST could therefore never be true, and a
 * Haryana dealer would have been charged IGST on an intra-state sale. The tax
 * maths in ../tax was correct throughout — it was being handed the wrong kind
 * of code — which is exactly why the assertion that matters here is on the
 * SEAM, not on the arithmetic.
 */
import { describe, expect, it } from "vitest";
import { gstStateCode, gstStateName, resolvePlaceOfSupply } from "../gst-states";
import { computeTotals } from "../tax";

/** iTarang ships from Gurugram; every quotation is compared against this. */
const SELLER = "06";

describe("gstStateCode", () => {
  it("returns the statutory numeric code, never an alpha one", () => {
    expect(gstStateCode("Maharashtra")).toBe("27");
    expect(gstStateCode("Haryana")).toBe("06");
    // ITPI-35 prints "Uttarakhand (05)" — the one externally-verified pairing.
    expect(gstStateCode("Uttarakhand")).toBe("05");
  });

  it("covers all 36 jurisdictions in force", () => {
    const codes = new Set(
      [
        "Jammu and Kashmir", "Himachal Pradesh", "Punjab", "Chandigarh",
        "Uttarakhand", "Haryana", "Delhi", "Rajasthan", "Uttar Pradesh",
        "Bihar", "Sikkim", "Arunachal Pradesh", "Nagaland", "Manipur",
        "Mizoram", "Tripura", "Meghalaya", "Assam", "West Bengal", "Jharkhand",
        "Odisha", "Chhattisgarh", "Madhya Pradesh", "Gujarat",
        "Dadra and Nagar Haveli and Daman and Diu", "Maharashtra", "Karnataka",
        "Goa", "Lakshadweep", "Kerala", "Tamil Nadu", "Puducherry",
        "Andaman and Nicobar Islands", "Telangana", "Andhra Pradesh", "Ladakh",
      ].map((n) => gstStateCode(n)),
    );
    expect(codes.has(null)).toBe(false);
    expect(codes.size).toBe(36);
  });

  it("folds the spellings a free-text CRM field actually contains", () => {
    expect(gstStateCode("  maharashtra ")).toBe("27");
    expect(gstStateCode("Orissa")).toBe("21");
    expect(gstStateCode("Pondicherry")).toBe("34");
    expect(gstStateCode("Uttaranchal")).toBe("05");
    expect(gstStateCode("Jammu & Kashmir")).toBe("01");
    expect(gstStateCode("NCT of Delhi")).toBe("07");
  });

  it("retires the codes that no longer exist rather than mapping them", () => {
    // 28 was undivided Andhra Pradesh; a GSTIN issued today says 37.
    expect(gstStateCode("Andhra Pradesh")).toBe("37");
    // 25 was Daman and Diu; the merged UT is 26.
    expect(gstStateCode("Daman and Diu")).toBe("26");
  });

  it("returns null for anything unrecognised rather than guessing", () => {
    expect(gstStateCode("Atlantis")).toBeNull();
    expect(gstStateCode("")).toBeNull();
    expect(gstStateCode(null)).toBeNull();
    // The alpha codes the `states` table holds are NOT accepted — accepting
    // them would re-open the door the numeric codes exist to close.
    expect(gstStateCode("MH")).toBeNull();
  });
});

describe("gstStateName", () => {
  it("round-trips a code back to its printed name", () => {
    expect(gstStateName("27")).toBe("Maharashtra");
    expect(gstStateName("06")).toBe("Haryana");
    expect(gstStateName("99")).toBeNull();
  });
});

describe("resolvePlaceOfSupply", () => {
  it("labels the document the way a GST document must: name and NUMERIC code", () => {
    expect(resolvePlaceOfSupply("Maharashtra")).toEqual({
      stateCode: "27",
      label: "Maharashtra (27)",
    });
  });

  it("prefers the dealer's GSTIN over the lead's free-text state", () => {
    // The registration is the place of supply for a B2B sale; `state` is a CRM
    // field nobody validates, so when they disagree the GSTIN wins.
    expect(resolvePlaceOfSupply("Maharashtra", "06AALFI7813E1ZE")).toEqual({
      stateCode: "06",
      label: "Haryana (06)",
    });
  });

  it("falls back to the state name when the GSTIN is absent or malformed", () => {
    expect(resolvePlaceOfSupply("Kerala", null).stateCode).toBe("32");
    expect(resolvePlaceOfSupply("Kerala", "not-a-gstin").stateCode).toBe("32");
  });

  it("still prints an unrecognised state, without inventing a code", () => {
    expect(resolvePlaceOfSupply("Atlantis")).toEqual({
      stateCode: null,
      label: "Atlantis",
    });
    expect(resolvePlaceOfSupply(null)).toEqual({ stateCode: null, label: null });
  });

  it("keeps label and code consistent for a code outside the table", () => {
    // A jurisdiction added after this list was written: trust the GSTIN's code,
    // print whatever the lead called it.
    expect(resolvePlaceOfSupply("Newland", "40AAAAA0000A1Z5")).toEqual({
      stateCode: "40",
      label: "Newland (40)",
    });
  });
});

describe("the seam that broke: place of supply feeding computeTotals", () => {
  const LINES = [{ amount: 100_000, gstRatePct: 18 }];

  it("taxes a Haryana dealer as INTRA-state — the case that was wrong", () => {
    const pos = resolvePlaceOfSupply("Haryana");
    const t = computeTotals({
      lines: LINES,
      sellerStateCode: SELLER,
      placeOfSupplyStateCode: pos.stateCode,
    });
    expect(t.isIntraState).toBe(true);
    // CGST + SGST at half each, not one IGST row.
    expect(t.taxRows).toHaveLength(2);
    expect(t.total).toBe(118_000);
  });

  it("taxes a Maharashtra dealer as inter-state", () => {
    const pos = resolvePlaceOfSupply("Maharashtra");
    const t = computeTotals({
      lines: LINES,
      sellerStateCode: SELLER,
      placeOfSupplyStateCode: pos.stateCode,
    });
    expect(t.isIntraState).toBe(false);
    expect(t.taxRows).toHaveLength(1);
    expect(t.total).toBe(118_000);
  });

  it("would have failed before the fix: an alpha code never equals '06'", () => {
    // 'HR' is what states.code held. This is the exact comparison that made
    // every supply inter-state.
    const t = computeTotals({
      lines: LINES,
      sellerStateCode: SELLER,
      placeOfSupplyStateCode: "HR",
    });
    expect(t.isIntraState).toBe(false);
  });
});
