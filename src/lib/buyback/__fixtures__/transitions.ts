/**
 * peakAmp deal state machine — CANONICAL GOLDEN FIXTURE.
 *
 * Source: docs/peakAmp/DEVELOPMENT_BRD.md §2, plus the four gating decisions
 * confirmed with the business before Sprint 0:
 *
 *   1. The FOUR review actions (accept/reject/negotiate/request_info) are legal
 *      ONLY in SUBMITTED / UNDER_REVIEW. `send_final_offer` is a separate fifth
 *      action with a wider window (UNDER_REVIEW / NEGOTIATING).
 *   2. `reopen` returns the deal to NEGOTIATING and bumps offer_version;
 *      DEALER_REOPENED is declared but unreachable.
 *   3. REJECTED is terminal — no resubmit path.
 *   4. Reopen is impossible at or after VENDOR_AGREED.
 *
 * Same pattern as the loan calculator's GOLDEN_CASES
 * (src/lib/calculator/__fixtures__/golden.ts), which the BRD points at.
 *
 * This table is the SPEC. If a row here has to change, that is a business
 * decision, not a refactor — the accompanying test also walks the full
 * (state × action × role) cross-product, so anything NOT asserted here is
 * asserted to be rejected.
 */

import type { ActorRole, DealAction, DealState } from "../state-machine";

/**
 * The refusal sentinel. Deliberately NOT "REJECTED" — that is a real destination
 * state (what the `reject` action produces), and using it for both meanings made
 * "reject -> REJECTED" indistinguishable from "reject is refused".
 */
export const REFUSED = "REFUSED" as const;

export interface GoldenTransition {
  state: DealState;
  action: DealAction;
  role: ActorRole;
  /** The resulting state, or REFUSED meaning the machine must refuse the action. */
  expect: DealState | typeof REFUSED;
  why: string;
}

