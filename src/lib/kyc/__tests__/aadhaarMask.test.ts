import { describe, expect, it } from "vitest";

import {
  isMaskedAadhaar,
  maskAadhaar,
  maskAadhaarDeep,
  restoreMaskedAadhaar,
  restoreMaskedAadhaarDeep,
} from "../aadhaarMask";

describe("maskAadhaar (ID 119)", () => {
  it("shows only the last four digits", () => {
    expect(maskAadhaar("123456789012")).toBe("XXXX XXXX 9012");
    expect(maskAadhaar("1234 5678 9012")).toBe("XXXX XXXX 9012");
    expect(maskAadhaar(123456789012)).toBe("XXXX XXXX 9012");
  });

  it("keeps empty as null and a mask as is", () => {
    expect(maskAadhaar(null)).toBeNull();
    expect(maskAadhaar(undefined)).toBeNull();
    expect(maskAadhaar("  ")).toBeNull();
    expect(maskAadhaar("XXXX XXXX 9012")).toBe("XXXX XXXX 9012");
  });

  it("never leaks a short value", () => {
    expect(maskAadhaar("12")).toBe("XXXX XXXX XXXX");
  });

  it("recognises its own mask and Digio's, not a real number", () => {
    expect(isMaskedAadhaar("XXXX XXXX 9012")).toBe(true);
    expect(isMaskedAadhaar("XXXXXXXX9012")).toBe(true);
    expect(isMaskedAadhaar("123456789012")).toBe(false);
    expect(isMaskedAadhaar("")).toBe(false);
    expect(isMaskedAadhaar(null)).toBe(false);
  });
});

describe("maskAadhaarDeep", () => {
  it("masks Aadhaar-keyed 12-digit values at any depth and nothing else", () => {
    const draft = {
      borrowerForm: { aadhaar_no: "123456789012", phone: "9876543210", pan_no: "ABCDE1234F" },
      customer: [{ aadhaarNumber: "1111 2222 3333" }],
      documents: { aadhaar_front: "https://x/aadhaar_front.jpg" },
      progress: { docsUploaded: 3 },
    };
    expect(maskAadhaarDeep(draft)).toEqual({
      borrowerForm: { aadhaar_no: "XXXX XXXX 9012", phone: "9876543210", pan_no: "ABCDE1234F" },
      customer: [{ aadhaarNumber: "XXXX XXXX 3333" }],
      documents: { aadhaar_front: "https://x/aadhaar_front.jpg" },
      progress: { docsUploaded: 3 },
    });
    // input untouched
    expect(draft.borrowerForm.aadhaar_no).toBe("123456789012");
  });

  it("passes null and primitives through", () => {
    expect(maskAadhaarDeep(null)).toBeNull();
    expect(maskAadhaarDeep("x")).toBe("x");
  });
});

describe("restoring a mask on save", () => {
  it("keeps the stored number when the mask comes back", () => {
    expect(restoreMaskedAadhaar("XXXX XXXX 9012", "123456789012")).toBe("123456789012");
    expect(restoreMaskedAadhaar("999988887777", "123456789012")).toBe("999988887777");
    expect(restoreMaskedAadhaar("XXXX XXXX 9012", undefined)).toBeNull();
  });

  it("restores by path inside a draft blob", () => {
    const stored = { borrowerForm: { aadhaar_no: "123456789012", phone: "1" } };
    const incoming = { step: 3, borrowerForm: { aadhaar_no: "XXXX XXXX 9012", phone: "2" } };
    expect(restoreMaskedAadhaarDeep(incoming, stored)).toEqual({
      step: 3,
      borrowerForm: { aadhaar_no: "123456789012", phone: "2" },
    });
    // a newly typed number wins
    const typed = { borrowerForm: { aadhaar_no: "999988887777" } };
    expect(restoreMaskedAadhaarDeep(typed, stored)).toEqual(typed);
    // nothing stored: the mask is not saved
    expect(restoreMaskedAadhaarDeep(incoming, null)).toEqual({
      step: 3,
      borrowerForm: { aadhaar_no: null, phone: "2" },
    });
  });
});
