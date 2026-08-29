/**
 * The words a touchpoint is shown as — split out from touchpointDisplay so
 * SERVER code can read them.
 *
 * touchpointDisplay pairs each label with a lucide-react icon component, which
 * makes it a React module; the .xlsx exports need the wording and nothing else.
 * Without this split the exports either drag React into an API route or
 * hand-roll a second copy of the vocabulary — and a second copy is exactly what
 * touchpointDisplay's own header warns against, because then a lead's history
 * reads one way on screen and another way in the file someone was sent.
 *
 * touchpointDisplay re-exports TOUCHPOINT_TYPE_LABEL, so every existing
 * importer is unaffected.
 */

import type {
    CallStatus,
    NextAction,
    TouchpointType,
} from "@/lib/lifecycle/touchpointTypes";

export const TOUCHPOINT_TYPE_LABEL: Record<TouchpointType, string> = {
    ai_call: "AI call",
    inside_sales_call: "Call",
    // "Requested", not "Called": the CRM asked NeoDove to work this lead next.
    // Whether anybody dialled shows up later as a separate call touchpoint.
    neodove_dial_request: "Priority dial requested",
    whatsapp: "WhatsApp",
    brochure_sent: "Brochure sent",
    // "Released", not "Delivered": this is the quote clearing the approval gate.
    // Whether it reached the dealer is `quote_dispatched`.
    quote_sent: "Quote approved & released",
    quote_submitted: "Quote sent for approval",
    quote_rejected: "Quote rejected",
    quote_dispatched: "Quote sent to dealer",
    quote_dealer_approved: "Dealer approved quote",
    quote_dealer_declined: "Dealer declined quote",
    status_change_note: "Status update",
    lead_assigned: "Assigned",
    lead_claimed: "Claimed",
    ownership_transfer: "Reassigned",
    asm_transfer: "Transferred to ASM",
    visit: "Visit",
    escalation_raised: "Escalation raised",
    escalation_resolved_reassign: "Escalation → reassigned",
    escalation_resolved_returned: "Escalation → returned",
    escalation_resolved_no_action: "Escalation → no action",
    escalation_ceo_comment: "CEO comment",
    escalation_ceo_recommendation: "CEO recommendation",
    reactivated_via_ai_dialer: "Reactivated (AI)",
    reactivated_via_upload: "Reactivated (upload)",
    reactivated_via_admin: "Reactivated (admin)",
    ai_dialer_admin_push: "Pushed to AI dialer",
    onboarding_dropout_action: "Onboarding loopback",
};

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
    connected: "Connected",
    not_reachable: "Not reachable",
    not_responding: "Not responding",
    incorrect_number: "Incorrect number",
    no_incoming: "No incoming",
};

export const NEXT_ACTION_LABEL: Record<NextAction, string> = {
    follow_up: "Follow up",
    no_action: "No action",
    transfer_to_asm: "Transfer to ASM",
    mark_lost: "Mark lost",
    mark_converted: "Mark converted",
};

/**
 * Label lookup that never loses data.
 *
 * touchpoint_type is a varchar with no CHECK constraint, so the DB can hold a
 * value this map has never heard of (an older row, or a type added in code that
 * skipped the vocabulary). Falling back to a de-underscored version of the raw
 * value keeps such a row readable instead of blank — a blank cell in an export
 * reads as "nothing happened".
 */
export function humanise(
    value: string | null | undefined,
    map: Record<string, string>,
    fallback = "—",
): string {
    if (!value) return fallback;
    return map[value] ?? value.replace(/_/g, " ");
}