export const GOLDEN_TRANSITIONS: GoldenTransition[] = [
  // ---------------------------------------------------------------------------
  // Intake
  // ---------------------------------------------------------------------------
  {
    state: "DRAFT",
    action: "submit",
    role: "dealer",
    expect: "SUBMITTED",
    why: "The happy path starts here. Line/photo/provenance gates live in the route, not the machine.",
  },
  {
    state: "DRAFT",
    action: "submit",
    role: "admin",
    expect: REFUSED,
    why: "An admin cannot submit on a dealer's behalf.",
  },
  {
    state: "SUBMITTED",
    action: "start_review",
    role: "admin",
    expect: "UNDER_REVIEW",
    why: "Admin opens the request from the review queue.",
  },
  {
    state: "SUBMITTED",
    action: "submit",
    role: "dealer",
    expect: REFUSED,
    why: "No double-submit.",
  },

  // ---------------------------------------------------------------------------
  // The four review actions — legal in SUBMITTED and UNDER_REVIEW, nowhere else
  // ---------------------------------------------------------------------------
  {
    state: "SUBMITTED",
    action: "accept",
    role: "admin",
    expect: "DEALER_ACCEPTED",
    why: "Admin accepts the dealer's asking price outright; acceptance is provisional.",
  },
  {
    state: "SUBMITTED",
    action: "reject",
    role: "admin",
    expect: "REJECTED",
    why: "Rejection with a reason. Note this lands IN the REJECTED state — not to be confused with the REFUSED sentinel.",
  },
  {
    state: "SUBMITTED",
    action: "negotiate",
    role: "admin",
    expect: "NEGOTIATING",
    why: "Itemized per-SKU counter opens the negotiation.",
  },
  {
    state: "SUBMITTED",
    action: "request_info",
    role: "admin",
    expect: "INFO_REQUESTED",
    why: "Unit-targeted info request (BRD P4).",
  },
  {
    state: "UNDER_REVIEW",
    action: "accept",
    role: "admin",
    expect: "DEALER_ACCEPTED",
    why: "Same four actions still live after the admin opens the request.",
  },
  {
    state: "UNDER_REVIEW",
    action: "reject",
    role: "admin",
    expect: "REJECTED",
    why: "Same four actions still live after the admin opens the request.",
  },
  {
    state: "UNDER_REVIEW",
    action: "negotiate",
    role: "admin",
    expect: "NEGOTIATING",
    why: "Same four actions still live after the admin opens the request.",
  },
  {
    state: "UNDER_REVIEW",
    action: "request_info",
    role: "admin",
    expect: "INFO_REQUESTED",
    why: "Same four actions still live after the admin opens the request.",
  },

  // The dealer can never perform a review action. One representative row each —
  // the exhaustive test covers the rest.
  {
    state: "SUBMITTED",
    action: "accept",
    role: "dealer",
    expect: REFUSED,
    why: "A dealer cannot accept their own request.",
  },
  {
    state: "UNDER_REVIEW",
    action: "reject",
    role: "dealer",
    expect: REFUSED,
    why: "A dealer cannot reject their own request.",
  },
  {
    state: "UNDER_REVIEW",
    action: "request_info",
    role: "dealer",
    expect: REFUSED,
    why: "Only an admin raises an info request.",
  },

  // ...and they are ghosted once the deal moves on. These four rows are the
  // load-bearing ones — they are the difference between the BRD and the prototype.
  {
    state: "INFO_REQUESTED",
    action: "negotiate",
    role: "admin",
    expect: REFUSED,
    why: "BRD §2: the four review actions are ghosted once the ball is in the dealer's court.",
  },
  {
    state: "NEGOTIATING",
    action: "accept",
    role: "admin",
    expect: REFUSED,
    why: "BRD §2: past review, the admin closes out with a final offer, not a bare accept.",
  },
  {
    state: "NEGOTIATING",
    action: "request_info",
    role: "admin",
    expect: REFUSED,
    why: "BRD §2: review actions are gated to SUBMITTED/UNDER_REVIEW.",
  },
  {
    state: "FINAL_OFFER_SENT",
    action: "reject",
    role: "admin",
    expect: REFUSED,
    why: "BRD §2: once the offer is out, the dealer answers it; the admin cannot reject underneath them.",
  },
  {
    state: "DEALER_ACCEPTED",
    action: "negotiate",
    role: "admin",
    expect: REFUSED,
    why: "Past the review window — the admin must use reopen, which versions the offer and notifies.",
  },

  // ---------------------------------------------------------------------------
  // Info loop — the ball is in the dealer's court
  // ---------------------------------------------------------------------------
  {
    state: "INFO_REQUESTED",
    action: "resubmit",
    role: "dealer",
    expect: "UNDER_REVIEW",
    why: "Dealer supplies the missing proof; the four review actions go live again.",
  },
  {
    state: "INFO_REQUESTED",
    action: "resubmit",
    role: "admin",
    expect: REFUSED,
    why: "An admin cannot resubmit for the dealer.",
  },
  {
    state: "UNDER_REVIEW",
    action: "resubmit",
    role: "dealer",
    expect: REFUSED,
    why: "Nothing to resubmit — no info was requested.",
  },

  // ---------------------------------------------------------------------------
  // Negotiation (M07) — every counter is itemized per SKU
  // ---------------------------------------------------------------------------
  {
    state: "NEGOTIATING",
    action: "dealer_counter",
    role: "dealer",
    expect: "NEGOTIATING",
    why: "Self-loop: each counter appends a round and stays in NEGOTIATING.",
  },
  {
    state: "NEGOTIATING",
    action: "dealer_counter",
    role: "admin",
    expect: REFUSED,
    why: "The dealer's action is the dealer's. An admin counters via admin_counter.",
  },
  {
    // item 7 — the admin's own counter, the mirror of dealer_counter. Makes the
    // negotiation symmetric: the admin no longer has to send a final offer just
    // to name another price.
    state: "NEGOTIATING",
    action: "admin_counter",
    role: "admin",
    expect: "NEGOTIATING",
    why: "Self-loop: the admin counters per SKU and stays in NEGOTIATING, exactly as the dealer does.",
  },
  {
    state: "NEGOTIATING",
    action: "admin_counter",
    role: "dealer",
    expect: REFUSED,
    why: "The admin's action is the admin's — a dealer counters via dealer_counter.",
  },
  {
    state: "SUBMITTED",
    action: "admin_counter",
    role: "admin",
    expect: REFUSED,
    why: "There is no open negotiation to counter within yet — `negotiate` opens it first.",
  },
  {
    state: "NEGOTIATING",
    action: "send_final_offer",
    role: "admin",
    expect: "FINAL_OFFER_SENT",
    why: "The fifth action: admin closes out the negotiation with an itemized, versioned final offer.",
  },
  {
    state: "UNDER_REVIEW",
    action: "send_final_offer",
    role: "admin",
    expect: "FINAL_OFFER_SENT",
    why: "Admin may skip the counter dance and go straight to a final offer.",
  },
  {
    state: "SUBMITTED",
    action: "send_final_offer",
    role: "admin",
    expect: REFUSED,
    why: "The request must be opened for review first.",
  },
  {
    state: "NEGOTIATING",
    action: "send_final_offer",
    role: "dealer",
    expect: REFUSED,
    why: "Only iTarang issues the final offer.",
  },

  // ---------------------------------------------------------------------------
  // Final offer — ONE binary answer for the whole itemized set (U5)
  // ---------------------------------------------------------------------------
  {
    state: "FINAL_OFFER_SENT",
    action: "dealer_accept",
    role: "dealer",
    expect: "DEALER_ACCEPTED",
    why: "Accept the full set. Provisional until vendor agreement.",
  },
  {
    state: "FINAL_OFFER_SENT",
    action: "dealer_decline",
    role: "dealer",
    expect: "NEGOTIATING",
    why: "Decline reopens the negotiation.",
  },
  {
    state: "FINAL_OFFER_SENT",
    action: "dealer_accept",
    role: "admin",
    expect: REFUSED,
    why: "An admin cannot accept the offer on the dealer's behalf.",
  },
  {
    state: "NEGOTIATING",
    action: "dealer_accept",
    role: "dealer",
    expect: REFUSED,
    why: "There is no offer on the table to accept.",
  },

  // ---------------------------------------------------------------------------
  // Margin (M08)
  // ---------------------------------------------------------------------------
  {
    state: "DEALER_ACCEPTED",
    action: "set_margin",
    role: "admin",
    expect: "MARGIN_SET",
    why: "Per-line margin locked into deal_line_locks.",
  },
  {
    state: "DEALER_ACCEPTED",
    action: "set_margin",
    role: "dealer",
    expect: REFUSED,
    why: "The dealer never sees margin, let alone sets it (BRD M08 AC).",
  },
  {
    state: "MARGIN_SET",
    action: "set_margin",
    role: "admin",
    expect: REFUSED,
    why: "Locks are immutable — a change requires a reopen, which versions them.",
  },
  {
    state: "UNDER_REVIEW",
    action: "set_margin",
    role: "admin",
    expect: REFUSED,
    why: "No accepted price to add margin to yet.",
  },

  // ---------------------------------------------------------------------------
  // Reopen (M07 AC) — allowed BEFORE vendor agreement, never at or after it
  // ---------------------------------------------------------------------------
  {
    state: "DEALER_ACCEPTED",
    action: "reopen",
    role: "admin",
    expect: "NEGOTIATING",
    why: "Dealer acceptance is provisional; reopen bumps offer_version and notifies.",
  },
  {
    state: "MARGIN_SET",
    action: "reopen",
    role: "admin",
    expect: "NEGOTIATING",
    why: "Reopen after margin lock inserts a NEW lock generation at the new version.",
  },
  {
    state: "VENDOR_ROUTED",
    action: "reopen",
    role: "admin",
    expect: "NEGOTIATING",
    why: "Still reopenable — the vendor has not agreed yet.",
  },
  {
    state: "VENDOR_AGREED",
    action: "reopen",
    role: "admin",
    expect: REFUSED,
    why: "THE boundary (BRD M07 AC): reopen after vendor agreement is rejected server-side.",
  },
  {
    state: "PICKED_UP",
    action: "reopen",
    role: "admin",
    expect: REFUSED,
    why: "Far past the boundary.",
  },
  {
    state: "CLOSED",
    action: "reopen",
    role: "admin",
    expect: REFUSED,
    why: "A closed deal is immutable.",
  },
  {
    state: "DEALER_ACCEPTED",
    action: "reopen",
    role: "dealer",
    expect: REFUSED,
    why: "Only iTarang reopens a deal.",
  },
  {
    state: "NEGOTIATING",
    action: "reopen",
    role: "admin",
    expect: REFUSED,
    why: "Already negotiating — nothing to reopen.",
  },

  // ---------------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------------
  {
    state: "DRAFT",
    action: "cancel",
    role: "dealer",
    expect: "CANCELLED",
    why: "A dealer may abandon their own draft.",
  },
  {
    state: "NEGOTIATING",
    action: "cancel",
    role: "admin",
    expect: "CANCELLED",
    why: "Cancel closes open threads and notifies (BRD §2).",
  },
  {
    state: "MARGIN_SET",
    action: "cancel",
    role: "admin",
    expect: "CANCELLED",
    why: "Still cancellable before the vendor leg.",
  },
  {
    state: "NEGOTIATING",
    action: "cancel",
    role: "dealer",
    expect: REFUSED,
    why: "Once submitted and in play, only iTarang cancels.",
  },

  // ---------------------------------------------------------------------------
  // Terminal states — REJECTED has no way out (business-confirmed)
  // ---------------------------------------------------------------------------
  {
    state: "REJECTED",
    action: "resubmit",
    role: "dealer",
    expect: REFUSED,
    why: "REJECTED is terminal (BRD §2). The dealer raises a NEW request; fixable problems go through request_info instead.",
  },
  {
    state: "REJECTED",
    action: "start_review",
    role: "admin",
    expect: REFUSED,
    why: "No admin undo in v1.",
  },
  {
    state: "CANCELLED",
    action: "submit",
    role: "dealer",
    expect: REFUSED,
    why: "Terminal.",
  },
  {
    state: "CLOSED",
    action: "cancel",
    role: "admin",
    expect: REFUSED,
    why: "Terminal.",
  },

  // ---------------------------------------------------------------------------
  // Sprint-2 states have no dealer-leg actions yet — they must not be reachable
  // sideways through a Sprint-1 action.
  // ---------------------------------------------------------------------------
  {
    state: "VENDOR_AGREED",
    action: "set_margin",
    role: "admin",
    expect: REFUSED,
    why: "Margin is locked long before this; no re-lock after the vendor agrees.",
  },
  {
    state: "DEALER_REOPENED",
    action: "send_final_offer",
    role: "admin",
    expect: REFUSED,
    why: "DEALER_REOPENED is declared but unreachable — reopen goes to NEGOTIATING.",
  },
  {
    state: "SETTLED",
    action: "dealer_counter",
    role: "dealer",
    expect: REFUSED,
    why: "The money is moving; there is nothing to counter.",
  },

  // ---------------------------------------------------------------------------
  // SPRINT 2A — the vendor leg and fulfilment (M09–M11 + minimal M05).
  //
  // There is no `vendor` actor: v1 ships without vendor login (M24), so an admin
  // RECORDS what the vendor said. Every one of these is therefore admin-only,
  // and a dealer attempting any of them must be refused.
  // ---------------------------------------------------------------------------
  {
    state: "MARGIN_SET",
    action: "route_to_vendors",
    role: "admin",
    expect: "VENDOR_ROUTED",
    why: "The margin is locked, so the ask is known and the deal can be quoted out (M09).",
  },
  {
    state: "MARGIN_SET",
    action: "route_to_vendors",
    role: "dealer",
    expect: REFUSED,
    why: "A dealer must never see, let alone drive, the vendor leg.",
  },
  {
    state: "DEALER_ACCEPTED",
    action: "route_to_vendors",
    role: "admin",
    expect: REFUSED,
    why: "No margin is locked yet — there is no ask to quote. M08's floor guard has nothing to check.",
  },
  {
    state: "VENDOR_ROUTED",
    action: "record_vendor_counter",
    role: "admin",
    expect: "VENDOR_NEGOTIATING",
    why: "A vendor came back with a per-SKU counter; the vendor leg is live (M10).",
  },
  {
    state: "VENDOR_ROUTED",
    action: "record_vendor_agreement",
    role: "admin",
    expect: "VENDOR_AGREED",
    why: "A vendor said yes at our ask, with no counter round.",
  },
  {
    state: "VENDOR_NEGOTIATING",
    action: "record_vendor_counter",
    role: "admin",
    expect: "VENDOR_NEGOTIATING",
    why: "Self-loop — each further counter appends a round, as on the dealer leg.",
  },
  {
    state: "VENDOR_NEGOTIATING",
    action: "record_vendor_agreement",
    role: "admin",
    expect: "VENDOR_AGREED",
    why: "First AGREED wins; the DB's partial unique index makes that atomic (M10).",
  },
  {
    state: "VENDOR_NEGOTIATING",
    action: "record_vendor_counter",
    role: "dealer",
    expect: REFUSED,
    why: "Vendor responses are admin-recorded or vendor-made. A dealer cannot forge one.",
  },

  // ---------------------------------------------------------------------------
  // Vendor leg, first-hand (E-195 — the vendor login, BRD M24)
  //
  // The same two destinations as the record_* pair above. A vendor acting from
  // their own dashboard is not a new kind of deal event; it is the same event
  // with better evidence behind it. Both paths stay: a vendor who answers the
  // quotation email instead of logging in is still recorded by an admin.
  // ---------------------------------------------------------------------------
  {
    state: "VENDOR_ROUTED",
    action: "vendor_counter",
    role: "vendor",
    expect: "VENDOR_NEGOTIATING",
    why: "The vendor countered our ask from their own dashboard — same move as an admin recording it, first-hand.",
  },
  {
    state: "VENDOR_ROUTED",
    action: "vendor_agree",
    role: "vendor",
    expect: "VENDOR_AGREED",
    why: "The vendor accepted our ask outright. First AGREED wins — the partial unique index makes that atomic however it was entered (M10).",
  },
  {
    state: "VENDOR_NEGOTIATING",
    action: "vendor_counter",
    role: "vendor",
    expect: "VENDOR_NEGOTIATING",
    why: "Self-loop — each further counter appends a round, exactly as on the admin-recorded path.",
  },
  {
    state: "VENDOR_NEGOTIATING",
    action: "vendor_agree",
    role: "vendor",
    expect: "VENDOR_AGREED",
    why: "The vendor closed the haggle themselves.",
  },
  {
    state: "VENDOR_ROUTED",
    action: "vendor_counter",
    role: "admin",
    expect: REFUSED,
    why: "An admin recording a vendor's reply must use record_vendor_counter. Letting them use the first-hand action would launder hearsay into evidence in the audit log.",
  },
  {
    state: "VENDOR_ROUTED",
    action: "vendor_agree",
    role: "dealer",
    expect: REFUSED,
    why: "A dealer cannot agree on a vendor's behalf — that would let the seller close their own sale at a price of their choosing.",
  },
  {
    state: "MARGIN_SET",
    action: "vendor_agree",
    role: "vendor",
    expect: REFUSED,
    why: "Nothing has been quoted to this vendor yet — there is no ask to agree to until the deal is routed.",
  },
  {
    state: "VENDOR_AGREED",
    action: "vendor_counter",
    role: "vendor",
    expect: REFUSED,
    why: "A vendor has already agreed. Reopening the price after agreement is exactly what M07's boundary forbids, and a losing vendor cannot reopen someone else's win.",
  },
  {
    state: "SUBMITTED",
    action: "vendor_counter",
    role: "vendor",
    expect: REFUSED,
    why: "A vendor has no visibility of a deal before it is routed, let alone a say in the dealer leg.",
  },
  {
    state: "VENDOR_NEGOTIATING",
    action: "reopen",
    role: "admin",
    expect: "NEGOTIATING",
    why: "Still BEFORE vendor agreement, so reopen is legal (BRD §2). Open threads are closed LOST in the same tx.",
  },

  // THE BOUNDARY (M07 AC). Everything from VENDOR_AGREED on is a commitment to a
  // third party; moving the dealer's price now would silently change what
  // iTarang earns on a deal it has already sold.
  {
    state: "VENDOR_AGREED",
    action: "reopen",
    role: "admin",
    expect: REFUSED,
    why: "M07 AC: reopen after vendor agreement is rejected SERVER-SIDE, not merely hidden.",
  },
  {
    state: "PO_EXCHANGED",
    action: "reopen",
    role: "admin",
    expect: REFUSED,
    why: "Past the boundary. POs are already out with both counterparties.",
  },
  {
    state: "PICKED_UP",
    action: "reopen",
    role: "admin",
    expect: REFUSED,
    why: "Past the boundary, and the batteries are physically ours.",
  },

  // POs are impossible before VENDOR_AGREED (M11 AC).
  {
    state: "VENDOR_AGREED",
    action: "exchange_pos",
    role: "admin",
    expect: "PO_EXCHANGED",
    why: "Fires inside the tx that records whichever PO completes the pair (M11).",
  },
  {
    // E-196 — the vendor raises their own PO. On the vendor leg the vendor is
    // the buyer, and the buyer initiates the PO.
    state: "VENDOR_AGREED",
    action: "exchange_pos",
    role: "vendor",
    expect: "PO_EXCHANGED",
    why: "The vendor raised their own PO; the same edge, whoever completes the pair (E-196).",
  },
  {
    state: "VENDOR_AGREED",
    action: "exchange_pos",
    role: "dealer",
    expect: REFUSED,
    why: "A dealer has no part in the vendor leg — the batteries have been sold on.",
  },
  {
    state: "VENDOR_NEGOTIATING",
    action: "exchange_pos",
    role: "vendor",
    expect: REFUSED,
    why: "No PO before agreement, even by the vendor — there is no agreed price to invoice against.",
  },
  {
    state: "VENDOR_NEGOTIATING",
    action: "exchange_pos",
    role: "admin",
    expect: REFUSED,
    why: "M11 AC: a PO is impossible before a vendor has agreed — there is no counterparty yet.",
  },
  {
    state: "MARGIN_SET",
    action: "exchange_pos",
    role: "admin",
    expect: REFUSED,
    why: "M11 AC: no vendor, no PO.",
  },

  // Fulfilment.
  {
    state: "PO_EXCHANGED",
    action: "schedule_pickup",
    role: "admin",
    expect: "PICKUP_SCHEDULED",
    why: "Both POs are exchanged; collection can be booked.",
  },
  {
    state: "VENDOR_AGREED",
    action: "schedule_pickup",
    role: "admin",
    expect: REFUSED,
    why: "Nothing is collected before the paperwork is exchanged.",
  },
  {
    state: "PICKUP_SCHEDULED",
    action: "complete_pickup",
    role: "admin",
    expect: "PICKED_UP",
    why: "The batteries are in iTarang's hands. Sprint 2B raises the invoice from here.",
  },
  {
    state: "PICKUP_SCHEDULED",
    action: "complete_pickup",
    role: "dealer",
    expect: REFUSED,
    why: "A dealer cannot declare their own collection complete — that is the variance fraud M05 guards against.",
  },

  // Cancellation stops at the loading bay.
  {
    state: "PICKUP_SCHEDULED",
    action: "cancel",
    role: "admin",
    expect: "CANCELLED",
    why: "Nothing has moved yet; the deal can still be called off.",
  },
  {
    state: "PICKED_UP",
    action: "cancel",
    role: "admin",
    expect: REFUSED,
    why: "The goods are physically collected. Undoing that is a RETURN, not a cancellation, and v1 has no returns flow — so the machine refuses rather than pretending.",
  },

  // ---------------------------------------------------------------------------
  // SPRINT 2B — the money leg (M12–M14).
  //
  // The dealer performs exactly ONE action here: raising their own invoice. It is
  // their legal document on their own GST series. Everything else — approving,
  // returning, recording money, closing — is iTarang's.
  // ---------------------------------------------------------------------------
  {
    state: "PICKED_UP",
    action: "raise_invoice",
    role: "dealer",
    expect: "INVOICE_RAISED",
    why: "The batteries are collected, so the dealer can bill us (M12).",
  },
  {
    state: "PICKED_UP",
    action: "raise_invoice",
    role: "admin",
    expect: REFUSED,
    why: "iTarang cannot raise an invoice on the dealer's behalf — it would be a number on someone else's GST series.",
  },
  {
    state: "PICKUP_SCHEDULED",
    action: "raise_invoice",
    role: "dealer",
    expect: REFUSED,
    why: "Nothing has been collected yet. Billing for goods still on your floor is the fraud the pickup gate exists to stop.",
  },
  {
    state: "MARGIN_SET",
    action: "raise_invoice",
    role: "dealer",
    expect: REFUSED,
    why: "No vendor, no PO, no collection — there is nothing to bill for.",
  },
  {
    state: "INVOICE_RAISED",
    action: "approve_invoice",
    role: "admin",
    expect: "INVOICE_APPROVED",
    why: "Every line matched the locks. The route does the comparing; the machine only says who may try (M12).",
  },
  {
    state: "INVOICE_RAISED",
    action: "approve_invoice",
    role: "dealer",
    expect: REFUSED,
    why: "A dealer approving their own invoice is the entire point of having an approval step.",
  },
  {
    state: "INVOICE_RAISED",
    action: "return_invoice",
    role: "admin",
    expect: "PICKED_UP",
    why: "Sent back with a reason. No RETURNED state is needed: the deal returns to 'collected, unbilled' and the dealer raises a fresh invoice (U8).",
  },
  {
    state: "INVOICE_APPROVED",
    action: "record_settlement",
    role: "admin",
    expect: "INVOICE_APPROVED",
    why: "Self-loop — one side of a two-sided trade has moved. The deal is not settled until BOTH legs are closed.",
  },
  {
    state: "INVOICE_APPROVED",
    action: "record_settlement",
    role: "dealer",
    expect: REFUSED,
    why: "A dealer cannot record that they were paid. That is how an unevidenced payout gets into the ledger.",
  },
  {
    state: "INVOICE_APPROVED",
    action: "settle",
    role: "admin",
    expect: "SETTLED",
    why: "Fires inside the transaction that records whichever settlement CLOSES the pair (M13).",
  },
  {
    state: "PICKED_UP",
    action: "settle",
    role: "admin",
    expect: REFUSED,
    why: "No approved invoice, so there is nothing to pay against.",
  },
  {
    state: "SETTLED",
    action: "close_deal",
    role: "admin",
    expect: "CLOSED",
    why: "A deliberate human act. CLOSED is what M15 asserts a complete document set against and M14 reconciles margin on.",
  },
  {
    state: "SETTLED",
    action: "close_deal",
    role: "dealer",
    expect: REFUSED,
    why: "Closing the deal is iTarang's call, not the counterparty's.",
  },
  {
    state: "INVOICE_APPROVED",
    action: "close_deal",
    role: "admin",
    expect: REFUSED,
    why: "The money has not moved yet. A deal cannot be closed before it is settled.",
  },
  {
    state: "CLOSED",
    action: "reopen",
    role: "admin",
    expect: REFUSED,
    why: "CLOSED is terminal. Its margin is final and its ledger row is history — reopening it would silently restate a reconciled number.",
  },
  {
    state: "CLOSED",
    action: "record_settlement",
    role: "admin",
    expect: REFUSED,
    why: "Money cannot be added to a closed deal; the ledger would stop reconciling against the locks (M14 AC).",
  },
];
