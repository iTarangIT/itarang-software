import { describe, it, expect } from "vitest";
import { parseBandFromReview } from "../reviewTextParser";

// The Google Sheet's reviewer columns are free text written by seven different
// people over months. This parser decides which of those cells become GROUND
// TRUTH in intent_score_feedback and which are preserved as commentary.
//
// It is asymmetric on purpose: a false negative costs one training example; a
// false positive plants a label nobody asserted into the golden set, where it
// then trains the model and skews the accuracy number permanently. So every
// ambiguous case must return null.

describe("parseBandFromReview — cells that DO name a band", () => {
  it("reads a bare verdict", () => {
    expect(parseBandFromReview("cold")).toBe("Cold");
    expect(parseBandFromReview("Warm")).toBe("Warm");
    expect(parseBandFromReview("qualified")).toBe("Qualified");
    expect(parseBandFromReview("disqualified")).toBe("Disqualified");
  });

  it("reads a verdict embedded in a sentence", () => {
    expect(parseBandFromReview("cold, he just said haan once")).toBe("Cold");
    expect(parseBandFromReview("this one is clearly warm — call him back")).toBe("Warm");
  });

  it("accepts the synonyms reviewers actually use", () => {
    expect(parseBandFromReview("hot lead")).toBe("Qualified");
    expect(parseBandFromReview("junk")).toBe("Disqualified");
    expect(parseBandFromReview("wrong number")).toBe("Disqualified");
  });

  it("ignores punctuation and casing", () => {
    expect(parseBandFromReview("COLD!!")).toBe("Cold");
    expect(parseBandFromReview("...warm.")).toBe("Warm");
  });
});

describe("parseBandFromReview — cells that do NOT, and must not be guessed", () => {
  it("returns null for prose with no verdict", () => {
    expect(parseBandFromReview("dealer asked to call after Diwali")).toBeNull();
    expect(parseBandFromReview("line was very noisy, could not hear")).toBeNull();
    expect(parseBandFromReview("")).toBeNull();
  });

  it("returns null when a verdict is negated", () => {
    // "not cold" asserts that it ISN'T Cold — which is not an assertion that it
    // is anything in particular. Reading it as Cold would invert the reviewer.
    expect(parseBandFromReview("not cold")).toBeNull();
    expect(parseBandFromReview("this is not qualified")).toBeNull();
    expect(parseBandFromReview("isn't warm")).toBeNull();
  });

  it("returns null when two different bands are both asserted", () => {
    // Genuinely ambiguous. Picking the first would be a coin flip recorded as
    // fact.
    expect(parseBandFromReview("between cold and warm")).toBeNull();
    expect(parseBandFromReview("qualified or warm, hard to say")).toBeNull();
  });

  it("resolves when the second band is the one being ruled OUT", () => {
    // "warm not cold" is not ambiguous — it asserts Warm and denies Cold. The
    // negation handling is what makes this readable rather than a two-band
    // stalemate, and reviewers write this way constantly.
    expect(parseBandFromReview("warm not cold")).toBe("Warm");
    expect(parseBandFromReview("not qualified, just warm")).toBe("Warm");
  });

  it("does not match a verdict inside a longer word", () => {
    expect(parseBandFromReview("he spoke coldly but stayed on")).toBeNull();
    expect(parseBandFromReview("warmth of the greeting was fine")).toBeNull();
  });

  it("still resolves when one band is repeated several ways", () => {
    // Two synonyms for the SAME band is agreement, not ambiguity.
    expect(parseBandFromReview("junk, disqualified")).toBe("Disqualified");
  });
});
