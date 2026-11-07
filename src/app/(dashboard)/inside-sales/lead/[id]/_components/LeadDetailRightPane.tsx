"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
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
import type { LeadDetailBundle, LeadDetailCommercials } from "@/lib/inside-sales/types";
import {
    CommercialsDetail,
    CommercialsVersionHistory,
    Field,
    fmtDate,
    QuoteApprovalBlock,
} from "./CommercialsDetail";
import { pickLiveQuote, pickPendingQuote } from "@/lib/leads/liveQuote";
import { QuotationSendDialog } from "./QuotationSendDialog";
import { DealCardBlock } from "./DealCardBlock";
import { businessTypeLabel, businessTypeTone } from "@/lib/leads/businessType";
import { doorLabel, originLabel, SOURCE_LABELS } from "@/lib/leads/leadSourceVocab";
import { SetLeadSource } from "@/components/leads/SetLeadSource";
import { InfoTip } from "@/components/ui/info-tip";
import { INTEREST_OPTIONS, LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";

type GroupKey = "snapshot" | "business" | "commercials" | "workflow" | "attribution" | "ownership";

const GROUPS: { key: GroupKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "snapshot", label: "Dealer", icon: User2 },
    { key: "business", label: "Business", icon: Building2 },
    { key: "commercials", label: "Quotes", icon: Receipt },
    { key: "workflow", label: "Status", icon: Workflow },
    { key: "attribution", label: "Source", icon: BadgeInfo },
    { key: "ownership", label: "Owner history", icon: History },
];

/** On-screen names of the commercials update types (the stored codes stay). */
const EVENT_TYPE_LABEL: Record<string, string> = {
    brochure_share: "Brochure share",
    quote_issue: "Quote issued",
    quote_revision: "Quote revision",
    terms_update: "Terms update",
    final_terms: "Final terms",
};
const eventTypeLabel = (code: string | null | undefined) =>
    (code && EVENT_TYPE_LABEL[code]) || code || "";

const INTEREST_LABEL: Record<string, string> = Object.fromEntries(
    INTEREST_OPTIONS.map((o) => [o.value, o.label]),
);

type Props = {
    bundle: LeadDetailBundle;
    /** ID 172: the Sales Head may change a locked deal card. */
    viewerRole?: string | null;
    /** ID 216: set for whoever may update commercials — "Revise" on a rejected quote. */
    onReviseQuote?: (c: LeadDetailCommercials) => void;
    /** ID 216: ?quote=<id> from a bell / WhatsApp link — that version is opened. */
    focusQuoteId?: string | null;
};

