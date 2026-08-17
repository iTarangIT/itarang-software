/**
 * E-243 — the WhatsApp button parser.
 *
 * The design decision this file defends: we act on a TAP, never on prose. The
 * alternative is guessing whether "ok", "haan" or "ok but what about the
 * charger" is an approval, and a wrong guess records a dealer approving a price
 * they never approved. Every free-text case below must return null so the
 * message falls through to the normal orchestrator untouched.
 */
import { describe, expect, it } from "vitest";
import { parseQuotationButton } from "@/lib/whatsapp/quotationButton";

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("recognises our own button IDs", () => {
  it("reads an approval", () => {
    expect(parseQuotationButton(`quote_approve:${ID}`)).toEqual({
      commercialId: ID,
      decision: "approved",
    });
  });

  it("reads a decline", () => {
    expect(parseQuotationButton(`quote_decline:${ID}`)).toEqual({
      commercialId: ID,
      decision: "declined",
    });
  });

  it("tolerates the whitespace a provider may add", () => {
    expect(parseQuotationButton(`  quote_approve:${ID}  `)?.decision).toBe("approved");
  });

  it("accepts an uppercase uuid", () => {
    expect(parseQuotationButton(`quote_approve:${ID.toUpperCase()}`)?.commercialId).toBe(
      ID.toUpperCase(),
    );
  });
});

describe("never acts on prose", () => {
  it.each([
    "ok",
    "OK",
    "yes",
    "yes please",
    "haan",
    "approved",
    "Approve",
    "I approve this quotation",
    "quote approve",
    "decline",
    "no",
    "ok but what about the charger price",
    "hi",
    "",
  ])("ignores %o", (text) => {
    expect(parseQuotationButton(text)).toBeNull();
  });

  it("ignores null and undefined", () => {
    expect(parseQuotationButton(null)).toBeNull();
    expect(parseQuotationButton(undefined)).toBeNull();
  });
});

describe("refuses a malformed id rather than passing it to the database", () => {
  it.each([
    ["missing id", "quote_approve:"],
    ["not a uuid", "quote_approve:12345"],
    ["sql-ish", "quote_approve:' OR 1=1--"],
    ["truncated uuid", "quote_approve:3f2504e0-4f89-11d3-9a0c"],
    ["uuid with trailing junk", `quote_approve:${ID}x`],
  ])("%s", (_label, text) => {
    // A malformed tail would otherwise reach a ::uuid cast and raise
    // invalid_text_representation inside the inbound webhook.
    expect(parseQuotationButton(text)).toBeNull();
  });

  it("does not match a prefix that merely starts the same way", () => {
    expect(parseQuotationButton(`quote_approved:${ID}`)).toBeNull();
  });
});
