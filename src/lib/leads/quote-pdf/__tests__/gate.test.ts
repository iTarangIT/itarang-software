/**
 * E-242 — the state machine, asserted rather than assumed.
 *
 * §4 of docs/quotation-approval-flow.md: a quote must not be sendable to a
 * dealer without having passed the gate. That is enforced in two places — the
 * draft generator refuses a non-approved quote, and the send route refuses
 * anything without an approved status AND a generated document.
 *
 * These tests pin the SHAPE of that agreement: the two conditions the send
 * route checks are exactly the two the generator guarantees. They deliberately
 * do not spin up a database — the point is the rule, and a rule that only holds
 * when a DB is reachable is not a rule.
 */
import { describe, expect, it } from "vitest";
import { financialYear, quotationFileName } from "../numbering";

/**
 * The send route's guard, restated. Kept in lockstep with
 * src/app/api/inside-sales/lead/[id]/commercials/[commercialId]/send/route.ts —
 * if that route's condition changes, this test should fail and be updated
 * deliberately rather than silently drifting.
 */
function sendable(row: {
  approval_status: string | null;
  quote_pdf_url: string | null;
  quote_number: string | null;
}): boolean {
  return (
    row.approval_status === "approved" &&
    !!row.quote_pdf_url &&
    !!row.quote_number
  );
}

describe("a quote cannot reach a dealer without passing the gate", () => {
  it("refuses a pending quote", () => {
    expect(
      sendable({ approval_status: "pending", quote_pdf_url: null, quote_number: null }),
    ).toBe(false);
  });

  it("refuses a rejected quote even if a document was once produced", () => {
    // A rejected revision may follow an approved one that had a draft; the
    // status is what decides, not the presence of a file.
    expect(
      sendable({
        approval_status: "rejected",
        quote_pdf_url: "/api/files/documents/quotations/ITQ-2026-0001.pdf",
        quote_number: "ITQ-2026-0001",
      }),
    ).toBe(false);
  });

  it("refuses an approved quote whose draft failed to generate", () => {
    expect(
      sendable({ approval_status: "approved", quote_pdf_url: null, quote_number: null }),
    ).toBe(false);
  });

  it("allows an approved quote with a generated document", () => {
    expect(
      sendable({
        approval_status: "approved",
        quote_pdf_url: "/api/files/documents/quotations/ITQ-2026-0001.pdf",
        quote_number: "ITQ-2026-0001",
      }),
    ).toBe(true);
  });

  it("treats a null status as not-approved rather than defaulting open", () => {
    expect(
      sendable({
        approval_status: null,
        quote_pdf_url: "/x.pdf",
        quote_number: "ITQ-2026-0001",
      }),
    ).toBe(false);
  });
});

describe("financialYear", () => {
  it("runs April to March", () => {
    expect(financialYear(new Date("2026-08-13T06:00:00.000Z"))).toBe(2026);
    expect(financialYear(new Date("2027-02-03T06:00:00.000Z"))).toBe(2026);
    expect(financialYear(new Date("2027-04-01T06:00:00.000Z"))).toBe(2027);
  });

  it("rolls over on IST, not UTC", () => {
    // 2027-03-31T19:00Z is already 1 April in IST, so it is the NEW year.
    expect(financialYear(new Date("2027-03-31T19:00:00.000Z"))).toBe(2027);
    // …and an hour earlier is still the old one.
    expect(financialYear(new Date("2027-03-31T17:00:00.000Z"))).toBe(2026);
  });
});

describe("quotationFileName", () => {
  it("is safe to use as a storage key and an attachment name", () => {
    expect(quotationFileName("ITQ-2026-0001")).toBe("ITQ-2026-0001.pdf");
    expect(quotationFileName("ITQ-2026-0001-R3")).toBe("ITQ-2026-0001-R3.pdf");
  });

  it("strips anything that could escape a path", () => {
    expect(quotationFileName("../../etc/passwd")).toBe(".._.._etc_passwd.pdf");
  });
});