export function LeadDetailRightPane({ bundle, viewerRole, onReviseQuote, focusQuoteId }: Props) {
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
    const queryClient = useQueryClient();
    // ID 186: whether the dealer is already onboarded — information only (16 Oct).
    const onboarded = bundle.dealer_onboarded?.onboarded ? bundle.dealer_onboarded : null;

    // ID 60 / 61: the quote the dealer can answer is the newest approved,
    // not-withdrawn QUOTE — which is not always the newest row. Final terms, a
    // terms update, a brochure, or a revision still at the CEO all sit above
    // it, and Send / Withdraw used to be offered on the newest row only, so the
    // live quote lost both. When it is an older row it gets its own block.
    const liveQuote = pickLiveQuote(bundle.commercials_history);
    const liveQuoteBelow = liveQuote && cc && liveQuote.commercial_id !== cc.commercial_id ? liveQuote : null;
    // ID 78: a revision still at the CEO can be withdrawn, and it too can sit
    // under a newer row (a terms update saved after it). Without its own block
    // it had no Withdraw button anywhere on the screen.
    const pendingQuote = pickPendingQuote(bundle.commercials_history);
    const pendingQuoteBelow = pendingQuote && cc && pendingQuote.commercial_id !== cc.commercial_id ? pendingQuote : null;

    // ID 78: Withdraw quote — the reason is required; the lead goes back to
    // Under discussion and the dealer's link closes.
    const withdraw = async (commercialId: string) => {
        const reason = window.prompt("Why are you withdrawing this quote? (at least 5 characters)")?.trim();
        if (!reason) return;
        if (reason.length < 5) {
            toast.error("Give a reason of at least 5 characters.");
            return;
        }
        try {
            const res = await fetch(
                `/api/inside-sales/lead/${encodeURIComponent(lead.id)}/commercials/${encodeURIComponent(commercialId)}/withdraw`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ reason }),
                },
            );
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Could not withdraw the quote");
            // ID 78: withdrawing an old or pending version while another quote
            // is live leaves the lead where it is — say so, or the unchanged
            // status reads as a failed withdrawal.
            const live = json?.data?.liveQuote as { versionNo: number } | null | undefined;
            toast.success(
                live
                    ? `Quote withdrawn. Version ${live.versionNo} is still active, so the status stays the same.`
                    : "Quote withdrawn.",
            );
            await queryClient.invalidateQueries();
        } catch (err) {
            toast.error((err as Error).message);
        }
    };

    return (
        <div className="overflow-y-auto bg-gray-50/30">
            <div className="px-5 py-4 space-y-3">
                {/* Always visible, not behind a collapsible group: burying what
                    the AI already learned inside a closed accordion is how it
                    stayed invisible to the rep who has to act on it. Renders
                    nothing when the AI has never called this lead. */}
                <IntentReviewCard leadId={lead.id} />

                {/* ID 84: onboarding milestones — stalls show before they become drop-outs. */}
                {bundle.onboarding && (
                    <div
                        className={`rounded-lg border px-4 py-3 text-xs ${
                            bundle.onboarding.stalled ? "border-amber-200 bg-amber-50" : "border-gray-100 bg-white"
                        }`}
                    >
                        <p className="text-sm font-semibold text-gray-800">
                            Dealer onboarding
                            {bundle.onboarding.stalled && (
                                <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                                    {bundle.onboarding.stalled_label ?? "Stalled"}
                                </span>
                            )}
                        </p>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-gray-600">
                            <span>Status: {bundle.onboarding.onboarding_status.replace(/_/g, " ")}</span>
                            <span>
                                Docs submitted:{" "}
                                {bundle.onboarding.docs_submitted_at ? fmtDate(bundle.onboarding.docs_submitted_at) : "not yet"}
                            </span>
                            {/* ID 84.1: the lead's own outcome (Signed / Manual agreement on file /
                                Not needed / …) when recorded, else the application's status. */}
                            <span>
                                Agreement:{" "}
                                {bundle.onboarding.agreement_outcome_label ??
                                    (bundle.onboarding.agreement_status ?? "not started").replace(/_/g, " ")}
                            </span>
                            <span>
                                Approved: {bundle.onboarding.approved_at ? fmtDate(bundle.onboarding.approved_at) : "not yet"}
                            </span>
                        </div>
                    </div>
                )}

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
                                            {/* ID 214: a duplicate found after onboarding — this lead is
                                                the same dealer as an onboarding already on the CRM. */}
                                            {onboarded &&
                                                lead.lead_status !== "Won" &&
                                                lead.lead_status !== "Converted" && (
                                                    <p className="col-span-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                                                        Same dealer as an onboarding on the CRM. {onboarded.reason}
                                                    </p>
                                                )}
                                            <Field label="Dealer Name" value={lead.dealer_name} />
                                            <Field label="Shop Name" value={lead.shop_name} />
                                            {/* E-296 — always rendered; NULL reads "Not set". */}
                                            <Field
                                                label="Business type"
                                                value={
                                                    <span
                                                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${businessTypeTone(lead.business_type)}`}
                                                    >
                                                        {businessTypeLabel(lead.business_type)}
                                                    </span>
                                                }
                                            />
                                            {/* ID 81 — where the lead came from; locked at creation. */}
                                            <Field label={SOURCE_LABELS.door} value={doorLabel(lead.source_door) ?? "Not recorded"} />
                                            <Field
                                                label={SOURCE_LABELS.origin}
                                                value={
                                                    originLabel(lead.source_origin) ?? (
                                                        <SetLeadSource
                                                            leadId={lead.id}
                                                            hasCampaign={!!lead.acquisition_campaign_id}
                                                            onSaved={() => void queryClient.invalidateQueries()}
                                                        />
                                                    )
                                                }
                                            />
                                            <Field label={SOURCE_LABELS.campaign} value={lead.acquisition_campaign_name ?? "None"} />
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
                                            <Field label="AI score" value={lead.final_intent_score} />
                                            <Field label="Interest" value={lead.interest_level ? INTEREST_LABEL[lead.interest_level] ?? lead.interest_level : null} />
                                            <Field label="Timezone" value={lead.timezone} />
                                            <div className="col-span-2">
                                                <div>
                                                    <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5 flex items-center gap-1">
                                                        Expected payment method
                                                        <InfoTip>As given when the lead was uploaded.</InfoTip>
                                                    </div>
                                                    <div className="text-sm text-gray-900 break-words">
                                                        {lead.preliminary_payment_intent ? lead.preliminary_payment_intent : <span className="text-gray-400">—</span>}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="col-span-2">
                                                <Field label="Summary" value={lead.overall_summary ? <p className="whitespace-pre-wrap">{lead.overall_summary}</p> : null} />
                                            </div>
                                        </div>
                                    )}
                                    {g.key === "commercials" && (
                                        <div className="space-y-3">
                                            {cc ? (
                                                <>
                                                    <div className="flex items-center justify-between text-xs text-gray-500">
                                                        <span><span className="font-semibold text-gray-800">Version {cc.version_no}</span> · {eventTypeLabel(cc.event_type)}</span>
                                                        <span>{fmtDate(cc.created_at)}</span>
                                                    </div>
                                                    <CommercialsDetail
                                                        cc={cc}
                                                        onSend={() => setSendFor(cc.commercial_id)}
                                                        onWithdraw={() => void withdraw(cc.commercial_id)}
                                                    />
                                                    {/* ID 172: the deal card of the current version — ID 186
                                                        (16 Oct): for onboarded dealers too; whether the
                                                        dealer is onboarded is shown as information. */}
                                                    {onboarded && (
                                                        <p className="rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-600">
                                                            Dealer already onboarded: {onboarded.reason}
                                                        </p>
                                                    )}
                                                    <DealCardBlock leadId={lead.id} cc={cc} viewerRole={viewerRole} />
                                                    {liveQuoteBelow && (
                                                        <div className="space-y-1.5">
                                                            <p className="text-xs text-gray-500">
                                                                Active quote:{" "}
                                                                <span className="font-semibold text-gray-800">version {liveQuoteBelow.version_no}</span>
                                                                {liveQuoteBelow.final_price ? ` · ₹${liveQuoteBelow.final_price}` : ""}{" "}
                                                                <InfoTip>
                                                                    Version {cc.version_no} above has not replaced it yet, so the
                                                                    dealer can still answer this one.
                                                                </InfoTip>
                                                            </p>
                                                            <QuoteApprovalBlock
                                                                cc={liveQuoteBelow}
                                                                onSend={() => setSendFor(liveQuoteBelow.commercial_id)}
                                                                onWithdraw={() => void withdraw(liveQuoteBelow.commercial_id)}
                                                            />
                                                        </div>
                                                    )}
                                                    {pendingQuoteBelow && (
                                                        <div className="space-y-1.5">
                                                            <p className="text-xs text-gray-500">
                                                                Waiting for the CEO:{" "}
                                                                <span className="font-semibold text-gray-800">v{pendingQuoteBelow.version_no}</span>
                                                                {pendingQuoteBelow.final_price ? ` · ₹${pendingQuoteBelow.final_price}` : ""}
                                                            </p>
                                                            <QuoteApprovalBlock
                                                                cc={pendingQuoteBelow}
                                                                onWithdraw={() => void withdraw(pendingQuoteBelow.commercial_id)}
                                                            />
                                                        </div>
                                                    )}
                                                    <CommercialsVersionHistory
                                                        history={bundle.commercials_history}
                                                        onRevise={onReviseQuote}
                                                        focusId={focusQuoteId}
                                                    />
                                                </>
                                            ) : bundle.commercials_history.length > 0 ? (
                                                // ID 216: no current quote (the CEO rejected the only
                                                // one) — the history, reason included, still shows.
                                                <>
                                                    <div className="text-sm text-gray-500">
                                                        No current quote. Revise a rejected version or use Update Commercials.
                                                    </div>
                                                    <CommercialsVersionHistory
                                                        history={bundle.commercials_history}
                                                        onRevise={onReviseQuote}
                                                        focusId={focusQuoteId}
                                                    />
                                                </>
                                            ) : (
                                                <div className="text-sm text-gray-500">No quote yet. [Update quote]</div>
                                            )}
                                        </div>
                                    )}
                                    {g.key === "workflow" && (
                                        <div className="grid grid-cols-2 gap-3">
                                            <Field
                                                label="Status"
                                                value={
                                                    lead.lead_status
                                                        ? (LEAD_STATUS_LABEL as Record<string, string>)[lead.lead_status] ?? lead.lead_status
                                                        : null
                                                }
                                            />
                                            <Field
                                                label="Interest"
                                                value={lead.interest_level ? INTEREST_LABEL[lead.interest_level] ?? lead.interest_level : null}
                                            />
                                            <Field label="Next Follow-up" value={fmtDate(lead.next_follow_up_at)} />
                                            <Field label="Last activity" value={fmtDate(lead.last_touchpoint_at)} />
                                            <Field label="ASM" value={lead.asm_name} />
                                            <Field label="Status before transfer to ASM" value={lead.pre_transfer_status} />
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
                    // The terms of the quote being sent — not the newest row's.
                    terms={bundle.commercials_history.find((c) => c.commercial_id === sendFor) ?? cc}
                    onClose={() => setSendFor(null)}
                />
            )}
        </div>
    );
}
