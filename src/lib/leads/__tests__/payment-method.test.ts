import { describe, expect, it } from "vitest";

import { routesToNbfc } from "../payment-method";

describe("routesToNbfc", () => {
  it("iTarang Finance and (for now, 27 Nov) Other Finance go to the NBFCs", () => {
    expect(routesToNbfc("finance")).toBe(true);
    expect(routesToNbfc("other_finance")).toBe(true);
    expect(routesToNbfc(" Other_Finance ")).toBe(true);
  });
  it("cash, dealer finance and empty do not", () => {
    for (const pm of ["cash", "dealer_finance", "", null, undefined]) expect(routesToNbfc(pm)).toBe(false);
  });
});
