/**
 * M02/M03/M04 — the gate that decides whether a request reaches the review queue.
 *
 * It is the same pure function the intake uses to explain a disabled Submit
 * button, so a wrong answer here is wrong in two places at once. Both
 * directions are tested: a gate that refuses honest data strands the dealer in
 * DRAFT (which is how 24 of the first 32 requests died), and a gate that lets
 * incomplete data through puts unpriceable batteries in front of an admin.
 */

import { describe, expect, it } from "vitest";

import { checkSubmitReadiness, missingSpecFields, type GateLine } from "../submit-gate";

/** A line that passes every rule — each test spoils exactly one thing. */
function completeLine(over: Partial<GateLine> = {}): GateLine {
  return {
    id: "l1",
    label: "60V 120Ah · Working ×10",
    quantity: 10,
    photo_count: 5,
    has_provenance: true,
    brand: "Exide",
    chemistry: "LFP",
    nominal_voltage: 60,
    nominal_ampere: 120,
    unit_weight_kg: 12.5,
    iot_battery: false,
    iot_brand_name: null,
    functional_qty: null,
    non_functional_qty: null,
    ...over,
  };
}

describe("a complete line submits", () => {
  it("raises no issues", () => {
    const r = checkSubmitReadiness([completeLine()]);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses a request with no lines at all", () => {
    const r = checkSubmitReadiness([]);
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe("NO_LINES");
  });
});

describe("the 5-photo minimum still holds", () => {
  // This is what actually stranded the drafts. It stays: the photos feed the
  // M03 perceptual-hash dedup that catches a battery relisted across dealers.
  it("blocks a line short on photos and says how short", () => {
    const r = checkSubmitReadiness([completeLine({ photo_count: 2 })]);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === "TOO_FEW_PHOTOS")!;
    expect(issue.message).toContain("2 of 5");
  });

  it("accepts more than the minimum", () => {
    expect(checkSubmitReadiness([completeLine({ photo_count: 9 })]).ok).toBe(true);
  });
});

describe("the IOT brand name is not required", () => {
  // A dealer reselling a second-hand pack often cannot know who made the IOT
  // module. Requiring it bought guesses; blank now resolves to Intellicar at
  // write time instead of blocking the submit.
  it("submits an IOT battery with no brand named", () => {
    const r = checkSubmitReadiness([
      completeLine({ iot_battery: true, iot_brand_name: null }),
    ]);
    expect(r.ok).toBe(true);
    expect(missingSpecFields(completeLine({ iot_battery: true, iot_brand_name: null })))
      .toEqual([]);
  });

  it("still requires the IOT yes/no answer itself", () => {
    const missing = missingSpecFields(completeLine({ iot_battery: null }));
    expect(missing).toContain("IOT battery (yes/no)");
  });
});

describe("the functional / non-functional split must not exceed the quantity", () => {
  it("allows a partially tested lot — the remainder is unclassified", () => {
    // 5 working + 3 dead out of 10, 2 untested. Truthful, and rejected before
    // E-194 because the rule demanded equality rather than a ceiling.
    const r = checkSubmitReadiness([
      completeLine({ functional_qty: 5, non_functional_qty: 3 }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("allows a fully classified lot", () => {
    const r = checkSubmitReadiness([
      completeLine({ functional_qty: 6, non_functional_qty: 4 }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("blocks a split that exceeds the quantity", () => {
    const r = checkSubmitReadiness([
      completeLine({ functional_qty: 6, non_functional_qty: 6 }),
    ]);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === "QTY_SPLIT_MISMATCH")!;
    expect(issue.message).toContain("cannot exceed");
  });

  it("blocks one declared side exceeding the quantity on its own", () => {
    const r = checkSubmitReadiness([completeLine({ functional_qty: 11 })]);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "QTY_SPLIT_MISMATCH")).toBe(true);
  });

  it("treats a zero split as declared, not absent", () => {
    // 0 + 0 out of 10 is within the ceiling: nothing tested yet.
    const r = checkSubmitReadiness([
      completeLine({ functional_qty: 0, non_functional_qty: 0 }),
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("missing specs and provenance are reported per line", () => {
  it("names every missing required field", () => {
    const missing = missingSpecFields(
      completeLine({ brand: null, chemistry: null, unit_weight_kg: null }),
    );
    expect(missing).toEqual(["brand", "chemistry (NMC/LFP)", "unit weight (kg)"]);
  });

  it("treats a whitespace-only brand as missing", () => {
    expect(missingSpecFields(completeLine({ brand: "   " }))).toContain("brand");
  });

  it("blocks a line with no provenance", () => {
    const r = checkSubmitReadiness([completeLine({ has_provenance: false })]);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "MISSING_PROVENANCE")).toBe(true);
  });

  it("attributes each issue to the line it came from", () => {
    const r = checkSubmitReadiness([
      completeLine({ id: "good" }),
      completeLine({ id: "bad", photo_count: 0 }),
    ]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].line_id).toBe("bad");
  });
});
