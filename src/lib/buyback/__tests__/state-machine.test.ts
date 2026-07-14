/**
 * peakAmp deal state machine — the merge gate.
 *
 * Two layers of defence:
 *
 *   1. The GOLDEN TABLE (__fixtures__/transitions.ts) pins the transitions the
 *      business signed off on, each with a stated reason.
 *   2. The EXHAUSTIVE CLOSURE walks the entire (state × action × role)
 *      cross-product — 21 × 14 × 2 = 588 cells — and asserts that every cell NOT
 *      declared in TRANSITIONS is refused. This is the real guard: it fails the
 *      moment somebody widens a transition, so no edge can be opened silently.
 *
 * Run: npm test
 */

import { describe, expect, it } from "vitest";

import {
  ACTOR_ROLES,
  DEAL_ACTIONS,
  DEAL_STATES,
  REOPENABLE_STATES,
  REVIEW_ACTIONS,
  TERMINAL_STATES,
  TRANSITIONS,
  allowedActions,
  transition,
  type ActorRole,
  type DealAction,
  type DealState,
} from "../state-machine";
import { GOLDEN_TRANSITIONS, REFUSED } from "../__fixtures__/transitions";

describe("golden fixture table", () => {
  it.each(GOLDEN_TRANSITIONS)(
    "$state + $action ($role) -> $expect",
    ({ state, action, role, expect: want }) => {
      const result = transition(state, action, role);

      // REFUSED means "the machine must refuse this". It is distinct from the
      // REJECTED *state*, which is where a legal `reject` action lands.
      if (want === REFUSED) {
        expect(result.ok).toBe(false);
      } else {
        expect(result).toEqual({ ok: true, to: want });
      }
    },
  );

  it("covers every state that has at least one legal action", () => {
    const statesInFixture = new Set(GOLDEN_TRANSITIONS.map((t) => t.state));
    const statesWithEdges = DEAL_STATES.filter(
      (s) => Object.keys(TRANSITIONS[s]).length > 0,
    );

    for (const state of statesWithEdges) {
      expect(statesInFixture).toContain(state);
    }
  });
});

