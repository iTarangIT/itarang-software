/**
 * peakAmp Battery Buyback — the deal state machine (BRD §2).
 *
 * The single source of truth for what may happen to a deal, and by whom.
 * A PURE function: no I/O, no db import, no clock, no randomness. That is what
 * makes it exhaustively testable — see __fixtures__/transitions.ts and
 * __tests__/state-machine.test.ts, which walk the entire
 * (state × action × role) cross-product.
 *
 * Every mutating API route routes through applyTransition() (transition.ts),
 * which calls this. Illegal transitions are rejected SERVER-SIDE — the UI's
 * ghosting is cosmetic and is never the gate (BRD invariant 3).
 *
 * Sprint 1 built the dealer leg (DRAFT → MARGIN_SET), Sprint 2A the vendor leg
 * and fulfilment (→ PICKED_UP), Sprint 2B the money (→ CLOSED). Every state in
 * the DB enum is now reachable except DEALER_REOPENED, which is intentionally
 * unreachable (see below).
 */

export const DEAL_STATES = [
  // Intake
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  // Review
  "INFO_REQUESTED",
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
  // Dealer lock
  "DEALER_ACCEPTED",
  "MARGIN_SET",
  // Vendor leg — Sprint 2
  "VENDOR_ROUTED",
  "VENDOR_NEGOTIATING",
  "VENDOR_AGREED",
  "DEALER_REOPENED",
  // Fulfilment — Sprint 2/3
  "PO_EXCHANGED",
  "PICKUP_SCHEDULED",
  "PICKED_UP",
  // Money — Sprint 2
  "INVOICE_RAISED",
  "INVOICE_APPROVED",
  "SETTLED",
  "CLOSED",
  // Terminal
  "REJECTED",
  "CANCELLED",
] as const;

export type DealState = (typeof DEAL_STATES)[number];

export const DEAL_ACTIONS = [
  // Dealer
  "submit",
  "resubmit",
  "dealer_counter",
  "dealer_accept",
  "dealer_decline",
  // Admin — the four review actions (BRD M06)
  "start_review",
  "accept",
  "reject",
  "negotiate",
  "request_info",
  // Admin — the rest of the dealer leg
  "send_final_offer",
  "set_margin",
  "reopen",
  "cancel",
  // Admin — the vendor leg & fulfilment (Sprint 2A, M09–M11 + minimal M05).
  //
  // `record_*` because an admin is transcribing what a vendor said in an email.
  // These are NOT deprecated by the vendor login (E-195): a vendor who replies
  // by email rather than logging in still has to reach the system somehow, and
  // that is still an admin recording it. The two paths coexist, and the audit
  // log tells them apart by actor role — `record_vendor_counter` by an admin is
  // hearsay, `vendor_counter` by a vendor is first-hand.
  "route_to_vendors",
  "record_vendor_counter",
  "record_vendor_agreement",
  // Vendor — the same two moves, made by the vendor themselves (E-195, M24).
  //
  // There is no `vendor_reject`: a vendor walking away sets their THREAD to
  // LOST and moves no deal status, because the deal is still live with every
  // other vendor it was routed to. Same reason record_vendor_* has no "lost"
  // action. See VendorBoard's three buttons.
  "vendor_counter",
  "vendor_agree",
  "exchange_pos",
  "schedule_pickup",
  "complete_pickup",
  // The money leg (Sprint 2B, M12–M14).
  "raise_invoice",
  "approve_invoice",
  "return_invoice",
  "record_settlement",
  "settle",
  "close_deal",
] as const;

export type DealAction = (typeof DEAL_ACTIONS)[number];

/**
 * Who can act on a deal.
 *
 * `vendor` arrived with the vendor login (E-195). Before it, a vendor's counter
 * or agreement reached the system only as an admin recording it off an email —
 * which is why admin/vendor actions were tangled on one screen, and why "the
 * vendor raises the PO" was impossible to model: there was nobody to raise it.
 *
 * A vendor is scoped to their OWN thread. Nothing here grants a vendor sight of
 * a deal they were not routed to, and nothing grants them the dealer's identity
 * — that is enforced by the route's scoping and the vendor serializer, not by
 * this table, which only knows the (state, action, role) triple.
 */
