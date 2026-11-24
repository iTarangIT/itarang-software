"use client";

import Link from "next/link";
import { MessageCircle, AlertCircle, RotateCcw, ShieldAlert } from "lucide-react";
import { CallNowButton } from "@/components/leads/call-now-button";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";
import { wonWithoutQuote, type LeadDetailBundle } from "@/lib/inside-sales/types";
import { WonWithoutQuoteChip } from "@/components/leads/won-without-quote-chip";
import { InterestLevelEditor } from "../../../_components/InterestLevelEditor";
import { LeadStatusEditor, type StatusModalAction } from "../../../_components/LeadStatusEditor";
import { NeodoveTag } from "@/components/leads/neodove-tag";
import { IvrTag } from "@/components/leads/ivr-tag";
import { AssignedByAiBadge } from "@/components/leads/sent-by-stamp";
import { ReactivateLeadButton } from "@/components/leads/ReactivateLeadButton";
import { ChangeLostReasonButton } from "@/components/leads/ChangeLostReasonButton";
import { WonUndoControl } from "@/components/leads/WonUndoControl";
import { InfoTip } from "@/components/ui/info-tip";
import { BackToPrevious } from "@/components/layout/BackToPrevious";
import { capabilitiesFor, canMarkUnownedLeadLost, canReactivateLead } from "@/lib/leads/access";
import {
    aiScoreWords,
    attemptsWords,
    dayWords,
    handoverNoteInWords,
    istDateTimeWords,
    istDay,
    lastActionFact,
    nextVisitFact,
    paymentFact,
    quoteFact,
} from "@/lib/leads/leadPage246";

// Roles permitted to override a lead's temperature (mirrors the PATCH route).
const INTEREST_EDIT_ROLES = ["inside_sales_rep", "asm", "admin", "partner", "sales_head"];

type Props = {
    bundle: LeadDetailBundle;
    viewerId: string;
    viewerRole?: string;
    /** Where "Back to queue" goes — the ISR workspace unless a twin says otherwise. */
    backHref?: string;
    onUpdated?: () => void;
    // Dedicated-flow modals the parent view can open from the status editor.
    statusModalActions?: StatusModalAction[];
    onStatusModal?: (action: StatusModalAction) => void;
};

// ID 245 item 4: in IST whatever the viewer's computer clock is set to ("14 Nov 2026, 2:27 pm").
const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

function formatDateTime(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : IST_DATE_TIME.format(d);
}

