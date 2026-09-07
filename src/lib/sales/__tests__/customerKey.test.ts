import { describe, expect, it } from "vitest";
import { customerKey } from "@/lib/sales/customerKey";

describe("customerKey", () => {
  it("folds the spelling differences between Zoho and the extracted page", () => {
    // The live pair this exists for: Zoho stored the shouty version, the model
    // reads the printed one.
    expect(customerKey("HAKIM ALI AUTO SALES AND SERVICE")).toBe(
      customerKey("Hakim Ali Auto Sales & Service"),
    );
  });

  it("ignores company-form suffixes", () => {
    expect(customerKey("TRANSIT ADVERTISING PVT. LTD.")).toBe(
      customerKey("Transit Advertising Private Limited"),
    );
    expect(customerKey("M/S B MOTOR")).toBe(customerKey("B Motor"));
  });

  it("does not strip a suffix that is part of a longer word", () => {
    // Without word boundaries "CO" matches inside MOTOCORP, folding two
    // unrelated dealers onto the same key and mis-flagging a real invoice as a
    // duplicate. This is a regression test for exactly that.
    expect(customerKey("GLOBAL MOTOCORP")).toBe("GLOBALMOTOCORP");
    expect(customerKey("GLOBAL MOTOCORP")).not.toBe(customerKey("GLOBAL MOTRP"));
  });

  it("keeps genuinely different dealers apart", () => {
    // All five were invoiced the same amount on the same day in the live data,
    // so the customer is the only thing separating them.
    const names = [
      "UTKARSH AUTOMOBILE & SPARE PARTS",
      "Ayansh Engineering",
      "PRARAMBH AUTOMOBILE",
      "OM SAI ENTERPRISES",
      "Neelam Enterprises",
    ].map(customerKey);
    expect(new Set(names).size).toBe(5);
  });

  it("returns null when there is nothing to compare", () => {
    // Null disables the duplicate flag rather than matching everything.
    expect(customerKey(null)).toBeNull();
    expect(customerKey("")).toBeNull();
    expect(customerKey("   ")).toBeNull();
    expect(customerKey("Pvt Ltd")).toBeNull();
  });
});
