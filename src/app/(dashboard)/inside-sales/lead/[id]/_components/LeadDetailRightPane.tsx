"use client";

import { useState } from "react";
import { IntentReviewCard } from "@/components/leads/intent-review/IntentReviewCard";
import {
    ChevronDown,
    User2,
    Building2,
    Receipt,
    Workflow,
    BadgeInfo,
    History,
} from "lucide-react";
import type { LeadDetailBundle } from "@/lib/inside-sales/types";
import {
    CommercialsDetail,
    CommercialsVersionHistory,
    Field,
    fmtDate,
} from "./CommercialsDetail";
import { QuotationSendDialog } from "./QuotationSendDialog";

type GroupKey = "snapshot" | "business" | "commercials" | "workflow" | "attribution" | "ownership";

const GROUPS: { key: GroupKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "snapshot", label: "Dealer Snapshot", icon: User2 },
    { key: "business", label: "Business Profile", icon: Building2 },
    { key: "commercials", label: "Commercials", icon: Receipt },
    { key: "workflow", label: "Workflow", icon: Workflow },
    { key: "attribution", label: "Attribution", icon: BadgeInfo },
    { key: "ownership", label: "Ownership History", icon: History },
];

type Props = {
    bundle: LeadDetailBundle;
};

export function LeadDetailRightPane({ bundle }: Props) {
    const [open, setOpen] = useState<Record<GroupKey, boolean>>({
        snapshot: true,
        business: true,
        commercials: true,
        workflow: false,
        attribution: false,
        ownership: false,
    });

    // E-242 — which quotation the send dialog is open for, if any.
    const [sendFor, setSendFor] = useState<string | null>(null);

    const lead = bundle.lead;
    const cc = bundle.current_commercials;

    return (
        <div className="overflow-y-auto bg-gray-50/30">
            <div className="px-5 py-4 space-y-3">
                {/* Always visible, not behind a collapsible group: burying what
                    the AI already learned inside a closed accordion is how it
                    stayed invisible to the rep who has to act on it. Renders
                    nothing when the AI has never called this lead. */}
                <IntentReviewCard leadId={lead.id} />

                {GROUPS.map((g) => {
                    const Icon = g.icon;
                    const isOpen = open[g.key];
                    return (
                        <div key={g.key} className="rounded-lg border border-gray-100 bg-white overflow-hidden">
                            <button
                                type="button"
                                onClick={() => setOpen((s) => ({ ...s, [g.key]: !s[g.key] }))}
                                className="w-full px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-gray-50"
                            >
                                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                                    <Icon className="h-4 w-4 text-gray-500" />
                                    {g.label}
                                </div>
                                <ChevronDown className={`h-4 w-4 text-gray-400 transition ${isOpen ? "rotate-180" : ""}`} />
                            </button>
                            {isOpen && (
                                <div className="px-4 pb-4 pt-1">
                                    {g.key === "snapshot" && (
                                        <div className="grid grid-cols-2 gap-3">
                                            <Field label="Dealer Name" value={lead.dealer_name} />
                                            <Field label="Shop Name" value={lead.shop_name} />
                                            <Field label="Phone" value={lead.phone} />
                                            <Field label="Language" value={lead.language} />
                                            <Field label="City" value={lead.city} />
                                            <Field label="State" value={lead.state} />
                                            <Field label="Pincode" value={lead.pincode} />
                                            <Field label="Area" value={lead.area} />
                                            <div className="col-span-2">
                                                <Field
                                                    label="Segments"
                                                    value={
                                                        lead.segments?.length
                                                            ? lead.segments.map((s) => (
                                                                  <span key={s} className="inline-flex items-center mr-1 mb-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-700">{s}</span>
                                                              ))
                                                            : "—"
                                                    }
                                                />
                                            </div>
                                        </div>
                                    )}
                                    {g.key === "business" && (
                                        <div className="grid grid-cols-2 gap-3">
                                            <Field label="Total Attempts" value={lead.total_attempts ?? 0} />
                                            <Field label="AI Intent Score" value={lead.final_intent_score} />
                                            <Field label="Interest Level" value={lead.interest_level} />
                                            <Field label="Timezone" value={lead.timezone} />
                                            <div className="col-span-2">
                                                <Field label="Preliminary Payment Intent" value={lead.preliminary_payment_intent} />
                                            </div>
                                            <div className="col-span-2">
                                                <Field label="Overall Summary" value={lead.overall_summary ? <p className="whitespace-pre-wrap">{lead.overall_summary}</p> : null} />
                                            </div>
                                        </div>
                                    )}
                                    {g.key === "commercials" && (
                                        <div className="space-y-3">
                                            {cc ? (
                                                <>
                                                    <div className="flex items-center justify-between text-xs text-gray-500">
                                                        <span>Current version: <span className="font-semibold text-gray-800">v{cc.version_no}</span> · {cc.event_type}</span>
                                                        <span>{fmtDate(cc.created_at)}</span>
                                                    </div>
                                                    <CommercialsDetail
                                                        cc={cc}
                                                        onSend={() => setSendFor(cc.commercial_id)}
                                                    />
                                                    <CommercialsVersionHistory
                                                        history={bundle.commercials_history}
                                                    />
                                                </>
                                            ) : (
                                                <div className="text-sm text-gray-500">No commercials logged yet. Use Update Commercials to record the first event.</div>
                                            )}
                                        </div>
                                    )}
                                    {g.key === "workflow" && (
                                        <div className="grid grid-cols-2 gap-3">
                                            <Field label="Lead Status" value={lead.lead_status} />
                                            <Field label="Interest Level" value={lead.interest_level} />
                                            <Field label="Next Follow-up" value={fmtDate(lead.next_follow_up_at)} />
                                            <Field label="Last Touchpoint" value={fmtDate(lead.last_touchpoint_at)} />
                                            <Field label="ASM" value={lead.asm_name} />
                                            <Field label="Pre-Transfer Status" value={lead.pre_transfer_status} />
                                            {lead.lost_reason && <Field label="Lost Reason" value={lead.lost_reason} />}
                                            {lead.lost_reason_notes && (
                                                <div className="col-span-2">
                                                    <Field label="Lost Reason Notes" value={<p className="whitespace-pre-wrap">{lead.lost_reason_notes}</p>} />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {g.key === "attribution" && (
                                        <div className="grid grid-cols-2 gap-3">
                                            <Field label="AI Session ID" value={lead.ai_session_id} />
                                            <Field label="Originator" value={lead.originator_name} />
                                            <Field label="Assigned At" value={fmtDate(lead.assigned_at)} />
                                            <Field label="Closed At" value={fmtDate(lead.closed_at)} />
                                            <Field label="Closing Owner" value={lead.closing_owner_name} />
                                            <Field label="Closing Role" value={lead.closing_role} />
                                            <Field label="Escalation Count" value={lead.escalation_count} />
                                            <Field label="Created" value={fmtDate(lead.created_at)} />
                                        </div>
                                    )}
                                    {g.key === "ownership" && (
                                        <div className="space-y-2">
                                            {bundle.status_history.length === 0 ? (
                                                <div className="text-sm text-gray-500">No status changes recorded.</div>
                                            ) : (
                                                bundle.status_history.map((h) => (
                                                    <div key={h.history_id} className="flex items-center justify-between text-xs bg-gray-50/60 border border-gray-100 rounded px-2.5 py-1.5">
                                                        <span className="text-gray-700">
                                                            {h.from_status ? `${h.from_status} → ` : ""}
                                                            <span className="font-medium text-gray-900">{h.to_status}</span>
                                                            {h.changed_by_name && <span className="text-gray-500"> · by {h.changed_by_name}</span>}
                                                        </span>
                                                        <span className="text-gray-500 tabular-nums">{fmtDate(h.changed_at)}</span>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {sendFor && (
                <QuotationSendDialog
                    leadId={lead.id}
                    commercialId={sendFor}
                    terms={cc}
                    onClose={() => setSendFor(null)}
                />
            )}
        </div>
    );
}
