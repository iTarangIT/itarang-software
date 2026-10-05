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
  // `quote_released` — the quote cleared the approval gate (ID 75 rename).
  // Written by both approval paths since 1 Oct 2026. `quote_sent` is the SAME
  // event under its old name (E-221 until the rename): never written again,
  // kept so history still parses and renders. Readers must accept both —
  // use QUOTE_RELEASED_TYPES / isQuoteReleased, never a bare literal.
  "quote_released",
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
  // 29 Sep 2026 — lead events (tracker IDs 81, 82, 36). None is work.
  "lead_created",
  "lead_reinquiry",
  "sales_ready",
  "contactability_flag",
] as const;
export type TouchpointType = (typeof TOUCHPOINT_TYPE)[number];

/**
 * ID 75: every stored value that means "quote released" — the new name first,
 * then the legacy `quote_sent` rows (no data rewrite). SQL readers bind this
 * array (e.g. `touchpoint_type = ANY(${[...QUOTE_RELEASED_TYPES]})`).
 */
export const QUOTE_RELEASED_TYPES = ["quote_released", "quote_sent"] as const satisfies readonly TouchpointType[];

export function isQuoteReleased(type: string | null | undefined): boolean {
  return type != null && (QUOTE_RELEASED_TYPES as readonly string[]).includes(type);
}

/**
 * Whether a touchpoint counts as WORK on a lead and resets its idle clock
 * (dealer_leads.last_worked_at, E-300). Requirement #6 point 7: "Only a logged
 * call, visit or status change — never just opening the lead, or people will
 * open leads and change nothing to reset the clock." Review R-04 / metric M18.
 *
 *   inside_sales_call   any outcome, including NeoDove calls (performed_by null)
 *   visit               logged ASM visit
 *   status_change_note  ONLY when it carries a real status change (mark
 *                       converted / lost, bulk status, the call form). The same
 *                       type is also written as a plain NOTE — bulk-upload call
 *                       notes, reactivation, NeoDove "deleted remotely" flags,
 *                       merge resolutions — and a note is not work.
 *
 * A status change on any OTHER type does not count: claiming, assigning and
 * transferring to an ASM all move lead_status, and counting them would let a
 * hand-off make a neglected lead look fresh — the exact bug R-04 is.
 *
 * NOT counted: ai_call — the robot dialling a rep's lead is not the holder
 * working it, and would hide neglect the same way. Nor dial requests,
 * WhatsApp, quotes, escalations or reactivation.
 *
 * Nor an admin's "Correct status" (ID 80): it is a status_change_note that
 * carries a status change, but it repairs the record — nobody spoke to the
 * dealer. Pass the status event; "correction" never counts.
 *
 * The E-300 backfill encodes the same rule in SQL; keep them in step.
 */
export function isWorkedTouchpoint(
  type: TouchpointType,
  hasStatusChange: boolean,
  /** The status change's event, when there is one (statusRules.ts). */
  statusEvent?: string | null,
): boolean {
  if (type === "inside_sales_call" || type === "visit") return true;
  return type === "status_change_note" && hasStatusChange && statusEvent !== "correction";
}

/**
 * ID 115.2: the touchpoints that are a conversation with the dealer — a call, a
 * visit or a WhatsApp chat. Only these may ask for first contact
 * (Under_Discussion) on the touchpoint form; a note cannot.
 */
export const CONVERSATION_TOUCHPOINT_TYPES: readonly TouchpointType[] = [
  "inside_sales_call",
  "visit",
  "whatsapp",
];

export function isConversationTouchpoint(type: TouchpointType): boolean {
  return CONVERSATION_TOUCHPOINT_TYPES.includes(type);
}

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

// ── Engaged call (tracker ID 59, decided 3 Oct 2026) ────────────────────────
// A connected human call where the rep spoke with the dealer — through NeoDove
// or logged by the rep, any outcome. Duration never counts and neither does the
// lead's temperature. (26 Sep – 3 Oct the rule was "connected and 30 s or more
// of NeoDove-recorded duration", with a setting for the threshold; both are
// gone.)
//
// This is what the writers store in is_engaged; the SQL fragments every report
// reads (reports/metricDefinitions.ts) state the same rule.
export function isEngagedCall(ctx: { callStatus?: string | null }): boolean {
  return ctx.callStatus === "connected";
}

// Touchpoint types that are auto-engaged per BRD §0.1 Glossary:
//   * a connected inside_sales_call — isEngagedCall() above
//   * visit with outcome productive / commercials_progressed
// Other types require manual is_engaged flag (rep's judgment).
export function shouldAutoEngage(
  type: TouchpointType,
  ctx: {
    callStatus?: CallStatus | null;
    visitOutcome?: string | null;
  },
): boolean {
  if (type === "inside_sales_call") {
    return isEngagedCall({ callStatus: ctx.callStatus });
  }
  if (
    type === "visit" &&
    (ctx.visitOutcome === "productive" ||
      ctx.visitOutcome === "commercials_progressed")
  ) {
    return true;
  }
  return false;
}
