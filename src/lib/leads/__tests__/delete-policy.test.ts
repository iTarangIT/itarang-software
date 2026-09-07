import { describe, expect, it } from "vitest";

import { isFullyDeleted, type LeadDeleteState } from "../delete-policy";

// E-283 — the rule that decides whether a customer application is destroyed.
// Everything else in that module is I/O; this predicate is the whole policy,
// and getting it wrong either erases a file a lender is still working or leaves
// an application nobody can see but nothing deletes.

const state = (over: Partial<LeadDeleteState> = {}): LeadDeleteState => ({
  dealerDeletedAt: null,
  adminHolds: false,
  adminDeletedAt: null,
  liveNbfcAssignments: 0,
  ...over,
});

const T = new Date("2026-09-07T10:00:00Z");

describe("isFullyDeleted", () => {
  it("does not purge while the dealer still has it", () => {
    expect(isFullyDeleted(state())).toBe(false);
  });

  it("purges a dealer-only lead nobody else ever held", () => {
    // The pre-E-283 behaviour, preserved: a junk lead the dealer discards
    // before submitting it anywhere is gone immediately.
    expect(isFullyDeleted(state({ dealerDeletedAt: T }))).toBe(true);
  });

  it("keeps the application while the admin holds an undeleted copy", () => {
    expect(
      isFullyDeleted(state({ dealerDeletedAt: T, adminHolds: true })),
    ).toBe(false);
  });

  it("purges once the dealer and the holding admin have both deleted", () => {
    expect(
      isFullyDeleted(
        state({ dealerDeletedAt: T, adminHolds: true, adminDeletedAt: T }),
      ),
    ).toBe(true);
  });

  it("keeps the application while any lender assignment is still live", () => {
    // This is the case the old dealer-side hard delete got wrong: one dealer
    // click wiped a file an NBFC had under assessment.
    expect(
      isFullyDeleted(
        state({
          dealerDeletedAt: T,
          adminHolds: true,
          adminDeletedAt: T,
          liveNbfcAssignments: 1,
        }),
      ),
    ).toBe(false);
  });

  it("waits for the SECOND lender when a lead was routed to two", () => {
    const routedToTwo = {
      dealerDeletedAt: T,
      adminHolds: true,
      adminDeletedAt: T,
    };
    expect(isFullyDeleted(state({ ...routedToTwo, liveNbfcAssignments: 2 }))).toBe(false);
    expect(isFullyDeleted(state({ ...routedToTwo, liveNbfcAssignments: 1 }))).toBe(false);
    expect(isFullyDeleted(state({ ...routedToTwo, liveNbfcAssignments: 0 }))).toBe(true);
  });

  it("ignores an admin delete on an application the admin never held", () => {
    // adminHolds is false, so adminDeletedAt is irrelevant either way — the
    // predicate must not require a delete from a party with nothing to delete.
    expect(
      isFullyDeleted(state({ dealerDeletedAt: T, adminDeletedAt: T })),
    ).toBe(true);
  });

  it("never purges on an admin or lender delete alone", () => {
    expect(
      isFullyDeleted(state({ adminHolds: true, adminDeletedAt: T })),
    ).toBe(false);
    expect(isFullyDeleted(state({ liveNbfcAssignments: 0 }))).toBe(false);
  });
});
