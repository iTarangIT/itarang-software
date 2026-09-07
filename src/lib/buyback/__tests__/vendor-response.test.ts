/**
 * M10/M24 — which state-machine action a vendor's answer becomes.
 *
 * The same three moves now arrive two ways: an admin recording what a vendor
 * emailed, or the vendor saying it from their own login. They land on the same
 * states, so it is tempting to treat them as one thing. They are not: the
 * action is what the audit log records, and `record_vendor_counter` by an admin
 * is HEARSAY while `vendor_counter` by a vendor is TESTIMONY. Collapsing them
 * would launder one into the other in the log that exists to be trusted — and
 * `buyback_activity_log` is INSERT-only precisely because someone will one day
 * need to know which it was.
 *
 * The rest of applyVendorResponse (the floor guard, first-AGREED-wins, the
 * fill-once lock write) is transactional DB work, exercised against real data
 * rather than mocked here — mocking a partial unique index proves nothing about
 * whether the index exists.
 */

import { describe, expect, it } from "vitest";


import {
  TRANSITIONS,
  transition,
  vendorActionFor as actionFor,
  type DealState,
} from "../state-machine";

describe("actionFor maps (kind, actor) to the right action", () => {
  it("records an admin's transcription as hearsay", () => {
    expect(actionFor("counter", "admin")).toBe("record_vendor_counter");
    expect(actionFor("agree", "admin")).toBe("record_vendor_agreement");
  });

  it("records a vendor's own move as first-hand", () => {
    expect(actionFor("counter", "vendor")).toBe("vendor_counter");
    expect(actionFor("agree", "vendor")).toBe("vendor_agree");
  });

  it("never gives an admin the first-hand action, or a vendor the record_ one", () => {
    // The whole point. If these ever cross, the log stops meaning anything.
    expect(actionFor("counter", "admin")).not.toBe(actionFor("counter", "vendor"));
    expect(actionFor("agree", "admin")).not.toBe(actionFor("agree", "vendor"));
  });
});

describe("every action actionFor can emit is legal for the role that emits it", () => {
  // The mapping is only useful if the state machine agrees. A mapping that
  // returns an action the actor may never perform would 409 every response.
  const VENDOR_LEG_STATES: DealState[] = ["VENDOR_ROUTED", "VENDOR_NEGOTIATING"];

  it.each(VENDOR_LEG_STATES)("from %s, both actors can counter and agree", (state) => {
    for (const kind of ["counter", "agree"] as const) {
      for (const role of ["admin", "vendor"] as const) {
        const action = actionFor(kind, role);
        const result = transition(state, action, role);
        expect(result.ok, `${role} + ${action} from ${state}`).toBe(true);
      }
    }
  });

  it("lands both actors on the same destination — who typed it is not a different deal", () => {
    for (const state of VENDOR_LEG_STATES) {
      for (const kind of ["counter", "agree"] as const) {
        const viaAdmin = transition(state, actionFor(kind, "admin"), "admin");
        const viaVendor = transition(state, actionFor(kind, "vendor"), "vendor");
        expect(viaAdmin.ok && viaVendor.ok).toBe(true);
        if (viaAdmin.ok && viaVendor.ok) expect(viaAdmin.to).toBe(viaVendor.to);
      }
    }
  });

  it("refuses the first-hand action to an admin and the record_ action to a vendor", () => {
    for (const state of VENDOR_LEG_STATES) {
      // An admin must not be able to post as though the vendor said it.
      expect(transition(state, "vendor_counter", "admin").ok).toBe(false);
      expect(transition(state, "vendor_agree", "admin").ok).toBe(false);
      // ...and a vendor must not be able to record on their own behalf, which
      // would let them dress their own claim up as an admin's transcription.
      expect(transition(state, "record_vendor_counter", "vendor").ok).toBe(false);
      expect(transition(state, "record_vendor_agreement", "vendor").ok).toBe(false);
    }
  });
});