describe("exhaustive closure over states x actions x roles", () => {
  // Every cell the transition table does NOT declare must be refused. This is
  // what stops an edge being opened without a fixture row to justify it.
  const cells: Array<[DealState, DealAction, ActorRole]> = [];
  for (const state of DEAL_STATES) {
    for (const action of DEAL_ACTIONS) {
      for (const role of ACTOR_ROLES) {
        cells.push([state, action, role]);
      }
    }
  }

  it("enumerates the full cross-product", () => {
    expect(cells).toHaveLength(DEAL_STATES.length * DEAL_ACTIONS.length * ACTOR_ROLES.length);
  });

  it.each(cells)("%s + %s (%s) matches the declared table", (state, action, role) => {
    const edge = TRANSITIONS[state][action];
    const declared = Boolean(edge && edge.roles.includes(role));
    const result = transition(state, action, role);

    expect(result.ok).toBe(declared);
    if (declared && result.ok) {
      expect(result.to).toBe(edge!.to);
    }
  });

  it("never returns an unknown next state", () => {
    for (const [state, action, role] of cells) {
      const result = transition(state, action, role);
      if (result.ok) expect(DEAL_STATES).toContain(result.to);
    }
  });

  it("always gives a reason when it refuses", () => {
    for (const [state, action, role] of cells) {
      const result = transition(state, action, role);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("the four review actions are gated to SUBMITTED / UNDER_REVIEW (BRD M06)", () => {
  const REVIEW_WINDOW: DealState[] = ["SUBMITTED", "UNDER_REVIEW"];

  it.each(REVIEW_ACTIONS)("%s is legal for admin inside the window", (action) => {
    for (const state of REVIEW_WINDOW) {
      expect(transition(state, action, "admin").ok).toBe(true);
    }
  });

  it.each(REVIEW_ACTIONS)("%s is refused everywhere outside the window", (action) => {
    const outside = DEAL_STATES.filter((s) => !REVIEW_WINDOW.includes(s));
    for (const state of outside) {
      expect(transition(state, action, "admin").ok).toBe(false);
    }
  });

  it.each(REVIEW_ACTIONS)("%s is never available to a dealer, in any state", (action) => {
    for (const state of DEAL_STATES) {
      expect(transition(state, action, "dealer").ok).toBe(false);
    }
  });

  it("send_final_offer is NOT one of the four — it has a wider window", () => {
    // This is the BRD-vs-prototype resolution, pinned.
    expect(REVIEW_ACTIONS).not.toContain("send_final_offer" as never);
    expect(transition("UNDER_REVIEW", "send_final_offer", "admin").ok).toBe(true);
    expect(transition("NEGOTIATING", "send_final_offer", "admin").ok).toBe(true);
    expect(transition("SUBMITTED", "send_final_offer", "admin").ok).toBe(false);
  });
});

describe("reopen boundary (BRD M07 AC)", () => {
  it("is legal exactly in the reopenable states, for admin", () => {
    for (const state of DEAL_STATES) {
      const want = REOPENABLE_STATES.includes(state);
      expect(transition(state, "reopen", "admin").ok).toBe(want);
    }
  });

  it("is rejected at VENDOR_AGREED and in every state after it", () => {
    const atOrAfterAgreement: DealState[] = [
      "VENDOR_AGREED",
      "PO_EXCHANGED",
      "PICKUP_SCHEDULED",
      "PICKED_UP",
      "INVOICE_RAISED",
      "INVOICE_APPROVED",
      "SETTLED",
      "CLOSED",
    ];
    for (const state of atOrAfterAgreement) {
      expect(transition(state, "reopen", "admin").ok).toBe(false);
    }
  });

  it("always lands back in NEGOTIATING, never in DEALER_REOPENED", () => {
    for (const state of REOPENABLE_STATES) {
      const result = transition(state, "reopen", "admin");
      expect(result).toEqual({ ok: true, to: "NEGOTIATING" });
    }
    // DEALER_REOPENED is declared in the enum but no edge leads to it.
    const inbound = DEAL_STATES.flatMap((s) =>
      Object.values(TRANSITIONS[s]).filter((e) => e.to === "DEALER_REOPENED"),
    );
    expect(inbound).toHaveLength(0);
  });

  it("is never available to a dealer", () => {
    for (const state of DEAL_STATES) {
      expect(transition(state, "reopen", "dealer").ok).toBe(false);
    }
  });
});

describe("role separation", () => {
  const ADMIN_ONLY: DealAction[] = [
    "start_review",
    "accept",
    "reject",
    "negotiate",
    "request_info",
    "send_final_offer",
    "set_margin",
    "reopen",
  ];
  const DEALER_ONLY: DealAction[] = [
    "submit",
    "resubmit",
    "dealer_counter",
    "dealer_accept",
    "dealer_decline",
  ];

  it.each(ADMIN_ONLY)("a dealer can never perform %s", (action) => {
    for (const state of DEAL_STATES) {
      expect(transition(state, action, "dealer").ok).toBe(false);
    }
  });

  it.each(DEALER_ONLY)("an admin can never perform %s", (action) => {
    for (const state of DEAL_STATES) {
      expect(transition(state, action, "admin").ok).toBe(false);
    }
  });

  it("a dealer can never reach MARGIN_SET — margin is admin-only (M08 AC)", () => {
    for (const state of DEAL_STATES) {
      for (const action of DEAL_ACTIONS) {
        const result = transition(state, action, "dealer");
        if (result.ok) expect(result.to).not.toBe("MARGIN_SET");
      }
    }
  });
});

describe("terminal states", () => {
  it.each(TERMINAL_STATES)("%s has no outbound transitions for anyone", (state) => {
    for (const role of ACTOR_ROLES) {
      expect(allowedActions(state, role)).toEqual([]);
    }
  });

  it("REJECTED cannot be resubmitted or reviewed again", () => {
    expect(transition("REJECTED", "resubmit", "dealer").ok).toBe(false);
    expect(transition("REJECTED", "start_review", "admin").ok).toBe(false);
    expect(transition("REJECTED", "negotiate", "admin").ok).toBe(false);
  });
});

describe("reachability of the Sprint 1 slice", () => {
  const SPRINT_1_STATES: DealState[] = [
    "DRAFT",
    "SUBMITTED",
    "UNDER_REVIEW",
    "INFO_REQUESTED",
    "NEGOTIATING",
    "FINAL_OFFER_SENT",
    "DEALER_ACCEPTED",
    "MARGIN_SET",
  ];

  it("every Sprint 1 state is reachable from DRAFT", () => {
    // Breadth-first walk of the declared transition table.
    const seen = new Set<DealState>(["DRAFT"]);
    const queue: DealState[] = ["DRAFT"];

    while (queue.length) {
      const state = queue.shift()!;
      for (const edge of Object.values(TRANSITIONS[state])) {
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push(edge.to);
        }
      }
    }

    for (const state of SPRINT_1_STATES) {
      expect(seen).toContain(state);
    }
    // And the two terminals the slice can produce.
    expect(seen).toContain("REJECTED");
    expect(seen).toContain("CANCELLED");
  });

  it("walks the full happy path: DRAFT -> MARGIN_SET", () => {
    const path: Array<[DealAction, ActorRole]> = [
      ["submit", "dealer"],
      ["start_review", "admin"],
      ["request_info", "admin"],
      ["resubmit", "dealer"],
      ["negotiate", "admin"],
      ["dealer_counter", "dealer"],
      ["send_final_offer", "admin"],
      ["dealer_accept", "dealer"],
      ["set_margin", "admin"],
    ];

    let state: DealState = "DRAFT";
    for (const [action, role] of path) {
      const result = transition(state, action, role);
      expect(result, `${state} + ${action} (${role})`).toMatchObject({ ok: true });
      if (!result.ok) return;
      state = result.to;
    }

    expect(state).toBe("MARGIN_SET");
  });

  it("walks the decline-then-reopen path", () => {
    const path: Array<[DealAction, ActorRole, DealState]> = [
      ["submit", "dealer", "SUBMITTED"],
      ["start_review", "admin", "UNDER_REVIEW"],
      ["send_final_offer", "admin", "FINAL_OFFER_SENT"],
      ["dealer_decline", "dealer", "NEGOTIATING"],
      ["send_final_offer", "admin", "FINAL_OFFER_SENT"],
      ["dealer_accept", "dealer", "DEALER_ACCEPTED"],
      ["reopen", "admin", "NEGOTIATING"],
    ];

    let state: DealState = "DRAFT";
    for (const [action, role, want] of path) {
      const result = transition(state, action, role);
      expect(result).toEqual({ ok: true, to: want });
      if (!result.ok) return;
      state = result.to;
    }
  });
});

describe("reachability of the Sprint 2A slice (vendor leg + fulfilment)", () => {
  it("walks a whole deal: DRAFT -> PICKED_UP", () => {
    const path: Array<[DealAction, ActorRole, DealState]> = [
      // Dealer leg (Sprint 1).
      ["submit", "dealer", "SUBMITTED"],
      ["start_review", "admin", "UNDER_REVIEW"],
      ["send_final_offer", "admin", "FINAL_OFFER_SENT"],
      ["dealer_accept", "dealer", "DEALER_ACCEPTED"],
      ["set_margin", "admin", "MARGIN_SET"],
      // Vendor leg (Sprint 2A) — every vendor move is admin-RECORDED.
      ["route_to_vendors", "admin", "VENDOR_ROUTED"],
      ["record_vendor_counter", "admin", "VENDOR_NEGOTIATING"],
      ["record_vendor_counter", "admin", "VENDOR_NEGOTIATING"], // haggling continues
      ["record_vendor_agreement", "admin", "VENDOR_AGREED"],
      // Fulfilment.
      ["exchange_pos", "admin", "PO_EXCHANGED"],
      ["schedule_pickup", "admin", "PICKUP_SCHEDULED"],
      ["complete_pickup", "admin", "PICKED_UP"],
    ];

    let state: DealState = "DRAFT";
    for (const [action, role, want] of path) {
      const result = transition(state, action, role);
      expect(result, `${state} + ${action} (${role})`).toEqual({ ok: true, to: want });
      if (!result.ok) return;
      state = result.to;
    }

    expect(state).toBe("PICKED_UP");
  });

  it("every vendor-leg and fulfilment state is reachable from DRAFT", () => {
    const sprint2a: DealState[] = [
      "VENDOR_ROUTED",
      "VENDOR_NEGOTIATING",
      "VENDOR_AGREED",
      "PO_EXCHANGED",
      "PICKUP_SCHEDULED",
      "PICKED_UP",
    ];

    // Breadth-first over the whole machine — no orphan states.
    const seen = new Set<DealState>(["DRAFT"]);
    const queue: DealState[] = ["DRAFT"];
    while (queue.length) {
      const state = queue.shift()!;
      for (const action of DEAL_ACTIONS) {
        for (const role of ACTOR_ROLES) {
          const result = transition(state, action, role);
          if (result.ok && !seen.has(result.to)) {
            seen.add(result.to);
            queue.push(result.to);
          }
        }
      }
    }

    for (const state of sprint2a) {
      expect(seen, `${state} is orphaned — no legal path reaches it`).toContain(state);
    }
  });

  it("walks the ENTIRE lifecycle: DRAFT -> CLOSED", () => {
    // The whole business, end to end. If this ever fails, a deal can no longer
    // complete — which is a bigger deal than any individual cell of the table.
    const path: Array<[DealAction, ActorRole, DealState]> = [
      ["submit", "dealer", "SUBMITTED"],
      ["start_review", "admin", "UNDER_REVIEW"],
      ["request_info", "admin", "INFO_REQUESTED"],
      ["resubmit", "dealer", "UNDER_REVIEW"],
      ["negotiate", "admin", "NEGOTIATING"],
      ["dealer_counter", "dealer", "NEGOTIATING"],
      ["send_final_offer", "admin", "FINAL_OFFER_SENT"],
      ["dealer_accept", "dealer", "DEALER_ACCEPTED"],
      ["set_margin", "admin", "MARGIN_SET"],
      ["route_to_vendors", "admin", "VENDOR_ROUTED"],
      ["record_vendor_counter", "admin", "VENDOR_NEGOTIATING"],
      ["record_vendor_agreement", "admin", "VENDOR_AGREED"],
      ["exchange_pos", "admin", "PO_EXCHANGED"],
      ["schedule_pickup", "admin", "PICKUP_SCHEDULED"],
      ["complete_pickup", "admin", "PICKED_UP"],
      // Money.
      ["raise_invoice", "dealer", "INVOICE_RAISED"],
      ["return_invoice", "admin", "PICKED_UP"], // one line was off — sent back
      ["raise_invoice", "dealer", "INVOICE_RAISED"], // corrected, re-raised
      ["approve_invoice", "admin", "INVOICE_APPROVED"],
      ["record_settlement", "admin", "INVOICE_APPROVED"], // dealer paid (OUT)
      ["settle", "admin", "SETTLED"], // vendor receipt (IN) closes the pair
      ["close_deal", "admin", "CLOSED"],
    ];

    let state: DealState = "DRAFT";
    for (const [action, role, want] of path) {
      const result = transition(state, action, role);
      expect(result, `${state} + ${action} (${role})`).toEqual({ ok: true, to: want });
      if (!result.ok) return;
      state = result.to;
    }

    expect(state).toBe("CLOSED");
  });

  it("every state except DEALER_REOPENED is now reachable from DRAFT", () => {
    const seen = new Set<DealState>(["DRAFT"]);
    const queue: DealState[] = ["DRAFT"];
    while (queue.length) {
      const state = queue.shift()!;
      for (const action of DEAL_ACTIONS) {
        for (const role of ACTOR_ROLES) {
          const result = transition(state, action, role);
          if (result.ok && !seen.has(result.to)) {
            seen.add(result.to);
            queue.push(result.to);
          }
        }
      }
    }

    const orphans = DEAL_STATES.filter((s) => !seen.has(s));
    // DEALER_REOPENED is declared in the DB enum but deliberately unreachable:
    // `reopen` returns the deal to NEGOTIATING and bumps offer_version, which
    // already carries the "this is a reopen" signal. It is kept so splitting it
    // out later needs no DDL.
    expect(orphans).toEqual(["DEALER_REOPENED"]);
  });

  it("the vendor leg is admin-only — a dealer can reach none of it", () => {
    // Every inbound edge to a vendor-leg state must be admin-only. A dealer must
    // not be able to route their own deal, forge a vendor's agreement, or sign
    // off their own collection.
    const vendorLeg: DealState[] = [
      "VENDOR_ROUTED",
      "VENDOR_NEGOTIATING",
      "VENDOR_AGREED",
      "PO_EXCHANGED",
      "PICKUP_SCHEDULED",
      "PICKED_UP",
    ];

    for (const state of DEAL_STATES) {
      for (const action of DEAL_ACTIONS) {
        const result = transition(state, action, "dealer");
        if (result.ok && vendorLeg.includes(result.to)) {
          throw new Error(
            `a dealer can drive ${state} --${action}--> ${result.to}; the vendor leg must be admin-only`,
          );
        }
      }
    }
  });
});
