import { describe, expect, it } from "vitest";

import {
  CONDITION_DOCS,
  describeConditions,
  groupConditionDocs,
  normaliseConditionDocs,
} from "../condition-docs";

describe("condition docs (E-393)", () => {
  it("keeps only known keys, de-duplicated, in catalogue order", () => {
    expect(normaliseConditionDocs(["cb_pan", "rc_copy", "nope", "rc_copy", 5])).toEqual(["rc_copy", "cb_pan"]);
    expect(normaliseConditionDocs("rc_copy")).toEqual([]);
  });

  it("splits picks into the primary and co-borrower requests", () => {
    const g = groupConditionDocs(["rc_copy", "cb_aadhaar", "cb_pan"]);
    expect(g.primary.map((d) => d.key)).toEqual(["rc_copy"]);
    expect(g.co_borrower.map((d) => d.key)).toEqual(["cb_aadhaar", "cb_pan"]);
  });

  it("describes docs + note, either alone, or nothing", () => {
    expect(describeConditions(["rc_copy"], "Max 12 months")).toBe("Documents required: RC Copy. Max 12 months");
    expect(describeConditions([], " note ")).toBe("note");
    expect(describeConditions([], null)).toBeNull();
  });

  it("has unique keys and both parties covered (RC + co-borrower)", () => {
    const keys = CONDITION_DOCS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("rc_copy");
    expect(CONDITION_DOCS.some((d) => d.docFor === "co_borrower")).toBe(true);
  });
});
