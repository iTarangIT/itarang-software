import { describe, expect, it } from "vitest";

import { MAX_ROWS, PAGE_SIZE, lineTotal, stockRows } from "../stock-rows";

function stock(n: number, over: Partial<Parameters<typeof stockRows>[0][number]> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    serial_number: `BAT-3W-TEST-${4100 + i}`,
    model_name: "BAT-51V-105AH-3W",
    model_type: "3W",
    price: "45000.00",
    net_amount: "43200.00",
    recommended: i === 0,
    ...over,
  }));
}

// Every limit here is Meta's, and breaking one fails at SEND time — the customer
// sees nothing at all, from a code path that looked fine in review.

describe("stockRows", () => {
  it("never exceeds Meta's 10-row list cap", () => {
    for (const n of [1, 9, 10, 11, 50]) {
      expect(stockRows(stock(n), "dpb", 0).length).toBeLessThanOrEqual(MAX_ROWS);
    }
  });

  it("keeps every title ≤24 and description ≤72 chars", () => {
    const rows = stockRows(
      stock(12, { model_name: "A Very Long Battery Model Name That Will Not Fit" }),
      "dpb",
      0,
    );
    for (const r of rows) {
      expect(r.title.length, r.title).toBeLessThanOrEqual(24);
      expect((r.description ?? "").length, r.description).toBeLessThanOrEqual(72);
    }
  });

  it("keeps the SERIAL intact when the model name is long", () => {
    // The layout exists for this: the serial is the load-bearing half, so it
    // lives in the 72-char description, not the 24-char title.
    const [row] = stockRows(
      stock(1, { model_name: "A Very Long Battery Model Name That Will Not Fit" }),
      "dpb",
      0,
    );
    expect(row.description).toContain("BAT-3W-TEST-4100");
  });

  it("offers 'show more' only when another page exists", () => {
    expect(stockRows(stock(PAGE_SIZE), "dpb", 0).some((r) => r.id === "dpb_more")).toBe(false);
    const paged = stockRows(stock(PAGE_SIZE + 1), "dpb", 0);
    expect(paged.some((r) => r.id === "dpb_more")).toBe(true);
    expect(paged.find((r) => r.id === "dpb_more")?.description).toContain("1 more");
  });

  it("pages without dropping or repeating stock", () => {
    const items = stock(20);
    const seen = new Set<string>();
    for (let page = 0; page * PAGE_SIZE < items.length; page += 1) {
      for (const r of stockRows(items, "dpb", page)) {
        if (r.id.endsWith("_more")) continue;
        expect(seen.has(r.id), `${r.id} appeared twice`).toBe(false);
        seen.add(r.id);
      }
    }
    expect(seen.size).toBe(20);
  });

  it("uses a row id the journey button parser will ignore", () => {
    // `dpb:` is deliberately NOT a LEAD_ACTIONS prefix, so parseLeadAction leaves
    // it alone and it reaches the phase's state handler as ordinary text.
    const [row] = stockRows(stock(1), "dpb", 0);
    expect(row.id).toBe("dpb:BAT-3W-TEST-4100");
  });

  it("marks the recommended (oldest) unit", () => {
    const rows = stockRows(stock(3), "dpb", 0);
    expect(rows[0].title.startsWith("⭐")).toBe(true);
    expect(rows[1].title.startsWith("⭐")).toBe(false);
  });
});

describe("lineTotal", () => {
  it("prefers the GST-inclusive inventory snapshot over the list price", () => {
    expect(lineTotal({ net_amount: "43200.00", price: "45000.00" })).toBe(43200);
  });

  it("falls back to the list price when the snapshot is missing", () => {
    // A lead must never be shown a blank price just because the OEM upload
    // predated the GST snapshot columns.
    expect(lineTotal({ net_amount: null, price: "45000.00" })).toBe(45000);
    expect(lineTotal({ net_amount: "0", price: "45000.00" })).toBe(45000);
  });

  it("returns 0 when neither is usable, rather than NaN", () => {
    expect(lineTotal({ net_amount: null, price: null })).toBe(0);
    expect(lineTotal({ net_amount: "abc", price: "" })).toBe(0);
  });
});
