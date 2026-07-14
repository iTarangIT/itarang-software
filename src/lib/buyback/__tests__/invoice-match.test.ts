/**
 * RELEASE-BLOCKING (M12 AC): "one edited line blocks approval even if the total
 * matches."
 *
 * Approving a bad invoice means iTarang pays out money it never agreed to, so
 * every way an invoice can be wrong gets a test — not just the obvious one.
 */

import { describe, expect, it } from "vitest";

import { matchInvoiceToLocks, type LockedLine } from "../invoice-match";

// The deal: 3 × 60V 120Ah at ₹5,200, and 3 × 58V 110Ah at ₹3,000. Total ₹24,600.
const LOCKS: LockedLine[] = [
  { line_id: "l1", quantity: 3, dealer_price: 5200, label: "60V 120Ah · Working" },
  { line_id: "l2", quantity: 3, dealer_price: 3000, label: "58V 110Ah · Dead" },
];

describe("a correct invoice is approved", () => {
  it("matches when every line equals its lock", () => {
    const r = matchInvoiceToLocks(
      [
        { line_id: "l1", quantity: 3, price_per_unit: 5200 },
        { line_id: "l2", quantity: 3, price_per_unit: 3000 },
      ],
      LOCKS,
    );

    expect(r.ok).toBe(true);
    expect(r.summary).toBeNull();
    expect(r.verdicts.every((v) => v.matched)).toBe(true);
    expect(r.billed_total).toBe(24600);
    expect(r.locked_total).toBe(24600);
  });

  it("accepts string-typed numerics, as they arrive from Postgres NUMERIC", () => {
    const r = matchInvoiceToLocks(
      [
        { line_id: "l1", quantity: 3, price_per_unit: "5200.00" },
        { line_id: "l2", quantity: 3, price_per_unit: "3000.00" },
      ],
      [
        { line_id: "l1", quantity: 3, dealer_price: "5200.00" },
        { line_id: "l2", quantity: 3, dealer_price: "3000.00" },
      ],
    );
    expect(r.ok).toBe(true);
  });
});

describe("THE AC — one edited line blocks approval even if the total matches", () => {
  // The dealer moves ₹300/unit from the dead batteries onto the working ones.
  // 3×5500 + 3×2700 = 24,600. Exactly the agreed total. Both lines are wrong.
  const SHIFTED = [
    { line_id: "l1", quantity: 3, price_per_unit: 5500 },
    { line_id: "l2", quantity: 3, price_per_unit: 2700 },
  ];

  it("the totals are identical — a total-only check would approve this", () => {
    const r = matchInvoiceToLocks(SHIFTED, LOCKS);
    expect(r.billed_total).toBe(r.locked_total);
    expect(r.billed_total).toBe(24600);
  });

  it("...and it is REFUSED anyway", () => {
    const r = matchInvoiceToLocks(SHIFTED, LOCKS);
    expect(r.ok).toBe(false);
    expect(r.verdicts.filter((v) => !v.matched)).toHaveLength(2);
    expect(r.verdicts.every((v) => v.code === "PRICE_MISMATCH")).toBe(true);
  });

  it("says out loud why, so an admin staring at two equal totals is not confused", () => {
    const r = matchInvoiceToLocks(SHIFTED, LOCKS);
    expect(r.summary).toContain("total happens to match");
  });

  it("names the offending line and both prices", () => {
    const r = matchInvoiceToLocks(SHIFTED, LOCKS);
    const v = r.verdicts.find((x) => x.line_id === "l1")!;
    expect(v.billed_price).toBe(5500);
    expect(v.locked_price).toBe(5200);
    expect(v.label).toBe("60V 120Ah · Working");
  });
});

describe("every other way an invoice can be wrong", () => {
  it("catches a single overcharged line", () => {
    const r = matchInvoiceToLocks(
      [
        { line_id: "l1", quantity: 3, price_per_unit: 5201 },
        { line_id: "l2", quantity: 3, price_per_unit: 3000 },
      ],
      LOCKS,
    );
    expect(r.ok).toBe(false);
    expect(r.verdicts.find((v) => v.line_id === "l1")!.code).toBe("PRICE_MISMATCH");
    expect(r.verdicts.find((v) => v.line_id === "l2")!.matched).toBe(true);
  });

  it("catches an inflated quantity", () => {
    const r = matchInvoiceToLocks(
      [
        { line_id: "l1", quantity: 4, price_per_unit: 5200 },
        { line_id: "l2", quantity: 3, price_per_unit: 3000 },
      ],
      LOCKS,
    );
    expect(r.ok).toBe(false);
    expect(r.verdicts.find((v) => v.line_id === "l1")!.code).toBe("QUANTITY_MISMATCH");
  });

  it("catches a line invented out of thin air", () => {
    const r = matchInvoiceToLocks(
      [
        { line_id: "l1", quantity: 3, price_per_unit: 5200 },
        { line_id: "l2", quantity: 3, price_per_unit: 3000 },
        { line_id: "ghost", quantity: 9, price_per_unit: 9999 },
      ],
      LOCKS,
    );
    expect(r.ok).toBe(false);
    expect(r.verdicts.find((v) => v.line_id === "ghost")!.code).toBe("LINE_NOT_ON_DEAL");
  });

  it("catches a line QUIETLY OMITTED — an under-billed invoice is still wrong", () => {
    // This one is easy to get wrong: the invoice is cheaper than agreed, so a
    // careless check ("nothing is overcharged") passes it. But approving it
    // settles a deal for batteries we took and never paid for.
    const r = matchInvoiceToLocks([{ line_id: "l1", quantity: 3, price_per_unit: 5200 }], LOCKS);

    expect(r.ok).toBe(false);
    const missing = r.verdicts.find((v) => v.line_id === "l2")!;
    expect(missing.code).toBe("LINE_MISSING");
    expect(missing.matched).toBe(false);
    expect(r.billed_total).toBeLessThan(r.locked_total);
  });

  it("refuses an empty invoice", () => {
    const r = matchInvoiceToLocks([], LOCKS);
    expect(r.ok).toBe(false);
    expect(r.verdicts.every((v) => v.code === "LINE_MISSING")).toBe(true);
  });

  it("does not round a shortfall away — ₹0.01/unit under is still a mismatch", () => {
    const r = matchInvoiceToLocks(
      [
        { line_id: "l1", quantity: 3, price_per_unit: 5199.99 },
        { line_id: "l2", quantity: 3, price_per_unit: 3000 },
      ],
      LOCKS,
    );
    expect(r.ok).toBe(false);
  });
});
