import { describe, expect, it } from "vitest";

import {
  computeTotals,
  finalPriceOf,
  MARGIN_GST_PCT,
  marginGst,
  resolveMargin,
  totalsFromPrior,
} from "../pricing";
import type { BatteryRow, PriorSelection } from "../types";

const battery = {
  id: "b1",
  serial_number: "BAT-1",
  asset_type: "battery",
  gross_amount: "8474.58",
  gst_percent: "18",
  gst_amount: "1525.42",
  net_amount: "10000",
  price: null,
} as unknown as BatteryRow;

const empty = { battery, charger: null, paraphernalia: [], paraQty: {} };

describe("marginGst", () => {
  it("is 18% of the margin, rounded to the rupee", () => {
    expect(MARGIN_GST_PCT).toBe(18);
    expect(marginGst(500)).toBe(90);
    expect(marginGst(333)).toBe(60); // 59.94
    expect(marginGst(3654)).toBe(658); // 657.72
  });

  it("is zero for no / invalid margin", () => {
    expect(marginGst(0)).toBe(0);
    expect(marginGst(-5)).toBe(0);
    expect(marginGst(Number.NaN)).toBe(0);
  });
});

describe("finalPriceOf", () => {
  it("adds margin and GST on the margin to the net items total", () => {
    expect(finalPriceOf(10_000, 500)).toBe(10_590);
    expect(finalPriceOf(10_000, 0)).toBe(10_000);
  });
});

describe("computeTotals", () => {
  it("percent margin: 5% of ₹10,000 → ₹500 + ₹90 GST = ₹10,590", () => {
    const t = computeTotals({
      ...empty,
      marginMode: "percent",
      marginInput: "",
      marginPercentInput: "5",
    });
    expect(t.netSubtotal).toBe(10_000);
    expect(t.dealerMargin).toBe(500);
    expect(t.dealerMarginGstPct).toBe(18);
    expect(t.dealerMarginGst).toBe(90);
    expect(t.finalPrice).toBe(10_590);
  });

  it("rupee margin: ₹1,000 → ₹180 GST", () => {
    const t = computeTotals({
      ...empty,
      marginMode: "rupees",
      marginInput: "1000",
      marginPercentInput: "",
    });
    expect(t.dealerMargin).toBe(1_000);
    expect(t.dealerMarginGst).toBe(180);
    expect(t.finalPrice).toBe(11_180);
  });

  it("no margin → final = net, no GST line", () => {
    const t = computeTotals({
      ...empty,
      marginMode: "rupees",
      marginInput: "",
      marginPercentInput: "",
    });
    expect(t.dealerMargin).toBe(0);
    expect(t.dealerMarginGst).toBe(0);
    expect(t.finalPrice).toBe(10_000);
  });

  it("resolveMargin itself stays GST-exclusive", () => {
    expect(resolveMargin("percent", "", "5", 73_080)).toBe(3_654);
  });
});

describe("totalsFromPrior", () => {
  const base = {
    id: "ps1",
    battery_serial: "BAT-1",
    charger_serial: null,
    paraphernalia: null,
    paraphernalia_lines: [],
    category: null,
    sub_category: null,
    battery_price: "10000",
    charger_price: null,
    paraphernalia_cost: "0",
    battery_gross: "8474.58",
    battery_gst_percent: "18",
    battery_gst_amount: "1525.42",
    battery_net: "10000",
    charger_gross: null,
    charger_gst_percent: null,
    charger_gst_amount: null,
    charger_net: null,
    gross_subtotal: "8474.58",
    gst_subtotal: "1525.42",
    net_subtotal: "10000",
    admin_decision: null,
    submitted_at: null,
  };

  it("legacy row (pre-E-273): no GST columns → gst 0, stored final untouched", () => {
    const t = totalsFromPrior({
      ...base,
      dealer_margin: "500",
      final_price: "10500",
    } as PriorSelection);
    expect(t.dealerMarginGst).toBe(0);
    expect(t.dealerMarginGstPct).toBe(0);
    expect(t.finalPrice).toBe(10_500);
  });

  it("new row: reads the snapshot back verbatim", () => {
    const t = totalsFromPrior({
      ...base,
      dealer_margin: "500",
      dealer_margin_gst_percent: "18",
      dealer_margin_gst_amount: "90",
      final_price: "10590",
    } as PriorSelection);
    expect(t.dealerMarginGst).toBe(90);
    expect(t.finalPrice).toBe(10_590);
  });
});
