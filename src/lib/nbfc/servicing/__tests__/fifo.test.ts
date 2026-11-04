import { describe, expect, it } from "vitest";
import { allocateFifo, totalOwedPaise } from "../fifo";

const jan = { id: "jan", dueDate: "2026-01-05", remainingPaise: 425_000 };
const feb = { id: "feb", dueDate: "2026-02-05", remainingPaise: 425_000 };
const mar = { id: "mar", dueDate: "2026-03-05", remainingPaise: 425_000 };

describe("allocateFifo", () => {
  it("one EMI's worth paid in March clears January first", () => {
    expect(allocateFifo([mar, feb, jan], 425_000)).toEqual({
      allocations: [{ id: "jan", paise: 425_000 }],
      leftoverPaise: 0,
    });
  });

  it("a part payment spills into the next EMI and leaves the rest pending", () => {
    expect(allocateFifo([jan, feb, mar], 600_000)).toEqual({
      allocations: [
        { id: "jan", paise: 425_000 },
        { id: "feb", paise: 175_000 },
      ],
      leftoverPaise: 0,
    });
  });

  it("a part-paid oldest EMI takes only what is still owed on it", () => {
    const janPart = { ...jan, remainingPaise: 125_000 };
    expect(allocateFifo([janPart, feb], 300_000).allocations).toEqual([
      { id: "jan", paise: 125_000 },
      { id: "feb", paise: 175_000 },
    ]);
  });

  it("more than everything owed reports the extra as leftover", () => {
    expect(allocateFifo([jan, feb], 1_000_000)).toEqual({
      allocations: [
        { id: "jan", paise: 425_000 },
        { id: "feb", paise: 425_000 },
      ],
      leftoverPaise: 150_000,
    });
  });

  it("skips settled rows and ignores a zero amount", () => {
    expect(allocateFifo([{ ...jan, remainingPaise: 0 }, feb], 100).allocations).toEqual([{ id: "feb", paise: 100 }]);
    expect(allocateFifo([jan], 0).allocations).toEqual([]);
  });
});

describe("totalOwedPaise", () => {
  it("sums what is still owed", () => {
    expect(totalOwedPaise([jan, feb, { ...mar, remainingPaise: -5 }])).toBe(850_000);
  });
});
