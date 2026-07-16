/**
 * peakAmp Battery Buyback — the FLOW step map for the UI stepper (proto
 * FLOW / FLOWLABEL, iTarang Portal.dc.html:161-162).
 *
 * Client-safe: no db, no auth, no I/O. Deliberately NOT the same module as
 * src/lib/buyback/state-machine.ts (the server-side transition gate) — that
 * file is the source of truth for all 21 `buyback_deal_status` values
 * (drizzle/E-185_buyback_core.sql) including the ones that never appear on
 * the happy-path stepper. This file only answers "where does the stepper's
 * dot sit for this status."
 *
 * `inr` is intentionally NOT re-implemented here: src/lib/buyback/format.ts
 * already has a client-safe Indian-grouped formatter (no db/auth imports) —
 * every UI atom that needs money formatting imports it from there.
 */

export const FLOW = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
  "DEALER_ACCEPTED",
  "MARGIN_SET",
  "VENDOR_ROUTED",
  "VENDOR_AGREED",
  "PO_EXCHANGED",
  "PICKUP_SCHEDULED",
  "PICKED_UP",
  "INVOICE_APPROVED",
  "SETTLED",
  "CLOSED",
] as const;

export const FLOW_LABEL: Record<(typeof FLOW)[number], string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Review",
  NEGOTIATING: "Negotiate",
  FINAL_OFFER_SENT: "Final Offer",
  DEALER_ACCEPTED: "Accepted",
  MARGIN_SET: "Margin",
  VENDOR_ROUTED: "Vendor",
  VENDOR_AGREED: "Agreed",
  PO_EXCHANGED: "PO",
  PICKUP_SCHEDULED: "Pickup",
  PICKED_UP: "Picked Up",
  INVOICE_APPROVED: "Invoice",
  SETTLED: "Settled",
  CLOSED: "Closed",
};

/**
 * Maps any of the 21 `buyback_deal_status` enum values onto a FLOW index for
 * the stepper, or "terminal" for the two dead ends (REJECTED / CANCELLED).
 *
 * Off-FLOW statuses collapse onto the FLOW step they are logically "inside":
 * - DRAFT has done nothing yet — the stepper hasn't started (index 0, same
 *   dot as SUBMITTED, which is the deal's very first real step).
 * - INFO_REQUESTED / DEALER_REOPENED / VENDOR_NEGOTIATING are sub-states of a
 *   FLOW step (still under review / still negotiating / still routed) — they
 *   share that step's dot rather than getting one of their own.
 * - INVOICE_RAISED sits between PICKED_UP and INVOICE_APPROVED (the dealer
 *   has raised it but admin hasn't approved it yet) — one index past
 *   PICKED_UP, mirroring the prototype's stepper() exactly.
 *
 * Any other/unknown status falls back to 0 rather than throwing — a stepper
 * should never crash a page over an unrecognised status string.
 */
export function stepIndexFor(status: string): number | "terminal" {
  if (status === "REJECTED" || status === "CANCELLED") return "terminal";
  if (status === "DRAFT") return 0;
  if (status === "INFO_REQUESTED") return FLOW.indexOf("UNDER_REVIEW");
  if (status === "DEALER_REOPENED") return FLOW.indexOf("NEGOTIATING");
  if (status === "VENDOR_NEGOTIATING") return FLOW.indexOf("VENDOR_ROUTED");
  if (status === "INVOICE_RAISED") return FLOW.indexOf("PICKED_UP") + 1;

  const idx = FLOW.indexOf(status as (typeof FLOW)[number]);
  return idx >= 0 ? idx : 0;
}
