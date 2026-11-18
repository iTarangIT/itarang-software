"use client";

import { useState } from "react";
import Link from "next/link";
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
import { neodoveCampaignLine } from "@/lib/neodove/leadCampaignText";
import { INTEREST_OPTIONS, LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import { dayWords, isBlank, missingDealerDetails, shortAppId } from "@/lib/leads/leadPage246";

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
    /** ID 246: the owner's Update quote (the same modal as the action bar's), shown on the Quotes box. */
    onUpdateQuote?: () => void;
};

/** ID 246: Dealer, Quotes first; then the AI review and call recordings; then the rest. */
const TOP_GROUPS: GroupKey[] = ["snapshot", "commercials"];

export function LeadDetailRightPane({ bundle, viewerRole, onReviseQuote, focusQuoteId, onUpdateQuote }: Props) {
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
    // ID 246: the dealer box lists filled fields; the empty ones open from "Add missing details".
    const [showMissing, setShowMissing] = useState(false);

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
                {/* ID 84: onboarding milestones — stalls show before they become drop-outs.
                    ID 246: laid out as the mock-up's Onboarding progress box. */}
                {bundle.onboarding && (() => {
                    const o = bundle.onboarding;
                    const st = (o.onboarding_status ?? "draft").toLowerCase();
                    const draft = st === "draft";
                    // The header's rule (17 Nov): the form opens only on a Won /
                    // Converted lead's own application while it is still a draft.
                    const own = lead.dealer_onboarding_application_id === o.application_id;
                    const canContinue =
                        draft && own && (lead.lead_status === "Won" || lead.lead_status === "Converted");
                    const appCreated = own ? lead.onboarding_created_at : null;
                    return (
                        <div className="rounded-lg border border-gray-100 bg-white px-4 py-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-gray-800">
                                    Onboarding
                                    {o.stalled && (
                                        <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                                            {o.stalled_label ?? "Stalled"}
                                        </span>
                                    )}
                                </p>
                                <span className="text-[11px] text-gray-500">{shortAppId(o.application_id)}</span>
                            </div>
                            <div className="mt-2 space-y-1.5">
                                <MilestoneRow
                                    label="Application"
                                    value={
                                        draft
                                            ? `Draft${appCreated ? ` since ${dayWords(appCreated, false)}` : ""}`
                                            : `${st.charAt(0).toUpperCase()}${st.slice(1).replace(/_/g, " ")}${
                                                  o.docs_submitted_at ? ` · docs ${dayWords(o.docs_submitted_at, false)}` : ""
                                              }`
                                    }
                                    pending={draft}
                                />
                                {/* ID 84.1: the lead's own outcome (Signed / Manual agreement on file /
                                    Not needed / …) when recorded, else the application's status. */}
                                <MilestoneRow
                                    label="Agreement"
                                    value={
                                        o.agreement_outcome_label ??
                                        (o.agreement_status ? o.agreement_status.replace(/_/g, " ") : "Not generated")
                                    }
                                />
                                <MilestoneRow
                                    label="Approval"
                                    value={o.approved_at ? `Approved ${dayWords(o.approved_at, false)}` : "Not yet"}
                                />
                            </div>
                            {canContinue ? (
                                <Link
                                    href={`/dealer-onboarding?applicationId=${o.application_id}`}
                                    className="mt-2 inline-block text-xs font-semibold text-emerald-700 hover:underline"
                                >
                                    Continue onboarding →
                                </Link>
                            ) : !draft ? (
                                <p className="mt-2 text-[11px] text-gray-500">With the Sales Head for review.</p>
                            ) : null}
                        </div>
                    );
                })()}

                {[
                    ...GROUPS.filter((g) => TOP_GROUPS.includes(g.key)),
                    // ID 246: the AI review + call recordings sit here.
                    { key: "ai_review" as const, label: "", icon: Receipt },
                    ...GROUPS.filter((g) => !TOP_GROUPS.includes(g.key)),
                ].map((g) => {
                    if (g.key === "ai_review") {
                        // Always visible, not behind a collapsible group: burying what
                        // the AI already learned inside a closed accordion is how it
                        // stayed invisible to the rep who has to act on it. Renders
                        // nothing when the AI has never called this lead. Holds the
                        // call recordings (Attach audio): ID 246 moved it down only.
                        return <IntentReviewCard key="ai_review" leadId={lead.id} />;
                    }
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
                                            {/* ID 246: only the filled fields; the empty ones are
                                                listed under "Add missing details". */}
                                            {!isBlank(lead.dealer_name) && <Field label="Dealer name" value={lead.dealer_name} />}
                                            {!isBlank(lead.shop_name) && <Field label="Shop name" value={lead.shop_name} />}
                                            {!isBlank(lead.city) && <Field label="City" value={lead.city} />}
                                            {!isBlank(lead.state) && <Field label="State" value={lead.state} />}
                                            {!isBlank(lead.language) && <Field label="Language" value={lead.language} />}
                                            {/* ID 81 — where the lead came from; locked at creation. */}
                                            <Field label={SOURCE_LABELS.door} value={doorLabel(lead.source_door) ?? "Not recorded"} />
                                            {/* E-296 business type: shown when set. */}
                                            {!isBlank(lead.business_type) && (
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
                                            )}
                                            {originLabel(lead.source_origin) && (
                                                <Field label={SOURCE_LABELS.origin} value={originLabel(lead.source_origin)} />
                                            )}
                                            {/* ID 235: the campaign the lead CAME IN through (scrape run,
                                                upload), apart from the NeoDove campaign calling it now. */}
                                            {lead.acquisition_campaign_name && (
                                                <Field label="Came in via" value={lead.acquisition_campaign_name} />
                                            )}
                                            {bundle.neodove_campaign && (
                                                <Field
                                                    label="NeoDove campaign"
                                                    value={neodoveCampaignLine(bundle.neodove_campaign, (d) => fmtDate(d))}
                                                />
                                            )}
                                            {!isBlank(lead.pincode) && <Field label="Pincode" value={lead.pincode} />}
                                            {!isBlank(lead.area) && <Field label="Area" value={lead.area} />}
                                            {!isBlank(lead.segments) && (
                                                <div className="col-span-2">
                                                    <Field
                                                        label="Segments"
                                                        value={lead.segments.map((seg) => (
                                                            <span key={seg} className="inline-flex items-center mr-1 mb-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-700">{seg}</span>
                                                        ))}
                                                    />
                                                </div>
                                            )}
                                            {(() => {
                                                const missing = missingDealerDetails(lead);
                                                if (!missing.length) return null;
                                                return (
                                                    <div className="col-span-2 rounded-md border border-dashed border-gray-300 px-3 py-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => setShowMissing((v) => !v)}
                                                            className="text-left w-full"
                                                        >
                                                            <span className="block text-xs font-semibold text-emerald-700">
                                                                + Add missing details ({missing.length})
                                                            </span>
                                                            <span className="block text-[11px] text-gray-500">{missing.join(", ")}</span>
                                                        </button>
                                                        {showMissing && (
                                                            <div className="mt-2 grid grid-cols-2 gap-3">
                                                                {missing.map((label) =>
                                                                    label === "Found via" ? (
                                                                        // ID 81: the one empty field the lead page already sets.
                                                                        <Field
                                                                            key={label}
                                                                            label={SOURCE_LABELS.origin}
                                                                            value={
                                                                                <SetLeadSource
                                                                                    leadId={lead.id}
                                                                                    hasCampaign={!!lead.acquisition_campaign_id}
                                                                                    onSaved={() => void queryClient.invalidateQueries()}
                                                                                />
                                                                            }
                                                                        />
                                                                    ) : (
                                                                        <Field key={label} label={label} value="Not set" />
                                                                    ),
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })()}
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
                                            {/* ID 246: the owner's Update quote, on the Quotes box too. */}
                                            {onUpdateQuote && (
                                                <div className="flex justify-end">
                                                    <button
                                                        type="button"
                                                        onClick={onUpdateQuote}
                                                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                                    >
                                                        <Receipt className="h-3.5 w-3.5" />
                                                        {bundle.commercials_history.length ? "Update quote" : "Create quote"}
                                                    </button>
                                                </div>
                                            )}
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

function MilestoneRow({ label, value, pending }: { label: string; value: string; pending?: boolean }) {
    return (
        <div
            className={`flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 ${
                pending ? "border-amber-200 bg-amber-50 text-amber-800" : "border-gray-200 text-gray-700"
            }`}
        >
            <span className="font-medium">{label}</span>
            <span className="text-right">{value}</span>
        </div>
    );
}
