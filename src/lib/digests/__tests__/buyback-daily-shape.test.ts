/**
 * Buyback Daily — the pure row shaping (revised Format B, sheet 4_Email_Buyback).
 */

import { describe, expect, it } from "vitest";

import {
  BLOCK_A_COLUMNS,
  BLOCK_B_COLUMNS,
  EMPTY_FIGURES,
  UNASSIGNED,
  avgPerKg,
  blockARows,
  blockBRows,
  buybackHeadline,
  hasBuybackFigure,
  sumFigures,
  type BuybackFigures,
  type BuybackSpocRow,
} from "../kinds/buyback-daily-shape";

const fig = (over: Partial<BuybackFigures> = {}): BuybackFigures => ({ ...EMPTY_FIGURES, ...over });
const spoc = (id: string | null, name: string | null, over: Partial<BuybackSpocRow> = {}): BuybackSpocRow => ({
  ...EMPTY_FIGURES,
  spoc: id,
  name,
  dealers_called: 0,
  ...over,
});

describe("sumFigures / avgPerKg / hasBuybackFigure", () => {
  it("adds every figure; margin stays null until a recycler sale is booked", () => {
    expect(sumFigures([fig({ kg: 100, paid: 5000 }), fig({ kg: 50, paid: 2500, quotes: 2 })])).toMatchObject({
      kg: 150,
      paid: 7500,
      quotes: 2,
      margin: null,
    });
    expect(sumFigures([fig({ margin: 400 }), fig(), fig({ margin: -100 })]).margin).toBe(300);
    expect(sumFigures([])).toEqual(EMPTY_FIGURES);
  });

  it("₹/kg is null, never a division by zero, when nothing was weighed", () => {
    expect(avgPerKg(7500, 150)).toBe(50);
    expect(avgPerKg(1000, 3)).toBe(333.33);
    expect(avgPerKg(7500, 0)).toBeNull();
  });

  it("a row with only (buyback-lead) calls is a buyback row — ID 10", () => {
    expect(hasBuybackFigure(spoc("u1", "A", { dealers_called: 40 }))).toBe(true);
    expect(hasBuybackFigure(spoc("u1", "A"))).toBe(false);
    expect(hasBuybackFigure(fig({ requests: 1 }))).toBe(true);
    expect(hasBuybackFigure(fig({ missing_weight: 2 }))).toBe(true);
    expect(hasBuybackFigure(fig({ margin: 0 }))).toBe(true);
  });
});

describe("Block A — company headline", () => {
  const periods = {
    y: fig({ requests: 2, quotes: 1, accepted: 1, pickups: 1, kg: 150.04, missing_weight: 1, paid: 9000 }),
    d7: fig({ requests: 5, quotes: 4, accepted: 2, pickups: 2, kg: 300, paid: 18000, margin: 2500 }),
    mtd: fig({ requests: 9, quotes: 7, accepted: 3, pickups: 3, kg: 450, paid: 27000, margin: 2500 }),
    lm: fig({ requests: 4 }),
  };
  const rows = blockARows(periods, 6);
  const row = (label: string) => rows.find((r) => r[0] === label)!;

  it("is the sheet's nine metrics, in order, one cell per column", () => {
    expect(BLOCK_A_COLUMNS).toEqual([
      "Metric", "Yesterday", "Last 7 days", "MTD", "MTD target", "% of target", "Same period last month",
    ]);
    expect(rows.map((r) => r[0])).toEqual([
      "Requests received",
      "Quotes shared",
      "Quotes accepted",
      "Pickups completed",
      "Kg sourced",
      "Lines missing weight",
      "₹ paid to suppliers",
      "Avg ₹ / kg",
      "Gross margin ₹ (where recycler sale booked)",
    ]);
    for (const r of rows) expect(r).toHaveLength(BLOCK_A_COLUMNS.length);
  });

  it("only Quotes accepted carries the target (Scrap deals)", () => {
    expect(row("Quotes accepted")).toEqual(["Quotes accepted", "1", "2", "3", "6", "50%", "0"]);
    expect(row("Requests received").slice(4, 6)).toEqual(["—", "—"]);
    expect(blockARows(periods, null).find((r) => r[0] === "Quotes accepted")!.slice(4, 6)).toEqual(["—", "—"]);
  });

  it("formats kg, money and ₹/kg, and shows “—” where there is nothing to measure", () => {
    expect(row("Kg sourced")[1]).toBe("150 kg");
    expect(row("₹ paid to suppliers")[1]).toBe("₹9,000");
    expect(row("Avg ₹ / kg")[1]).toBe("₹59.98/kg");
    expect(row("Avg ₹ / kg")[6]).toBe("—"); // last month: no kg
    expect(row("Gross margin ₹ (where recycler sale booked)").slice(1, 4)).toEqual(["—", "₹2,500", "₹2,500"]);
  });
});

