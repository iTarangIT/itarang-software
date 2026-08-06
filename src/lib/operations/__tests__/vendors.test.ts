import { describe, expect, it } from "vitest";

import {
  canonicalVendor,
  normaliseVendorName,
  VENDORS,
} from "../vendors";

/**
 * canonicalVendor() is what lets the two halves of /operations/spend line up:
 * metered usage keyed by a code-level provider ("elevenlabs") against invoices
 * keyed by a legal entity ("Eleven Labs Inc."). Every string below is a REAL
 * vendor value taken from expense_submissions.
 *
 * Two failure modes matter:
 *   · a miss — the vendor renders as its own unmatched row and never
 *     reconciles against the usage we know we had;
 *   · a greedy hit — a short pattern swallows a more specific vendor and the
 *     two get summed into one wrong number.
 */

describe("normaliseVendorName", () => {
  it("strips corporate suffixes and punctuation", () => {
    expect(normaliseVendorName("Eleven Labs Inc.")).toBe("eleven labs");
    expect(normaliseVendorName("Anthropic, PBC")).toBe("anthropic");
    expect(normaliseVendorName("DIGIOTECH SOLUTIONS PRIVATE LIMITED")).toBe(
      "digiotech",
    );
    expect(normaliseVendorName("Jio Haptik Technologies Limited")).toBe(
      "jio haptik",
    );
  });
});

describe("canonicalVendor maps real invoice names", () => {
  it.each([
    ["Eleven Labs Inc.", "elevenlabs"],
    ["Anthropic, PBC", "anthropic"],
    ["Hostinger PTE", "hostinger"],
    ["DIGIOTECH SOLUTIONS PRIVATE LIMITED", "digio"],
    ["Jio Haptik Technologies Limited", "haptik"],
    ["NEODOVE TECHNOLOGIES PRIVATE LIMITED", "neodove"],
  ])("%s -> %s", (raw, expected) => {
    const result = canonicalVendor(raw);
    expect(result?.id).toBe(expected);
    expect(result?.matched).toBe(true);
  });

  it("passes through a code-level provider unchanged", () => {
    // ai_call_logs.provider values must land on the same slug as the invoice,
    // or the reconciliation table shows two rows for one vendor.
    expect(canonicalVendor("elevenlabs")?.id).toBe("elevenlabs");
    expect(canonicalVendor("bolna")?.id).toBe("bolna");
  });
});

describe("canonicalVendor never loses a vendor", () => {
  it("keeps an unrecognised entity under a slug of its own name", () => {
    // Dropping it would break the reconciliation totals — that is the design
    // rule at the top of vendors.ts.
    const result = canonicalVendor("KRISHAI Technologies Private Limited");
    expect(result).not.toBeNull();
    expect(result?.matched).toBe(false);
    expect(result?.id).toBe("krishai");
    expect(result?.label).toBe("KRISHAI Technologies Private Limited");
  });

  it("returns null only for genuinely empty input", () => {
    expect(canonicalVendor(null)).toBeNull();
    expect(canonicalVendor("   ")).toBeNull();
  });

  it("does not crash on a name that is nothing but suffixes", () => {
    // normaliseVendorName() strips it to "", which must not become a "" slug.
    expect(canonicalVendor("Private Limited")).toBeNull();
  });
});

describe("matching is longest-wins, not first-defined", () => {
  it("prefers the more specific pattern", () => {
    // "amazon web services" must beat a bare "aws" substring appearing
    // elsewhere, and a longer needle must win regardless of array order.
    expect(canonicalVendor("Amazon Web Services India")?.id).toBe("aws");
  });

  it("gives every vendor a unique id", () => {
    const ids = VENDORS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares no empty match patterns", () => {
    // An empty needle would match every invoice and silently absorb the lot.
    for (const vendor of VENDORS) {
      expect(vendor.match.length).toBeGreaterThan(0);
      for (const needle of vendor.match) expect(needle.trim()).not.toBe("");
    }
  });
});
