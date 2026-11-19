import { describe, expect, it } from "vitest";

import {
  askedDocs,
  canSkip,
  DEFAULT_CUSTOMER_DOC_CONFIG,
  docsSatisfied,
  kycKeyForWa,
  MANDATORY_CUSTOMER_DOCS,
  normalizeCustomerDocConfig,
  outstandingDocs,
  validateSkip,
} from "../customer-doc-rules";

describe("E-392 customer KYC documents — what is asked", () => {
  it("Aadhaar front/back and PAN are always asked", () => {
    expect(MANDATORY_CUSTOMER_DOCS).toEqual(["aadhaar_front", "aadhaar_back", "pan_card"]);
    expect(askedDocs({ enabled: [] })).toEqual(["aadhaar_front", "aadhaar_back", "pan_card"]);
  });
  it("defaults to today's required set (photo + RC)", () => {
    expect(askedDocs(DEFAULT_CUSTOMER_DOC_CONFIG)).toEqual(["aadhaar_front", "aadhaar_back", "pan_card", "passport_photo", "rc_copy"]);
  });
  it("keeps only known configurable keys, in catalogue order", () => {
    expect(normalizeCustomerDocConfig({ enabled: ["rc_copy", "pan_card", "nope", "cheque_1"] })).toEqual({ enabled: ["rc_copy", "cheque_1"] });
    expect(normalizeCustomerDocConfig(null)).toEqual(DEFAULT_CUSTOMER_DOC_CONFIG);
  });
});

describe("E-392 customer KYC documents — skipping", () => {
  it("mandatory documents can never be skipped", () => {
    expect(canSkip("aadhaar_front")).toBe(false);
    expect(canSkip("pan_card")).toBe(false);
    expect(validateSkip("pan_card", "lost it").ok).toBe(false);
  });
  it("other documents need a reason", () => {
    expect(validateSkip("rc_copy", " ").ok).toBe(false);
    expect(validateSkip("rc_copy", "New vehicle, RC not issued yet").ok).toBe(true);
    expect(validateSkip("unknown_doc", "x y z").ok).toBe(false);
  });
  it("a skip satisfies an optional document but never a mandatory one", () => {
    const asked = ["aadhaar_front", "aadhaar_back", "pan_card", "rc_copy"];
    expect(docsSatisfied({ asked, uploaded: ["aadhaar_front", "aadhaar_back", "pan_card"], skipped: ["rc_copy"] })).toBe(true);
    expect(outstandingDocs({ asked, uploaded: ["aadhaar_front", "aadhaar_back"], skipped: ["pan_card", "rc_copy"] })).toEqual(["pan_card"]);
  });
  it("maps WhatsApp names to KYC keys", () => {
    expect(kycKeyForWa("customer_photo")).toBe("passport_photo");
    expect(kycKeyForWa("cancelled_cheque")).toBe("cheque_1");
    expect(kycKeyForWa("rc_copy")).toBe("rc_copy");
  });
});
