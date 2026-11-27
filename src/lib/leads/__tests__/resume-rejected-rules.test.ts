import { describe, expect, it } from "vitest";

import { decideResume } from "../resume-rejected-rules";

const base = {
  paymentMethod: "finance",
  kycStatus: "step_3_cleared",
  assignmentStatuses: ["declined"],
  movedToNewCase: false,
};

describe("decideResume", () => {
  it("allows a finance file an NBFC rejected", () => {
    expect(decideResume(base)).toEqual({ ok: true });
  });

  it("allows it when one lender rejected and another lost (not_selected)", () => {
    expect(decideResume({ ...base, assignmentStatuses: ["declined", "not_selected"] }).ok).toBe(true);
  });

  it("refuses when no NBFC rejected it", () => {
    expect(decideResume({ ...base, assignmentStatuses: [] }).ok).toBe(false);
    expect(decideResume({ ...base, assignmentStatuses: ["withdrawn"] }).ok).toBe(false);
  });

  it("refuses while a lender is still working on it", () => {
    for (const s of ["pending", "in_progress", "offer_submitted", "selected"]) {
      expect(decideResume({ ...base, assignmentStatuses: ["declined", s] }).ok).toBe(false);
    }
  });

  it("accepts every finance variant (27 Nov: other_finance files could not be resumed)", () => {
    for (const pm of ["finance", "other_finance", "dealer_finance", "Other_Finance"]) {
      expect(decideResume({ ...base, paymentMethod: pm }).ok).toBe(true);
    }
  });

  it("refuses cash files, sanctioned files and files already moved to a new case", () => {
    expect(decideResume({ ...base, paymentMethod: "cash" }).ok).toBe(false);
    expect(decideResume({ ...base, kycStatus: "loan_sanctioned" }).ok).toBe(false);
    expect(decideResume({ ...base, movedToNewCase: true }).ok).toBe(false);
  });
});
