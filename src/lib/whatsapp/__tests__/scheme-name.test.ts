import { describe, expect, it } from "vitest";

import { labelFor, schemeName } from "../scheme-name";

// The failure this guards against is not cosmetic. The customer picks
// "iTarang Scheme 2" at Step 4; hours later an offer arrives. If the label were
// recomputed from a freshly-derived BRE list — which reorders when a lender is
// deactivated or a product drops out of band — "Scheme 2" in the offer could be
// a DIFFERENT lender from the one they chose, and they would accept terms
// believing they came from someone else.

describe("schemeName", () => {
  it("is one-based, so the first lender is Scheme 1", () => {
    expect(schemeName(0)).toBe("iTarang Scheme 1");
    expect(schemeName(1)).toBe("iTarang Scheme 2");
  });

  it("never leaks a lender's real name", () => {
    expect(schemeName(0)).not.toMatch(/nbfc|finance|bajaj/i);
  });

  it("stays inside Meta's 24-character list-row title cap", () => {
    // Two lenders is the product cap, but the label is used on other lists too.
    for (let i = 0; i < 20; i += 1) {
      expect(schemeName(i).length).toBeLessThanOrEqual(24);
    }
  });
});

describe("labelFor", () => {
  it("uses the frozen order, not the position in the caller's list", () => {
    // Frozen at Step-4 submit: nbfc 7 was picked first, nbfc 3 second.
    const frozen = new Map([
      [7, "iTarang Scheme 1"],
      [3, "iTarang Scheme 2"],
    ]);
    // The offer phase happens to render them the other way round. The labels
    // must NOT follow that order.
    expect(labelFor(frozen, 3, 0)).toBe("iTarang Scheme 2");
    expect(labelFor(frozen, 7, 1)).toBe("iTarang Scheme 1");
  });

  it("falls back to the positional label when nothing was frozen", () => {
    // A lead whose product_selections row carries no lenders — the best that can
    // be said is where it sits in the list being rendered.
    expect(labelFor(new Map(), 42, 0)).toBe("iTarang Scheme 1");
    expect(labelFor(new Map(), 42, 1)).toBe("iTarang Scheme 2");
  });

  it("keeps a lender the frozen map does not know", () => {
    // A lender added to the lead after Step-4 submit (a re-route) is not in the
    // map. It must still get a label rather than render as undefined.
    const frozen = new Map([[7, "iTarang Scheme 1"]]);
    expect(labelFor(frozen, 99, 1)).toBe("iTarang Scheme 2");
  });
});