function senderRole(role: string | null | undefined): string {
    if (!role) return "";
    const r = role.toLowerCase();
    if (r === "ceo") return "CEO";
    if (r === "asm") return "ASM";
    if (r === "inside_sales_rep") return "ISR";
    return role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** wa.me wants the number with its country code and digits only. */
function whatsappHref(phone: string): string | null {
    let d = phone.replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (d.length === 10) d = `91${d}`;
    return d.length >= 11 ? `https://wa.me/${d}` : null;
}

/**
 * ID 246 — the lead page header (mock-up "Page 2"): name and chips, owner and
 * who handed it over, then the facts row (phone, last action, next visit,
 * quote, payment, attempts, AI score) and the hand-over note in words. Every
 * control the header had keeps its rule; only the layout and labels changed.
 */
export function LeadDetailHeader({
    bundle,
    viewerId,
    viewerRole,
    backHref = "/inside-sales",
    onUpdated,
    statusModalActions,
    onStatusModal,
}: Props) {
    const lead = bundle.lead;
    const canEditInterest = INTEREST_EDIT_ROLES.includes(viewerRole ?? "");
    const isOwner = lead.current_owner_id === viewerId;
    const isUnassigned = !lead.current_owner_id;
    const isEscalated = lead.escalation_status === "pending_review";
    const wasReactivated = Boolean(lead.previous_lost_reason);
    const todayIst = istDay(new Date()) ?? "";

    const lastAction = lastActionFact(lead.last_action, lead.last_action_at);
    const nextVisit = nextVisitFact({
        hasOpenBooking: Boolean(lead.has_open_booking),
        nextBookingDate: lead.next_booking_date ?? null,
        nextBookingOverdueDays: lead.next_booking_overdue_days ?? null,
        todayIst,
    });
    const quote = quoteFact(bundle.commercials_history);
    const payment = paymentFact(bundle.current_commercials, lead.preliminary_payment_intent);
    // The newest hand-over to the field (asm_transfer), read in words.
    const handover = bundle.touchpoints.find((t) => t.touchpoint_type === "asm_transfer" && t.remarks);
    const assignedBy = lead.assigned_by;
    const handedBy =
        assignedBy && assignedBy.via !== "ai" && assignedBy.id !== lead.current_owner_id ? assignedBy : null;
    const wa = lead.phone ? whatsappHref(lead.phone) : null;

    return (
        <div className="px-4 sm:px-6 pt-3">
            {/* ID 232: back to the page this lead was opened from, filters kept;
                else the person's own home queue (backHref). */}
            <BackToPrevious
                homeHref={backHref}
                className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline mb-2"
            />
            <div className="rounded-xl border border-gray-200 bg-white px-4 sm:px-6 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h1 className="text-xl font-semibold text-gray-900 truncate">
                                {lead.dealer_name || lead.shop_name || "(unnamed dealer)"}
                            </h1>
                            {/* ID 136: nobody picks a status by hand — the chip opens
                                Mark Won / Mark Lost / Transfer for the owner only. */}
                            <LeadStatusEditor
                                status={lead.lead_status}
                                editable={isOwner}
                                modalActions={statusModalActions}
                                onModalAction={onStatusModal}
                            />
                            <InterestLevelEditor
                                leadId={lead.id}
                                value={lead.interest_level}
                                editable={canEditInterest}
                                onUpdated={onUpdated}
                            />
                            {/* Same chip as the queue row, so a lead does not gain or
                                lose its NeoDove provenance by being opened. */}
                            <NeodoveTag syncStatus={lead.neodove_sync_status} />
                            <IvrTag isIvr={lead.is_ivr} />
                            {wonWithoutQuote(lead) && <WonWithoutQuoteChip />}
                            {/* ID 158: Admin, Sales Head, CEO — not partner. */}
                            {lead.lead_status === "Lost" && canReactivateLead(viewerRole) && (
                                <ReactivateLeadButton leadId={lead.id} onDone={onUpdated} compact />
                            )}
                            {/* ID 136: a wrong Lost reason is fixed here, not by a status change. */}
                            {/* ID 168: a drop-out Lost reason changes only through a new drop-out review decision. */}
                            {lead.lead_status === "Lost" &&
                                lead.lost_reason !== "onboarding_dropout" &&
                                capabilitiesFor(viewerRole).canChangeLostReason && (
                                    <ChangeLostReasonButton
                                        leadId={lead.id}
                                        currentReason={lead.lost_reason}
                                        onDone={onUpdated}
                                        compact
                                    />
                                )}
                            {/* ID 233: a lead with no owner (test rows, broken imports) can be
                                closed by Admin, Sales Head or CEO; the server checks the same. */}
                            {isUnassigned &&
                                canMarkUnownedLeadLost(viewerRole) &&
                                lead.lead_status !== "Lost" &&
                                lead.lead_status !== "Won" &&
                                lead.lead_status !== "Converted" &&
                                statusModalActions?.includes("mark_lost") &&
                                onStatusModal && (
                                    <button
                                        type="button"
                                        onClick={() => onStatusModal("mark_lost")}
                                        className="inline-flex items-center rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-100"
                                    >
                                        Mark lost
                                    </button>
                                )}
                            {/* ID 134: a Won marked by mistake, before onboarding is submitted. */}
                            {lead.lead_status === "Won" && <WonUndoControl leadId={lead.id} onDone={onUpdated} />}
                        </div>
                        <div className="text-sm text-gray-600 mt-1">
                            {[
                                lead.dealer_name && lead.shop_name ? lead.shop_name : null,
                                [lead.city, lead.state].filter(Boolean).join(", ") || null,
                                lead.language,
                            ]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                        </div>
                    </div>
                    <div className="text-right text-xs text-gray-500 shrink-0">
                        <div>Owner</div>
                        <div className={`text-sm font-semibold ${isOwner ? "text-emerald-700" : "text-gray-900"}`}>
                            {isUnassigned
                                ? "Unassigned"
                                : `${lead.current_owner_name ?? lead.asm_name ?? "Other rep"}${isOwner ? " (you)" : ""}`}
                        </div>
                        {handedBy ? (
                            <div className="mt-0.5" title={handedBy.at ? formatDateTime(handedBy.at) : undefined}>
                                Handed over by {handedBy.name ?? "a user"}
                                {handedBy.role ? ` (${senderRole(handedBy.role)})` : ""}
                                {handedBy.at ? ` · ${dayWords(handedBy.at, false)}` : ""}
                            </div>
                        ) : assignedBy?.via === "ai" ? (
                            <div className="flex justify-end">
                                <AssignedByAiBadge assignedBy={assignedBy} />
                            </div>
                        ) : lead.originator_name ? (
                            <div className="mt-0.5">
                                Created by {lead.originator_id === viewerId ? "you" : lead.originator_name}
                                {lead.created_at ? ` · ${dayWords(lead.created_at, false)}` : ""}
                            </div>
                        ) : null}
                    </div>
                </div>

                <dl className="mt-4 border-t border-gray-100 pt-4 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4">
                    <Fact label="Phone">
                        <div className="text-base font-semibold text-gray-900 tabular-nums">{lead.phone || "—"}</div>
                        {lead.phone && (
                            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                                {/* 24 Nov: calls go through NeoDove only (recorded + tracked) —
                                    the phone-app tel: link is gone. Owner only, as the Next-step box. */}
                                {isOwner && (
                                    <CallNowButton
                                        leadId={lead.id}
                                        leadName={lead.shop_name || lead.dealer_name || "this lead"}
                                        disabled={["Lost", "Won", "Converted"].includes(lead.lead_status ?? "")}
                                        onQueued={onUpdated}
                                    />
                                )}
                                {wa && (
                                    <a
                                        href={wa}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline"
                                    >
                                        <MessageCircle className="h-3 w-3" />
                                        WhatsApp
                                    </a>
                                )}
                            </div>
                        )}
                    </Fact>
                    <Fact label="Last action" sub={lastAction.sub}>
                        {lastAction.main}
                    </Fact>
                    <Fact label="Next visit" sub={nextVisit.sub} late={nextVisit.late}>
                        {nextVisit.main}
                    </Fact>
                    <Fact label="Quote" sub={quote.sub} warn={quote.warn}>
                        {quote.main}
                    </Fact>
                    <Fact label="Payment" sub={payment.sub}>
                        {payment.main}
                    </Fact>
                    <Fact label="Attempts">{attemptsWords(lead.visits_done ?? 0, lead.calls_made ?? 0)}</Fact>
                    <Fact label="AI score">{aiScoreWords(lead.final_intent_score)}</Fact>
                </dl>

                {handover?.remarks && (
                    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                        <div className="text-xs font-semibold text-gray-700">
                            Hand-over note{handover.performed_by_name ? ` from ${handover.performed_by_name}` : ""} ·{" "}
                            {istDateTimeWords(handover.performed_at)}
                        </div>
                        <p className="mt-1 text-sm text-gray-900 whitespace-pre-wrap">{handoverNoteInWords(handover.remarks)}</p>
                    </div>
                )}
            </div>

            {/* Conditional banners (BRD §0.5) */}
            <div className="pt-2 space-y-2">
                {!isOwner && !isUnassigned && (
                    <Banner tone="gray" icon={ShieldAlert}>
                        You are not the current owner — view only.
                    </Banner>
                )}
                {isEscalated && (
                    <Banner tone="amber" icon={AlertCircle}>
                        Escalated — pending admin review.
                    </Banner>
                )}
                {/* ID 83 "caller not linked": the lead has no owner because the
                    NeoDove agent who called it first is not linked to a CRM
                    user — it is waiting on that link, not on a rep. */}
                {isUnassigned && bundle.caller_not_linked && (
                    <Banner tone="amber" icon={AlertCircle}>
                        <span className="font-medium">Caller not linked:</span> NeoDove agent{" "}
                        <span className="font-medium">{bundle.caller_not_linked.agent_name ?? "(no name)"}</span> called first on{" "}
                        {formatDateTime(bundle.caller_not_linked.first_call_at)} but has no CRM login.{" "}
                        <InfoTip>Link the agent to a CRM user and the lead becomes theirs from that call&apos;s date.</InfoTip>{" "}
                        {NEODOVE_ADMIN_ROLES.includes(viewerRole ?? "") ? (
                            <Link
                                href="/leads/neodove-campaigns/agents"
                                className="font-semibold underline underline-offset-2 hover:text-amber-900"
                            >
                                NeoDove agents →
                            </Link>
                        ) : (
                            <span>Ask your Sales Head or Admin to link it.</span>
                        )}
                    </Banner>
                )}
                {wasReactivated && (
                    <Banner tone="sky" icon={RotateCcw}>
                        Reactivated from Lost{lead.previous_lost_reason ? ` (was ${lead.previous_lost_reason})` : ""}. Review prior history before calling.
                    </Banner>
                )}
            </div>
        </div>
    );
}

function Fact({
    label,
    sub,
    late,
    warn,
    children,
}: {
    label: string;
    sub?: string | null;
    late?: boolean;
    warn?: boolean;
    children: React.ReactNode;
}) {
    const tone = late ? "text-rose-700" : warn ? "text-amber-700" : "text-gray-900";
    return (
        <div className="min-w-0">
            <dt className="text-xs text-gray-500">{label}</dt>
            <dd className={`mt-0.5 text-sm font-semibold break-words ${tone}`}>{children}</dd>
            {sub && <dd className={`text-xs mt-0.5 ${late ? "text-rose-700 font-medium" : "text-gray-500"}`}>{sub}</dd>}
        </div>
    );
}

function Banner({
    children,
    icon: Icon,
    tone,
}: {
    children: React.ReactNode;
    icon: React.ComponentType<{ className?: string }>;
    tone: "gray" | "amber" | "sky" | "emerald";
}) {
    const tones: Record<string, string> = {
        gray: "border-gray-200 bg-gray-50 text-gray-700",
        amber: "border-amber-200 bg-amber-50 text-amber-800",
        sky: "border-sky-200 bg-sky-50 text-sky-800",
        emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    };
    return (
        <div className={`rounded-md border px-3 py-2 text-xs flex items-center gap-2 ${tones[tone]}`}>
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{children}</span>
        </div>
    );
}