export type ActorRole = "dealer" | "admin" | "vendor";

export const ACTOR_ROLES: readonly ActorRole[] = ["dealer", "admin", "vendor"] as const;

/**
 * The four review actions (BRD M06). Legal ONLY in SUBMITTED / UNDER_REVIEW —
 * "ghosted+tooltip after" (BRD §2). `send_final_offer` is deliberately NOT one
 * of them: it is a fifth action with a wider window (see TRANSITIONS), because
 * an admin must be able to close out a NEGOTIATING deal with a final offer.
 */
export const REVIEW_ACTIONS = ["accept", "reject", "negotiate", "request_info"] as const;

/**
 * States a deal can be reopened from — i.e. strictly BEFORE vendor agreement
 * (BRD §2: "Reopen allowed any time BEFORE vendor agreement; never after").
 *
 * VENDOR_NEGOTIATING joins the list in Sprint 2A. It was absent in Sprint 1 only
 * because the state was unreachable — not because reopening from it is illegal.
 * It is squarely before agreement, so it is reopenable.
 *
 * VENDOR_AGREED and everything after is NOT. That boundary is the whole point of
 * M07's AC: once a vendor has agreed, the locked margin is a commitment to a
 * third party, and moving the dealer's price would silently change what iTarang
 * earns on a deal it has already sold.
 *
 * Reopening from VENDOR_ROUTED / VENDOR_NEGOTIATING leaves live quotations in
 * vendors' inboxes for prices that are about to move, so the reopen route closes
 * every open thread as LOST in the same transaction.
 */
export const REOPENABLE_STATES: readonly DealState[] = [
  "DEALER_ACCEPTED",
  "MARGIN_SET",
  "VENDOR_ROUTED",
  "VENDOR_NEGOTIATING",
] as const;

/** No outbound transitions. A rejected request is not resubmitted — a new one is raised. */
export const TERMINAL_STATES: readonly DealState[] = ["REJECTED", "CANCELLED", "CLOSED"] as const;

type Edge = { to: DealState; roles: readonly ActorRole[] };

/**
 * The complete transition table. Anything not listed here is rejected.
 *
 * Read it as: from <state>, the <action> performed by one of <roles> moves the
 * deal to <to>. A state with an empty object has no legal outbound action for
 * this sprint.
 */
