// Part 0 BRD canonical touchpoint_type enum (22 values) + 1 added since.
// BRD §0.13. The matching DB column is lead_touchpoints.touchpoint_type
// varchar(50) — free text, no CHECK constraint, so this list is the only
// enforcement and adding to it needs no migration.
//
// `neodove_dial_request` (E-226) is the one non-BRD value. It is deliberately
// NOT `inside_sales_call`: a priority-dial request is a lead being handed to the
// calling team, not a conversation, and counting it as a call would inflate
// every call-volume and connect-rate figure in §0.11. It is equally not
// `ai_dialer_admin_push` — that means the robot dialler, and the AI-vs-human
// split depends on the two staying distinct.

export const TOUCHPOINT_TYPE = [
  // AI dialer + manual call interactions
  "ai_call",
  "inside_sales_call",
  "whatsapp",
  // Hand-off to an external calling vendor (E-226)
  "neodove_dial_request",
  // Commercials / collateral
  "brochure_sent",
  // `quote_sent` means RELEASED — the quote cleared the approval gate. It has
  // meant that since E-221 and is written by both approval paths.
  "quote_sent",
  // E-242 registers three values that were already being WRITTEN and were never
  // listed here. `quote_submitted` (inside-sales commercials route) and
  // `quote_rejected` (CEO decision route) have been written since E-221 while
  // TOUCHPOINT_TYPE knew only `quote_sent`, so every one of them rendered with
  // the fallback icon and label. `quote_dispatched` is new: it is the moment
  // the document actually reached the dealer over WhatsApp or email, which is a
  // different event from clearing approval and must not reuse `quote_sent`.
  "quote_submitted",
  "quote_rejected",
  "quote_dispatched",
  // E-243 — the DEALER's answer, which is a different actor from every other
  // value in this list. These are the only touchpoints not performed by an
  // iTarang user, so the remark names who actually acted while performed_by
  // carries the owner the entry belongs to.
  "quote_dealer_approved",
  "quote_dealer_declined",
  // Status transitions
  "status_change_note",
  // Ownership lifecycle
  "lead_assigned",
  "lead_claimed",
  "ownership_transfer",
  "asm_transfer",
  // ASM ground work
  "visit",
  // Escalation lifecycle
  "escalation_raised",
  "escalation_resolved_reassign",
  "escalation_resolved_returned",
  "escalation_resolved_no_action",
  "escalation_ceo_comment",
  "escalation_ceo_recommendation",
  // Reactivation (BRD §0.9)
  "reactivated_via_ai_dialer",
  "reactivated_via_upload",
  "reactivated_via_admin",
  "ai_dialer_admin_push",
  // Post-conversion loopback (BRD §0.11)
  "onboarding_dropout_action",
] as const;
export type TouchpointType = (typeof TOUCHPOINT_TYPE)[number];

export const CALL_STATUS = [
  "connected",
  "not_reachable",
  "not_responding",
  "incorrect_number",
  "no_incoming",
] as const;
export type CallStatus = (typeof CALL_STATUS)[number];

export const NEXT_ACTION = [
  "follow_up",
  "no_action",
  "transfer_to_asm",
  "mark_lost",
  "mark_converted",
] as const;
export type NextAction = (typeof NEXT_ACTION)[number];

// Touchpoint types that are auto-engaged per BRD §0.1 Glossary:
//   * connected inside_sales_call
//   * visit with outcome productive / commercials_progressed
// Other types require manual is_engaged flag (rep's judgment).
export function shouldAutoEngage(
  type: TouchpointType,
  ctx: { callStatus?: CallStatus | null; visitOutcome?: string | null },
): boolean {
  if (type === "inside_sales_call" && ctx.callStatus === "connected") return true;
  if (
    type === "visit" &&
    (ctx.visitOutcome === "productive" ||
      ctx.visitOutcome === "commercials_progressed")
  ) {
    return true;
  }
  return false;
}
