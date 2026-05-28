// Part 0 BRD canonical touchpoint_type enum (22 values).
// BRD §0.13. The matching DB column is lead_touchpoints.touchpoint_type varchar(50).

export const TOUCHPOINT_TYPE = [
  // AI dialer + manual call interactions
  "ai_call",
  "inside_sales_call",
  "whatsapp",
  // Commercials / collateral
  "brochure_sent",
  "quote_sent",
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
