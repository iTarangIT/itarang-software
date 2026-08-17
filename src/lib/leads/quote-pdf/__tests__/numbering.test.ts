/**
 * Numbering rules for a revision chain.
 *
 * The case that matters is the one that shipped wrong: numbers are minted at
 * APPROVAL, and approvals do not arrive in version order. A rep raised v1 below
 * the OEM reference (pending, unnumbered) then v2 above it (auto-approved,
 * numbered first). Tying the suffix to allocation order made the older, cheaper,
 * superseded quote read as the newer one.
 */
import { describe, expect, it } from "vitest";
import {
  financialYear,
  quotationFileName,
  quoteNumberForVersion,
  quoteNumberRoot,
} from "../numbering";

describe("quoteNumberForVersion", () => {
  it("gives version 1 the bare root", () => {
    expect(quoteNumberForVersion("ITQ-2026-0001", 1)).toBe("ITQ-2026-0001");
  });

  it("suffixes every later version with its OWN version number", () => {
    expect(quoteNumberForVersion("ITQ-2026-0001", 2)).toBe("ITQ-2026-0001-R2");
    expect(quoteNumberForVersion("ITQ-2026-0001", 7)).toBe("ITQ-2026-0001-R7");
  });

  it("is independent of which version was approved first", () => {
    // v2 approved first, v1 approved an hour later: the numbers must still put
    // them in version order. Before the fix v1 became "-R1" of v2's root.
    const root = "ITQ-2026-0001";
    const v2 = quoteNumberForVersion(root, 2);
    const v1 = quoteNumberForVersion(quoteNumberRoot(v2), 1);
    expect(v1).toBe("ITQ-2026-0001");
    expect(v2).toBe("ITQ-2026-0001-R2");
  });

  it("never produces -R1, so a suffix always means a revision", () => {
    expect(quoteNumberForVersion("ITQ-2026-0001", 1)).not.toContain("-R");
  });

  it("keeps the whole chain on one root", () => {
    const root = "ITQ-2026-0042";
    const chain = [1, 2, 3].map((v) => quoteNumberForVersion(root, v));
    expect(chain.map(quoteNumberRoot)).toEqual([root, root, root]);
  });
});

describe("financialYear", () => {
  it("runs April to March", () => {
    expect(financialYear(new Date("2026-08-13T00:00:00Z"))).toBe(2026);
    expect(financialYear(new Date("2027-02-03T00:00:00Z"))).toBe(2026);
    expect(financialYear(new Date("2027-04-01T06:00:00+05:30"))).toBe(2027);
  });

  it("turns the year at midnight IST, not UTC", () => {
    // 01 Apr 2027 00:30 IST is still 31 Mar in UTC. The business is in IST.
    expect(financialYear(new Date("2027-03-31T19:00:00Z"))).toBe(2027);
  });
});

describe("quotationFileName", () => {
  it("names the file after the number the dealer quotes back", () => {
    expect(quotationFileName("ITQ-2026-0001-R2")).toBe("ITQ-2026-0001-R2.pdf");
  });

  it("cannot escape the quotations folder", () => {
    expect(quotationFileName("../../etc/passwd")).toBe(".._.._etc_passwd.pdf");
  });
});