describe("Block B — per SPOC", () => {
  const mtd = [
    spoc("u2", "Zara", { requests: 3, accepted: 2, kg: 100, paid: 4000, dealers_called: 12 }),
    spoc(null, null, { requests: 1 }),
    spoc("u1", "Amit", { quotes: 2 }),
    spoc("u9", "Caller only", { dealers_called: 30 }),
  ];
  const rows = blockBRows(
    { yesterday: [spoc("u2", "Zara", { requests: 1 })], last7: [], mtd },
    new Map([["u2", 4]]),
  );

  it("has the sheet's twelve columns and full-width rows", () => {
    expect(BLOCK_B_COLUMNS).toHaveLength(12);
    for (const r of rows) expect(r).toHaveLength(12);
  });

  it("lists each SPOC by name with (unassigned) last, including a rep whose only activity is buyback calls", () => {
    const order = [...new Set(rows.map((r) => r[1]))];
    expect(order).toEqual(["Amit", "Caller only", "Zara", UNASSIGNED]);
    expect(rows.find((r) => r[1] === "Caller only" && r[0] === "MTD")!.slice(2, 4)).toEqual([0, 30]);
  });

  it("leaves out people with no buyback figure and no buyback calls", () => {
    const quiet = blockBRows({ yesterday: [], last7: [], mtd: [spoc("u5", "Idle")] }, new Map());
    expect(quiet).toEqual([]);
  });

  it("gives every SPOC a Yesterday, Last 7 days and MTD row — zeros where nothing happened", () => {
    expect(rows.filter((r) => r[1] === "Amit").map((r) => r[0])).toEqual(["Yesterday", "Last 7 days", "MTD"]);
    expect(rows.find((r) => r[1] === "Zara" && r[0] === "Last 7 days")!.slice(2, 8)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(rows.find((r) => r[1] === "Zara" && r[0] === "MTD")).toEqual([
      "MTD", "Zara", 3, 12, 0, 0, 2, 0, 100, 0, "₹4,000", "₹40/kg",
    ]);
  });

  it("adds MTD target and % of target only for a SPOC with a target, under Quotes accepted", () => {
    const zara = rows.filter((r) => r[1] === "Zara");
    expect(zara.map((r) => r[0])).toEqual(["Yesterday", "Last 7 days", "MTD", "MTD target", "% of target"]);
    expect(zara[3][6]).toBe("4");
    expect(zara[4][6]).toBe("50%");
    expect(zara[3].filter((c) => c === "—")).toHaveLength(9);
  });
});

describe("headline", () => {
  it("states the under-count beside the kg (R-13)", () => {
    const line = buybackHeadline(fig({ kg: 150, missing_weight: 2, requests: 1, quotes: 3, accepted: 1, pickups: 1, paid: 9000 }));
    expect(line).toBe(
      "Yesterday: 150 kg sourced (+ 2 lines with no weight, not counted) · 1 request received · " +
        "3 quotes shared, 1 accepted · 1 pickup completed · ₹9,000 paid to suppliers.",
    );
  });

  it("a quiet day reads as zeros, not as missing", () => {
    expect(buybackHeadline(EMPTY_FIGURES)).toBe(
      "Yesterday: 0 kg sourced · 0 requests received · 0 quotes shared, 0 accepted · 0 pickups completed · ₹0 paid to suppliers.",
    );
  });
});
