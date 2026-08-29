// Presentation for the 22 TOUCHPOINT_TYPE values — icon and human label.
//
// Extracted so the two timelines that render touchpoints (the inside-sales
// workspace pane and the CRM lead-detail timeline) cannot drift apart. Adding a
// type to TOUCHPOINT_TYPE without adding it here is a type error in both maps,
// which is the point: a new type must never render as a bare snake_case string
// in one screen and a proper label in the other.

import {
    Phone,
    PhoneForwarded,
    MessageSquare,
    FileText,
    Receipt,
    Repeat,
    AlertCircle,
    UserPlus2,
    UserMinus2,
    Activity,
    Sparkles,
    Send,
    FileCheck2,
    FileX2,
    ThumbsUp,
    ThumbsDown,
} from "lucide-react";
import type { TouchpointType } from "@/lib/lifecycle/touchpointTypes";

export type TouchpointIcon = React.ComponentType<{ className?: string }>;

export const TOUCHPOINT_ICONS: Record<TouchpointType | "default", TouchpointIcon> = {
    ai_call: Sparkles,
    inside_sales_call: Phone,
    neodove_dial_request: PhoneForwarded,
    whatsapp: MessageSquare,
    brochure_sent: FileText,
    quote_sent: Receipt,
    quote_submitted: FileCheck2,
    quote_rejected: FileX2,
    quote_dispatched: Send,
    quote_dealer_approved: ThumbsUp,
    quote_dealer_declined: ThumbsDown,
    status_change_note: Activity,
    lead_assigned: UserPlus2,
    lead_claimed: UserPlus2,
    ownership_transfer: Repeat,
    asm_transfer: Repeat,
    visit: UserMinus2,
    escalation_raised: AlertCircle,
    escalation_resolved_reassign: Repeat,
    escalation_resolved_returned: Repeat,
    escalation_resolved_no_action: Activity,
    escalation_ceo_comment: MessageSquare,
    escalation_ceo_recommendation: AlertCircle,
    reactivated_via_ai_dialer: Sparkles,
    reactivated_via_upload: Sparkles,
    reactivated_via_admin: Sparkles,
    ai_dialer_admin_push: Sparkles,
    onboarding_dropout_action: AlertCircle,
    default: Activity,
};

// The wording now lives in touchpointLabels.ts so the .xlsx exports can read
// it without importing this React module. Re-exported here because both
// timelines already import it from this path.
export { TOUCHPOINT_TYPE_LABEL } from "@/lib/lifecycle/touchpointLabels";

/**
 * Where a touchpoint came from, for the CRM timeline's provenance badge.
 *
 * This distinction is load-bearing for NeoDove, not decorative. `api` means the
 * disposition arrived live on their webhook; `reconciliation` means the webhook
 * was LOST and the row had to be backfilled from a CSV export. A user reading
 * call history needs to know which, because a screen full of `reconciliation`
 * rows means deliveries are being dropped silently.
 */
export function touchpointSourceLabel(
    externalSystem: string | null,
    syncMethod: string | null,
): { label: string; cls: string } | null {
    if (!externalSystem) return null;
    const system = externalSystem === "neodove" ? "NeoDove" : externalSystem;
    if (syncMethod === "reconciliation") {
        return {
            label: `${system} · backfilled`,
            cls: "bg-amber-50 text-amber-700 border-amber-200",
        };
    }
    return {
        label: system,
        cls: "bg-sky-50 text-sky-700 border-sky-200",
    };
}
