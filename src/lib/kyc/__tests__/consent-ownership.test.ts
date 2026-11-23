import { describe, expect, it } from "vitest";

import { compareNames, consentBelongsToFile } from "../consent-ownership";

const file = { leadId: "LEAD-20261120-d476195a", names: ["Ramesh Kumar Patil"], consentIds: ["CONSENT-20261120-0042"] };

describe("consentBelongsToFile", () => {
  it("matches on the printed lead id", () => {
    expect(consentBelongsToFile({ leadId: "LEAD-20261120-d476195a", customerName: "Ramesh Kumar Patil" }, file).ownership).toBe("match");
  });

  it("forgives one misread character when the name agrees", () => {
    expect(consentBelongsToFile({ leadId: "LEAD-20261120-d476I95a", customerName: "Ramesh Patil" }, file).ownership).toBe("match");
  });

  it("refuses another file's consent (different lead id)", () => {
    const r = consentBelongsToFile({ leadId: "LEAD-20261120-3452b012", customerName: "Ramesh Kumar Patil" }, file);
    expect(r.ownership).toBe("mismatch");
    expect(r.note).toContain("LEAD-20261120-3452b012");
  });

  it("refuses a one-character id difference when the name is someone else", () => {
    expect(consentBelongsToFile({ leadId: "LEAD-20261120-d476195b", customerName: "Sunita Deshmukh" }, file).ownership).toBe("mismatch");
  });

  it("falls back to the consent ref, then the name", () => {
    expect(consentBelongsToFile({ consentRef: "CONSENT-20261120-0042" }, file).ownership).toBe("match");
    expect(consentBelongsToFile({ customerName: "MR. RAMESH PATIL" }, file).ownership).toBe("match");
    expect(consentBelongsToFile({ customerName: "Sunita Deshmukh" }, file).ownership).toBe("mismatch");
  });

  it("is unconfirmed when nothing is readable (blank name line)", () => {
    expect(consentBelongsToFile({ customerName: "_______________" }, file).ownership).toBe("unconfirmed");
    expect(consentBelongsToFile({}, file).ownership).toBe("unconfirmed");
  });
});

describe("compareNames", () => {
  it("handles order, case, honorifics and one typo", () => {
    expect(compareNames("patil ramesh", "Ramesh Kumar Patil")).toBe("same");
    expect(compareNames("Ramesh Kumaar Patil", "Ramesh Kumar Patil")).toBe("same");
    expect(compareNames("Ramesh Joshi", "Ramesh Kumar Patil")).toBe("different");
    expect(compareNames("", "Ramesh")).toBe("unknown");
  });
});
