"use client";

import {
    Phone,
    MessageSquare,
    FileText,
    Receipt,
    Repeat,
    AlertCircle,
    UserPlus2,
    UserMinus2,
    Activity,
    Sparkles,
} from "lucide-react";
import type {
    LeadDetailStatusHistory,
    LeadDetailTouchpoint,
} from "@/lib/inside-sales/types";
import type { TouchpointType } from "@/lib/lifecycle/touchpointTypes";

type Props = {
    touchpoints: LeadDetailTouchpoint[];
    statusHistory: LeadDetailStatusHistory[];
};

const ICONS: Record<TouchpointType | "default", React.ComponentType<{ className?: string }>> = {
    ai_call: Sparkles,
    inside_sales_call: Phone,
    whatsapp: MessageSquare,
    brochure_sent: FileText,
    quote_sent: Receipt,
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

const TYPE_LABEL: Record<TouchpointType, string> = {
    ai_call: "AI call",
    inside_sales_call: "Call",
    whatsapp: "WhatsApp",
    brochure_sent: "Brochure sent",
    quote_sent: "Quote sent",
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

function formatTime(iso: string): string {
    return new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function TouchpointHistoryPane({ touchpoints }: Props) {
    return (
        <div className="overflow-y-auto border-r border-gray-100 bg-white">
            <div className="px-6 py-4 sticky top-0 bg-white border-b border-gray-100 z-[1]">
                <h2 className="text-sm font-semibold text-gray-900">Touchpoint History</h2>
                <p className="text-[11px] text-gray-500 mt-0.5">
                    {touchpoints.length} {touchpoints.length === 1 ? "entry" : "entries"} · newest first
                </p>
            </div>
            <div className="px-6 py-4">
                {touchpoints.length === 0 ? (
                    <div className="text-sm text-gray-500 py-10 text-center">
                        No touchpoints logged yet. Use the action bar below to log the first one.
                    </div>
                ) : (
                    <ol className="space-y-3">
                        {touchpoints.map((t) => {
                            const Icon = ICONS[t.touchpoint_type] ?? ICONS.default;
                            return (
                                <li key={t.touchpoint_id} className="flex gap-3">
                                    <div className="shrink-0 mt-0.5">
                                        <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${t.is_engaged ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-500"}`}>
                                            <Icon className="h-4 w-4" />
                                        </div>
                                    </div>
                                    <div className="flex-1 min-w-0 rounded-lg border border-gray-100 bg-gray-50/40 px-3 py-2">
                                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                                            <div className="text-sm font-medium text-gray-900">
                                                {TYPE_LABEL[t.touchpoint_type] ?? t.touchpoint_type}
                                                {t.call_status && (
                                                    <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">
                                                        · {t.call_status}
                                                    </span>
                                                )}
                                                {t.is_engaged && (
                                                    <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                                                        engaged
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-[11px] text-gray-500 tabular-nums">{formatTime(t.performed_at)}</div>
                                        </div>
                                        {t.performed_by_name && (
                                            <div className="text-[11px] text-gray-500 mt-0.5">by {t.performed_by_name}</div>
                                        )}
                                        {t.remarks && (
                                            <p className="text-sm text-gray-700 mt-1.5 whitespace-pre-wrap">{t.remarks}</p>
                                        )}
                                        {t.call_duration_sec != null && (
                                            <div className="text-[11px] text-gray-500 mt-1">
                                                Duration: {Math.floor(t.call_duration_sec / 60)}m {t.call_duration_sec % 60}s
                                            </div>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                )}
            </div>
        </div>
    );
}