export const TRANSITIONS: Record<DealState, Partial<Record<DealAction, Edge>>> = {
  // ---- Intake -------------------------------------------------------------
  DRAFT: {
    // Gated on ≥1 line, ≥5 photos/line and complete provenance — enforced in the
    // submit route, not here (this function sees only the state triple).
    submit: { to: "SUBMITTED", roles: ["dealer"] },
    cancel: { to: "CANCELLED", roles: ["dealer", "admin"] },
  },

  SUBMITTED: {
    start_review: { to: "UNDER_REVIEW", roles: ["admin"] },
    // The four review actions are live here...
    accept: { to: "DEALER_ACCEPTED", roles: ["admin"] },
    reject: { to: "REJECTED", roles: ["admin"] },
    negotiate: { to: "NEGOTIATING", roles: ["admin"] },
    request_info: { to: "INFO_REQUESTED", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  UNDER_REVIEW: {
    // ...and here. Nowhere else.
    accept: { to: "DEALER_ACCEPTED", roles: ["admin"] },
    reject: { to: "REJECTED", roles: ["admin"] },
    negotiate: { to: "NEGOTIATING", roles: ["admin"] },
    request_info: { to: "INFO_REQUESTED", roles: ["admin"] },
    // An admin may skip the counter dance and go straight to a final offer.
    send_final_offer: { to: "FINAL_OFFER_SENT", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  // ---- Review -------------------------------------------------------------
  // The ball is in the dealer's court: only they can move it, by resubmitting.
  // The admin's four actions are ghosted until the deal comes back.
  INFO_REQUESTED: {
    resubmit: { to: "UNDER_REVIEW", roles: ["dealer"] },
    cancel: { to: "CANCELLED", roles: ["dealer", "admin"] },
  },

  NEGOTIATING: {
    // Counters stay in NEGOTIATING and are itemized per SKU (BRD P5); a round is
    // appended each time. The self-loop is intentional.
    dealer_counter: { to: "NEGOTIATING", roles: ["dealer"] },
    send_final_offer: { to: "FINAL_OFFER_SENT", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  FINAL_OFFER_SENT: {
    // ONE binary answer for the whole itemized set (U5) — never per line.
    dealer_accept: { to: "DEALER_ACCEPTED", roles: ["dealer"] },
    dealer_decline: { to: "NEGOTIATING", roles: ["dealer"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  // ---- Dealer lock --------------------------------------------------------
  DEALER_ACCEPTED: {
    // Dealer acceptance is PROVISIONAL until vendor agreement.
    set_margin: { to: "MARGIN_SET", roles: ["admin"] },
    reopen: { to: "NEGOTIATING", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  MARGIN_SET: {
    // The margin is locked, so the ask (dealer_price + margin) is now known and
    // the deal can be quoted out. Routing is gated on the floor: M08's
    // "floor blocks routing below breakeven".
    route_to_vendors: { to: "VENDOR_ROUTED", roles: ["admin"] },
    reopen: { to: "NEGOTIATING", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  // ---- Vendor leg (Sprint 2A) ---------------------------------------------
  // No `vendor` role exists — an admin records what the vendor said (no vendor
  // login in v1, BRD M24).
  VENDOR_ROUTED: {
    // A vendor came back with a per-SKU counter — the deal is now live.
    record_vendor_counter: { to: "VENDOR_NEGOTIATING", roles: ["admin"] },
    // ...or came straight back with a yes, at our ask.
    record_vendor_agreement: { to: "VENDOR_AGREED", roles: ["admin"] },
    // The same two moves made first-hand, from the vendor's own dashboard.
    // Same destinations: who typed it changes the evidence, not the deal.
    vendor_counter: { to: "VENDOR_NEGOTIATING", roles: ["vendor"] },
    vendor_agree: { to: "VENDOR_AGREED", roles: ["vendor"] },
    reopen: { to: "NEGOTIATING", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  VENDOR_NEGOTIATING: {
    // Self-loop: each further counter appends a round. Marking a vendor LOST is
    // NOT here — a thread going LOST is a thread-level change and moves no deal
    // status (the deal is still live with the other vendors).
    record_vendor_counter: { to: "VENDOR_NEGOTIATING", roles: ["admin"] },
    record_vendor_agreement: { to: "VENDOR_AGREED", roles: ["admin"] },
    vendor_counter: { to: "VENDOR_NEGOTIATING", roles: ["vendor"] },
    vendor_agree: { to: "VENDOR_AGREED", roles: ["vendor"] },
    reopen: { to: "NEGOTIATING", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  // THE BOUNDARY. No reopen from here on — the margin is now a commitment to a
  // third party (M07 AC: "reopen after vendor agreement rejected server-side").
  VENDOR_AGREED: {
    // Fires automatically inside the transaction that records whichever PO
    // completes the pair. POs are impossible before this state (M11 AC).
    exchange_pos: { to: "PO_EXCHANGED", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  // Declared in the DB enum but intentionally unreachable: `reopen` returns the
  // deal to NEGOTIATING and bumps offer_version, which already carries the
  // "this is a reopen" signal. Kept so splitting it out later needs no DDL.
  DEALER_REOPENED: {},

  // ---- Fulfilment (Sprint 2A minimal; M05 fills it out in Sprint 3) --------
  PO_EXCHANGED: {
    schedule_pickup: { to: "PICKUP_SCHEDULED", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  PICKUP_SCHEDULED: {
    complete_pickup: { to: "PICKED_UP", roles: ["admin"] },
    cancel: { to: "CANCELLED", roles: ["admin"] },
  },

  // No `cancel` from here on, deliberately: the batteries are physically in
  // iTarang's hands. Undoing that is a returns problem, not a cancellation, and
  // v1 has no returns flow — so the machine refuses rather than pretending.
  PICKED_UP: {
    // The DEALER raises their own invoice — it is their legal document, on their
    // own GST series. This is the only money-leg action a dealer performs.
    raise_invoice: { to: "INVOICE_RAISED", roles: ["dealer"] },
  },

  // ---- Money (Sprint 2B) --------------------------------------------------
  INVOICE_RAISED: {
    // Approval compares EVERY line to deal_line_locks. One mismatched line blocks
    // it, even when the total agrees (M12 AC) — enforced in the route, which has
    // the numbers; the machine only says who may try.
    approve_invoice: { to: "INVOICE_APPROVED", roles: ["admin"] },
    // Sent back with a reason. There is no RETURNED state in the enum, and it
    // does not need one: the deal goes back to where it was (PICKED_UP, invoice
    // outstanding) and the dealer raises a fresh one. The rejected invoice row
    // survives with its reason — the history of what was wrong is the point.
    return_invoice: { to: "PICKED_UP", roles: ["admin"] },
  },

  INVOICE_APPROVED: {
    // Self-loop: recording the FIRST settlement leg does not settle the deal —
    // one side of a two-sided trade has moved. Same shape as dealer_counter.
    record_settlement: { to: "INVOICE_APPROVED", roles: ["admin"] },
    // Fires inside the transaction that records whichever settlement CLOSES the
    // pair (dealer paid OUT and vendor received IN). Cannot fire twice: the
    // optimistic status guard 409s the second attempt.
    settle: { to: "SETTLED", roles: ["admin"] },
  },

  SETTLED: {
    // Deliberately a separate, human action. CLOSED is the state M15 asserts a
    // complete document set against and M14 reconciles margin on — so a person
    // confirms the deal is finished, rather than it closing itself the instant
    // money lands.
    close_deal: { to: "CLOSED", roles: ["admin"] },
  },

  // Terminal. A CLOSED deal's margin is final and its ledger row is history.
  CLOSED: {},

  // ---- Terminal -----------------------------------------------------------
  // REJECTED is a dead end (BRD §2). A dealer with a fixable problem is sent
  // through request_info instead; one who wants another go raises a new request.
  REJECTED: {},
  CANCELLED: {},
};

export type TransitionResult =
  | { ok: true; to: DealState }
  | { ok: false; reason: string };

/**
 * The gate. Returns the next state, or why the transition is refused.
 *
 * Callers must treat `ok: false` as a 409 — never as "hide the button".
 */
export function transition(
  state: DealState,
  action: DealAction,
  role: ActorRole,
): TransitionResult {
  const edge = TRANSITIONS[state]?.[action];

  if (!edge) {
    return {
      ok: false,
      reason: `Action "${action}" is not allowed while the deal is ${state}.`,
    };
  }

  if (!edge.roles.includes(role)) {
    return {
      ok: false,
      reason: `Role "${role}" may not perform "${action}" on a ${state} deal.`,
    };
  }

  return { ok: true, to: edge.to };
}

/** Convenience for the UI: which actions can this role take right now? */
export function allowedActions(state: DealState, role: ActorRole): DealAction[] {
  return DEAL_ACTIONS.filter((action) => transition(state, action, role).ok);
}

/**
 * Which action a vendor's counter/agreement becomes, given who is entering it.
 *
 * Lives here, with the vocabulary it maps into, because it is pure — and
 * because its home (vendor-response.ts) imports the db, which would make this
 * one-line decision untestable without a database.
 *
 * The distinction is not cosmetic. `record_vendor_*` by an admin is HEARSAY —
 * they are transcribing an email. The bare verb by a vendor is TESTIMONY. Both
 * reach the same state, so it would be easy to collapse them; that would launder
 * one into the other in an INSERT-only audit log whose whole purpose is that
 * someone can later tell the difference.
 */
export function vendorActionFor(
  kind: "counter" | "agree",
  role: "admin" | "vendor",
): DealAction {
  if (role === "vendor") return kind === "counter" ? "vendor_counter" : "vendor_agree";
  return kind === "counter" ? "record_vendor_counter" : "record_vendor_agreement";
}

/**
 * The tooltip text for a ghosted action (BRD M06 — "ghosted+tooltip after").
 * The prototype has no ghosted state at all, so this copy is ours.
 */
export function whyBlocked(state: DealState, action: DealAction, role: ActorRole): string | null {
  const result = transition(state, action, role);
  return result.ok ? null : result.reason;
}
