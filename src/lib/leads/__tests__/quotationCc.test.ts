import { describe, expect, it } from "vitest";

import {
  MAX_FIXED_CC,
  buildCcList,
  normalizeCcEmails,
} from "../quotationCcRules";

describe("buildCcList", () => {
  it("orders owner, actor, fixed, extra", () => {
    expect(
      buildCcList({
        ownerEmail: "owner@itarang.com",
        actorEmail: "sender@itarang.com",
        fixed: ["ops@itarang.com"],
        extra: ["x@y.com"],
        dealerEmail: "dealer@shop.in",
      }),
    ).toEqual(["owner@itarang.com", "sender@itarang.com", "ops@itarang.com", "x@y.com"]);
  });

  it("collapses actor into owner when the owner sends their own quote", () => {
    expect(
      buildCcList({
        ownerEmail: "asm@itarang.com",
        actorEmail: "asm@itarang.com",
        fixed: ["ops@itarang.com"],
      }),
    ).toEqual(["asm@itarang.com", "ops@itarang.com"]);
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(
      buildCcList({
        ownerEmail: "Rep@iTarang.com",
        actorEmail: "rep@itarang.com",
        fixed: ["REP@ITARANG.COM", " ops@itarang.com "],
        extra: ["Ops@itarang.com"],
      }),
    ).toEqual(["Rep@iTarang.com", "ops@itarang.com"]);
  });

  it("never CCs the dealer's own address", () => {
    expect(
      buildCcList({
        ownerEmail: "owner@itarang.com",
        fixed: ["Dealer@Shop.in"],
        extra: ["dealer@shop.in "],
        dealerEmail: " dealer@shop.in",
      }),
    ).toEqual(["owner@itarang.com"]);
  });

  it("skips null, blank and invalid entries", () => {
    expect(
      buildCcList({
        ownerEmail: null,
        actorEmail: "   ",
        fixed: [undefined, "not an email", "a@b"],
        extra: null,
      }),
    ).toEqual([]);
  });

  it("returns [] for an empty input", () => {
    expect(buildCcList({})).toEqual([]);
  });
});

describe("normalizeCcEmails", () => {
  it("accepts a separated string", () => {
    expect(normalizeCcEmails("a@x.com, b@x.com;\nc@x.com  A@X.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });

  it("accepts an array and drops junk", () => {
    expect(normalizeCcEmails(["a@x.com", 5, null, "bad", "a@x.com"])).toEqual(["a@x.com"]);
  });

  it("returns [] for non-list values", () => {
    expect(normalizeCcEmails(undefined)).toEqual([]);
    expect(normalizeCcEmails({ emails: ["a@x.com"] })).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_FIXED_CC + 5 }, (_, i) => `u${i}@x.com`);
    expect(normalizeCcEmails(many)).toHaveLength(MAX_FIXED_CC);
  });
});
