/**
 * E-281 — the standing price: what is actually on the table, per SKU.
 *
 * This rule replaced a plain `COALESCE(counter_price, ask_price)` that was
 * correct for exactly as long as the vendor was the only party who could move a
 * number after routing. The bug it prevents is specific and expensive:
 *
 *   1. We ask ₹80. 2. The vendor counters ₹60, below our floor of ₹70.
 *   3. We counter ₹72. 4. The vendor clicks Accept.
 *
 * Under the old expression step 4 books ₹60 — their own superseded number —
 * which the floor guard then refuses, so the vendor cannot accept a price we had
 * just offered them and the deal deadlocks with no error anyone can act on.
 *
 * Pure, so it is tested here rather than in a verify-* script: the recency
 * decision is the whole of the logic, and it must not need a database to check.
 */

import { describe, expect, it } from "vitest";

import { standingPrice } from "../standing";

const line = (over: Partial<Parameters<typeof standingPrice>[0]> = {}) => ({
  ask_price: "80",
  counter_price: null,
  revised_ask_price: null,
  agreed_price: null,
  ...over,
});

describe("standingPrice", () => {
  it("is our opening ask before anyone has answered", () => {
    expect(standingPrice(line(), "VENDOR")).toBe("80");
  });

  it("is their counter once they have made one", () => {
    expect(standingPrice(line({ counter_price: "60" }), "ITARANG")).toBe("60");
  });

  it("becomes OUR counter once we have answered — not their superseded number", () => {
    // The bug in the docblock, pinned. `counter_price` is still 60 on the row.
    expect(
      standingPrice(line({ counter_price: "60", revised_ask_price: "72" }), "VENDOR"),
    ).toBe("72");
  });

  it("goes back to THEIR number when they counter again", () => {
    // They answered our 72 with 65. awaiting flips to ITARANG, and our stale
    // revised_ask must stop counting even though the column still holds it.
    expect(
      standingPrice(line({ counter_price: "65", revised_ask_price: "72" }), "ITARANG"),
    ).toBe("65");
  });

  it("ignores a revised ask while the ball is with us", () => {
    // Belt and braces on the line above: awaiting_party is the ONLY thing that
    // decides, never "is revised_ask_price set".
    expect(standingPrice(line({ revised_ask_price: "72" }), "ITARANG")).toBe("80");
  });

  it("lets the agreed price win over everything once struck", () => {
    // Nothing is on the table after a handshake — not their last counter, not
    // ours. Every document and report reads the struck number.
    expect(
      standingPrice(
        line({ counter_price: "60", revised_ask_price: "72", agreed_price: "70" }),
        "VENDOR",
      ),
    ).toBe("70");
    expect(
      standingPrice(
        line({ counter_price: "60", revised_ask_price: "72", agreed_price: "70" }),
        "ITARANG",
      ),
    ).toBe("70");
  });

  it("treats a zero counter as a real price, not as absent", () => {
    // `?? ` and not `||`: a vendor quoting 0 for dead cells is a number they
    // named, and falling back to our ask there would book a price nobody offered.
    expect(standingPrice(line({ counter_price: 0 }), "ITARANG")).toBe(0);
  });
});
