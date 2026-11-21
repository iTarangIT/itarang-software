/**
 * BB-1058 — a quantity over the line ceiling surfaced as a bare
 * "Validation failed" banner. apiErrorMessage must name the field and reason.
 */

import { describe, expect, it } from "vitest";

import { apiErrorMessage } from "@/lib/buyback/api-error";
import { MAX_QTY_PER_LINE, lineSpecSchema, quantitySchema } from "@/lib/buyback/line-spec";

describe("apiErrorMessage", () => {
  it("prefers the first zod detail, labelled with the dealer-facing field", () => {
    const json = {
      success: false,
      error: {
        message: "Validation failed",
        details: [{ path: "quantity", message: "Quantity can be at most 10,000 per line." }],
      },
    };
    expect(apiErrorMessage(json, "x")).toBe("Qty: Quantity can be at most 10,000 per line.");
  });

  it("falls back to the raw path when the field has no label", () => {
    const json = { error: { message: "Validation failed", details: [{ path: "foo.bar", message: "bad" }] } };
    expect(apiErrorMessage(json, "x")).toBe("foo.bar: bad");
  });

  it("uses the message when there are no details", () => {
    expect(apiErrorMessage({ error: { message: "Deal not found." } }, "x")).toBe("Deal not found.");
  });

  it("uses the fallback for an empty or unparseable body", () => {
    expect(apiErrorMessage(null, "Could not save.")).toBe("Could not save.");
    expect(apiErrorMessage({ error: { message: "  " } }, "Could not save.")).toBe("Could not save.");
    expect(apiErrorMessage({ error: { details: "nope" } }, "Could not save.")).toBe("Could not save.");
  });
});

describe("line quantity ceiling", () => {
  it("accepts the BB-1058 lot of 2714 and the ceiling itself", () => {
    expect(quantitySchema.safeParse(2714).success).toBe(true);
    expect(quantitySchema.safeParse(MAX_QTY_PER_LINE).success).toBe(true);
  });

  it("rejects above the ceiling with a readable message", () => {
    const r = quantitySchema.safeParse(MAX_QTY_PER_LINE + 1);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues[0].message).toMatch(/at most 10,000 per line/);
  });

  it("lets the functional/non-functional split use the same ceiling", () => {
    expect(lineSpecSchema.safeParse({ functional_qty: 2714, non_functional_qty: 0 }).success).toBe(true);
    expect(lineSpecSchema.safeParse({ functional_qty: MAX_QTY_PER_LINE + 1 }).success).toBe(false);
  });
});
