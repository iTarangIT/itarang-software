/**
 * M05 — the variance calculation that decides whether a dealer's payout is held.
 *
 * A false variance blocks an honest dealer's money. A missed variance pays for
 * batteries we never received. Both are expensive, so both directions are tested.
 */

import { describe, expect, it } from "vitest";

import { computeVariance, type ExpectedCount } from "../variance";

const EXPECTED: ExpectedCount[] = [
  { line_id: "l1", label: "60V 120Ah · Working", quantity: 3 },
  { line_id: "l2", label: "58V 110Ah · Dead", quantity: 2 },
];

describe("no variance", () => {
  it("is silent when every count matches", () => {
    const v = computeVariance(EXPECTED, [
      { line_id: "l1", quantity: 3 },
      { line_id: "l2", quantity: 2 },
    ]);

    expect(v.hasVariance).toBe(false);
    expect(v.summary).toBeNull();
    expect(v.totalExpected).toBe(5);
    expect(v.totalActual).toBe(5);
  });
});

describe("a short count holds the payout", () => {
  it("flags a line we received fewer of", () => {
    const v = computeVariance(EXPECTED, [
      { line_id: "l1", quantity: 2 }, // one short
      { line_id: "l2", quantity: 2 },
    ]);

    expect(v.hasVariance).toBe(true);
    expect(v.summary).toContain("60V 120Ah · Working: short by 1");
    expect(v.lines.find((l) => l.line_id === "l1")!.delta).toBe(-1);
  });

  it("treats an OMITTED line as zero received, not as 'no data'", () => {
    // The dangerous case: the collector simply doesn't mention a line. Reading
    // that as "unknown, assume fine" would pay for batteries nobody ever saw.
    const v = computeVariance(EXPECTED, [{ line_id: "l1", quantity: 3 }]);

    expect(v.hasVariance).toBe(true);
    const missing = v.lines.find((l) => l.line_id === "l2")!;
    expect(missing.actual).toBe(0);
    expect(missing.delta).toBe(-2);
    expect(v.summary).toContain("short by 2");
  });

  it("catches the total being right while the lines are wrong", () => {
    // 2 + 3 = 5, same as 3 + 2. A total-only check sees nothing. But we have paid
    // the working-battery price for a dead battery.
    const v = computeVariance(EXPECTED, [
      { line_id: "l1", quantity: 2 },
      { line_id: "l2", quantity: 3 },
    ]);

    expect(v.totalActual).toBe(v.totalExpected);
    expect(v.hasVariance).toBe(true);
    expect(v.summary).toContain("short by 1");
    expect(v.summary).toContain("over by 1");
  });
});

describe("an OVER count is a variance too", () => {
  it("flags receiving more than was declared", () => {
    // Not a gift. It means the paperwork is wrong, the BWM chain of custody does
    // not add up, and we are holding batteries we have no provenance for.
    const v = computeVariance(EXPECTED, [
      { line_id: "l1", quantity: 4 },
      { line_id: "l2", quantity: 2 },
    ]);

    expect(v.hasVariance).toBe(true);
    expect(v.summary).toContain("over by 1");
    expect(v.lines.find((l) => l.line_id === "l1")!.delta).toBe(1);
  });
});
