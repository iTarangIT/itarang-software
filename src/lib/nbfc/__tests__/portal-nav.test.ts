import { describe, expect, it } from "vitest";
import { cleanAllowedNav, firstAllowedHref, isPathAllowed, navIdForPath } from "../portal-nav";

describe("navIdForPath", () => {
  it("picks the deepest menu", () => {
    expect(navIdForPath("/nbfc/acquire/LEAD-1")).toBe("acquire");
    expect(navIdForPath("/nbfc/recovery/queue")).toBe("recovery-queue");
    expect(navIdForPath("/nbfc/recovery/42")).toBe("recovery");
    expect(navIdForPath("/nbfc/auction/drafts/9")).toBe("auction-drafts");
  });
  it("pages outside the menus have no menu", () => {
    expect(navIdForPath("/nbfc")).toBeNull();
    expect(navIdForPath("/nbfc/profile")).toBeNull();
    expect(navIdForPath("/nbfc/acquirex")).toBeNull();
  });
});

describe("isPathAllowed", () => {
  const verifier = ["acquire"];
  it("null means every menu", () => {
    expect(isPathAllowed(null, "/nbfc/settings")).toBe(true);
  });
  it("a Credit Verifier with Acquire only", () => {
    expect(isPathAllowed(verifier, "/nbfc/acquire/LEAD-1")).toBe(true);
    expect(isPathAllowed(verifier, "/nbfc/portfolio")).toBe(false);
    expect(isPathAllowed(verifier, "/nbfc/settings")).toBe(false);
    expect(isPathAllowed(verifier, "/nbfc/profile")).toBe(true);
  });
  it("Recovery & Auction does not open the Recovery queue", () => {
    expect(isPathAllowed(["recovery"], "/nbfc/recovery/queue")).toBe(false);
  });
});

describe("cleanAllowedNav / firstAllowedHref", () => {
  it("keeps known ids in sidebar order", () => {
    expect(cleanAllowedNav(["settings", "bogus", "acquire"])).toEqual(["acquire", "settings"]);
    expect(cleanAllowedNav(null)).toBeNull();
  });
  it("first allowed href", () => {
    expect(firstAllowedHref(["audit", "risk"])).toBe("/nbfc/risk");
    expect(firstAllowedHref([])).toBeNull();
    expect(firstAllowedHref(null)).toBe("/nbfc/acquire");
  });
});
