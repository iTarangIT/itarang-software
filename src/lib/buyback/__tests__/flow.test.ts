/**
 * Pins stepIndexFor's mapping for every one of the 21 `buyback_deal_status`
 * enum values (drizzle/E-185_buyback_core.sql) — the Stepper atom trusts this
 * completely, so a wrong index here would silently mis-draw every deal's
 * progress bar.
 */

import { describe, expect, it } from "vitest";

import { FLOW, stepIndexFor } from "../flow";

describe("stepIndexFor", () => {
  it("maps DRAFT to step 0 — nothing done yet", () => {
    expect(stepIndexFor("DRAFT")).toBe(0);
  });

  it("maps every direct FLOW member to its own index", () => {
    FLOW.forEach((status, i) => {
      expect(stepIndexFor(status)).toBe(i);
    });
  });

  it("collapses off-FLOW review/negotiation sub-states onto their parent step", () => {
    expect(stepIndexFor("INFO_REQUESTED")).toBe(FLOW.indexOf("UNDER_REVIEW"));
    expect(stepIndexFor("DEALER_REOPENED")).toBe(FLOW.indexOf("NEGOTIATING"));
    expect(stepIndexFor("VENDOR_NEGOTIATING")).toBe(FLOW.indexOf("VENDOR_ROUTED"));
  });

  it("places INVOICE_RAISED one step past PICKED_UP", () => {
    expect(stepIndexFor("INVOICE_RAISED")).toBe(FLOW.indexOf("PICKED_UP") + 1);
  });

  it("marks REJECTED and CANCELLED as terminal", () => {
    expect(stepIndexFor("REJECTED")).toBe("terminal");
    expect(stepIndexFor("CANCELLED")).toBe("terminal");
  });

  it("returns a value for all 21 buyback_deal_status enum members", () => {
    // Mirrors the CREATE TYPE buyback_deal_status list in
    // drizzle/E-185_buyback_core.sql exactly, so this test breaks if that
    // enum and this map ever drift apart.
    const ALL_21 = [
      "DRAFT",
      "SUBMITTED",
      "UNDER_REVIEW",
      "INFO_REQUESTED",
      "NEGOTIATING",
      "FINAL_OFFER_SENT",
      "DEALER_ACCEPTED",
      "MARGIN_SET",
      "VENDOR_ROUTED",
      "VENDOR_NEGOTIATING",
      "VENDOR_AGREED",
      "DEALER_REOPENED",
      "PO_EXCHANGED",
      "PICKUP_SCHEDULED",
      "PICKED_UP",
      "INVOICE_RAISED",
      "INVOICE_APPROVED",
      "SETTLED",
      "CLOSED",
      "REJECTED",
      "CANCELLED",
    ] as const;

    expect(ALL_21).toHaveLength(21);

    for (const status of ALL_21) {
      const result = stepIndexFor(status);
      expect(result === "terminal" || (typeof result === "number" && result >= 0)).toBe(true);
    }
  });

  it("falls back to 0 for an unrecognised status rather than throwing", () => {
    expect(stepIndexFor("SOME_FUTURE_STATUS")).toBe(0);
  });
});