describe("a vendor's reach stops at their own leg", () => {
  it("has no vendor edge anywhere before the deal is routed to them", () => {
    const before: DealState[] = [
      "DRAFT",
      "SUBMITTED",
      "UNDER_REVIEW",
      "INFO_REQUESTED",
      "NEGOTIATING",
      "FINAL_OFFER_SENT",
      "DEALER_ACCEPTED",
      "MARGIN_SET",
    ];
    for (const state of before) {
      for (const [action, edge] of Object.entries(TRANSITIONS[state])) {
        expect(
          edge.roles.includes("vendor"),
          `${state} + ${action} must not admit a vendor`,
        ).toBe(false);
      }
    }
  });

  it("cannot NEGOTIATE after agreement — the price is a commitment (M07)", () => {
    // A vendor may still ACT after agreement — E-196 lets them raise their own
    // PO from VENDOR_AGREED (exchange_pos). What they may never do again is move
    // the PRICE: vendor_counter / vendor_agree are gone. The boundary is about
    // the money, not about the vendor's involvement ending.
    const PRICE_MOVES = new Set(["vendor_counter", "vendor_agree", "record_vendor_counter", "record_vendor_agreement"]);
    const after: DealState[] = [
      "VENDOR_AGREED",
      "PO_EXCHANGED",
      "PICKUP_SCHEDULED",
      "PICKED_UP",
      "INVOICE_RAISED",
      "INVOICE_APPROVED",
      "SETTLED",
      "CLOSED",
    ];
    for (const state of after) {
      for (const [action, edge] of Object.entries(TRANSITIONS[state])) {
        if (!PRICE_MOVES.has(action)) continue;
        expect(
          edge.roles.includes("vendor"),
          `${state} + ${action} must not admit a vendor`,
        ).toBe(false);
      }
    }
  });

  it("lets a vendor raise their own PO from VENDOR_AGREED, and nowhere else", () => {
    // E-196. The vendor is the buyer on their leg, and the buyer initiates.
    expect(transition("VENDOR_AGREED", "exchange_pos", "vendor").ok).toBe(true);
    // But not before agreement — there is no agreed price to invoice against.
    expect(transition("VENDOR_NEGOTIATING", "exchange_pos", "vendor").ok).toBe(false);
    expect(transition("MARGIN_SET", "exchange_pos", "vendor").ok).toBe(false);
    // And a dealer never touches the vendor leg.
    expect(transition("VENDOR_AGREED", "exchange_pos", "dealer").ok).toBe(false);
  });

  it("gives a vendor no say in the dealer leg or the money", () => {
    const notTheirs = [
      "submit",
      "dealer_accept",
      "send_final_offer",
      "set_margin",
      "reopen",
      "cancel",
      "route_to_vendors",
      "raise_invoice",
      "approve_invoice",
      "record_settlement",
      "close_deal",
    ] as const;

    for (const state of Object.keys(TRANSITIONS) as DealState[]) {
      for (const action of notTheirs) {
        expect(
          transition(state, action, "vendor").ok,
          `vendor must never ${action} (tried from ${state})`,
        ).toBe(false);
      }
    }
  });
});

/**
 * E-281 — iTarang's own moves on the vendor leg.
 *
 * The whole reason these are separate actions and not a `record_*` with a
 * different flag: `record_vendor_agreement` says in an INSERT-only audit log that
 * the VENDOR agreed. When the desk takes their standing price, nobody said that,
 * and a log that cannot tell the two apart is a log that cannot settle a dispute
 * about who committed to what.
 */
describe("iTarang's own vendor-leg moves (E-281)", () => {
  it("maps accept_counter to the desk's own action, never a record_ one", () => {
    expect(actionFor("accept_counter", "admin")).toBe("accept_vendor_counter");
    expect(actionFor("accept_counter", "admin")).not.toBe(actionFor("agree", "admin"));
    expect(actionFor("accept_counter", "admin")).not.toBe(actionFor("agree", "vendor"));
  });

  it("lets the admin counter and accept from VENDOR_NEGOTIATING", () => {
    expect(transition("VENDOR_NEGOTIATING", "counter_vendor", "admin")).toEqual({
      ok: true,
      to: "VENDOR_NEGOTIATING",
    });
    expect(transition("VENDOR_NEGOTIATING", "accept_vendor_counter", "admin")).toEqual({
      ok: true,
      to: "VENDOR_AGREED",
    });
  });

  it("refuses both to a vendor — the portal must not be able to forge our yes", () => {
    for (const action of ["counter_vendor", "accept_vendor_counter"] as const) {
      expect(transition("VENDOR_NEGOTIATING", action, "vendor").ok).toBe(false);
      expect(transition("VENDOR_NEGOTIATING", action, "dealer").ok).toBe(false);
    }
  });

  it("has no edge before a vendor has countered, or after one has agreed", () => {
    // VENDOR_ROUTED: our ask is the live number and the other vendors hold the
    // emailed PDF — revising it there is a re-quote, not a counter.
    // VENDOR_AGREED: the same boundary that refuses `reopen` (M07 AC).
    for (const state of ["MARGIN_SET", "VENDOR_ROUTED", "VENDOR_AGREED"] as DealState[]) {
      expect(transition(state, "counter_vendor", "admin").ok).toBe(false);
      expect(transition(state, "accept_vendor_counter", "admin").ok).toBe(false);
    }
  });

  it("keeps the counter a self-loop, so a haggle can run as long as it needs to", () => {
    const edge = TRANSITIONS.VENDOR_NEGOTIATING.counter_vendor;
    expect(edge?.to).toBe("VENDOR_NEGOTIATING");
  });
});
