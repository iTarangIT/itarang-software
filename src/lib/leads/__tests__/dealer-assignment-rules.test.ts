import { describe, expect, it } from "vitest";

import {
  DEALER_CHECK_PENDING,
  DEALER_CHECK_REJECTED,
  dealerCheckKindLabel,
  isDealerCheckKind,
  isNbfcRoutingBlocked,
  kindForSalespersonPick,
  pickOutcome,
  validateDealerDecision,
} from "../dealer-assignment-rules";

describe("E-390 dealer check — what the initiator sees", () => {
  it("no owned dealer keeps the file with iTarang House", () => {
    expect(pickOutcome(0)).toBe("house");
  });
  it("one owned dealer is tagged automatically", () => {
    expect(pickOutcome(1)).toBe("auto");
  });
  it("several owned dealers need a pick", () => {
    expect(pickOutcome(2)).toBe("pick");
    expect(pickOutcome(9)).toBe("pick");
  });
  it("the reason kind follows how the dealer was chosen", () => {
    expect(kindForSalespersonPick({ eligibleCount: 3, pickedFromOwned: true })).toBe("multi_pick");
    expect(kindForSalespersonPick({ eligibleCount: 1, pickedFromOwned: true })).toBe("single_owned");
    expect(kindForSalespersonPick({ eligibleCount: 3, pickedFromOwned: false })).toBe("manual_pick");
    expect(kindForSalespersonPick({ eligibleCount: 0, pickedFromOwned: false })).toBe("manual_pick");
  });
  it("knows its kinds and labels them", () => {
    expect(isDealerCheckKind("house_push")).toBe(true);
    expect(isDealerCheckKind("dealer_own")).toBe(false);
    expect(dealerCheckKindLabel("dealer_salesperson")).toMatch(/sales team/);
  });
});

describe("E-390 dealer check — lender routing gate", () => {
  it("blocks while the check is open or after a rejection", () => {
    expect(isNbfcRoutingBlocked(DEALER_CHECK_PENDING).blocked).toBe(true);
    expect(isNbfcRoutingBlocked(DEALER_CHECK_REJECTED).blocked).toBe(true);
  });
  it("never blocks anything that worked before", () => {
    expect(isNbfcRoutingBlocked("assigned").blocked).toBe(false);
    expect(isNbfcRoutingBlocked("unassigned").blocked).toBe(false);
    expect(isNbfcRoutingBlocked(null).blocked).toBe(false);
    expect(isNbfcRoutingBlocked(undefined).blocked).toBe(false);
  });
});

describe("E-390 dealer check — admin decision input", () => {
  const base = { currentDealerId: "ACC-1" };
  it("reject needs a reason", () => {
    expect(validateDealerDecision({ ...base, decision: "reject", reason: " " }).ok).toBe(false);
    expect(validateDealerDecision({ ...base, decision: "reject", reason: "wrong dealer" }).ok).toBe(true);
  });
  it("change needs a different dealer", () => {
    expect(validateDealerDecision({ ...base, decision: "change" }).ok).toBe(false);
    expect(validateDealerDecision({ ...base, decision: "change", newDealerId: "ACC-1" }).ok).toBe(false);
    expect(validateDealerDecision({ ...base, decision: "change", newDealerId: "ACC-2" }).ok).toBe(true);
  });
  it("approve needs nothing", () => {
    expect(validateDealerDecision({ ...base, decision: "approve" }).ok).toBe(true);
  });
});
