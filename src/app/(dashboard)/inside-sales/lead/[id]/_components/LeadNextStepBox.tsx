"use client";

// ID 246 — the "Next step" box under the lead page header: one line saying
// what to do now, by stage (nextStepFor, lib/leads/leadPage246.ts), with the
// matching buttons. The buttons are the page's EXISTING actions, shown only
// under their own rules (244_246 workflows): owner-only actions for the owner;
// Mark Won never on a Won lead; Continue onboarding only on a Won lead whose
// application is still a draft; Correct GSTIN only on a Won lead.

import Link from "next/link";
import { ArrowRight, Ban, CheckCircle2, MapPinned, MessageSquarePlus, CalendarClock } from "lucide-react";
import { hasApprovedQuote, type LeadDetailBundle } from "@/lib/inside-sales/types";
import { isOpen, type LeadStatus } from "@/lib/lifecycle/transitions";
import { pickPendingQuote } from "@/lib/leads/liveQuote";
import { lostReasonWords } from "@/lib/leads/lostReasons";
import { istDay, nextStepFor, type NextStepAction, type NextStepTone } from "@/lib/leads/leadPage246";
import { CallNowButton } from "@/components/leads/call-now-button";
import { CorrectLeadGstinButton } from "@/components/leads/CorrectLeadGstinButton";
import { GSTIN_CORRECTION_MANAGER_ROLES } from "@/lib/leads/correctLeadGstinRules";

/** Touchpoints whose remarks a person wrote about the dealer — the "Last note". */
const NOTE_TYPES = new Set(["visit", "inside_sales_call", "whatsapp", "ai_call"]);

type Props = {
    bundle: LeadDetailBundle;
    view: "asm" | "isr";
    isOwner: boolean;
    viewerRole: string;
    /** Opens one of the page's modals (the same ones the action bar opens). */
    onAction: (modal: "visit" | "touchpoint" | "mark_converted") => void;
    onChanged?: () => void;
    /** ASM page only: ID 77 Visit not needed (useVisitNotNeeded). */
    onVisitNotNeeded?: () => void;
    savingNotNeeded?: boolean;
};

const TONES: Record<NextStepTone, { box: string; label: string }> = {
    amber: { box: "border-amber-200 bg-amber-50/70", label: "text-amber-700" },
    rose: { box: "border-rose-200 bg-rose-50/70", label: "text-rose-700" },
    sky: { box: "border-sky-200 bg-sky-50/70", label: "text-sky-700" },
    emerald: { box: "border-emerald-200 bg-emerald-50/70", label: "text-emerald-700" },
    gray: { box: "border-gray-200 bg-gray-50", label: "text-gray-600" },
};

export function LeadNextStepBox({
    bundle,
    view,
    isOwner,
    viewerRole,
    onAction,
    onChanged,
    onVisitNotNeeded,
    savingNotNeeded,
}: Props) {
    const lead = bundle.lead;
    const status = lead.lead_status as LeadStatus | null;
    const open = status ? isOpen(status) : false;
    const ob = bundle.onboarding ?? null;
    const applicationId = lead.dealer_onboarding_application_id ?? null;
    const onboardingStatus = (lead.onboarding_status ?? ob?.onboarding_status ?? "draft").toLowerCase();
    const lastNote = bundle.touchpoints.find((t) => NOTE_TYPES.has(t.touchpoint_type) && t.remarks?.trim())?.remarks ?? null;

    const step = nextStepFor({
        view,
        status,
        todayIst: istDay(new Date()) ?? "",
        nextBookingDate: lead.next_booking_date ?? null,
        hasOpenBooking: Boolean(lead.has_open_booking),
        nextBookingOverdueDays: lead.next_booking_overdue_days ?? null,
        nextBookingBookedAt: lead.next_booking_booked_at ?? null,
        nextFollowUpAt: lead.next_follow_up_at,
        lastNote,
        onboarding: applicationId
            ? {
                  applicationId,
                  status: onboardingStatus,
                  createdAt: lead.onboarding_created_at,
                  agreementLabel:
                      ob?.agreement_outcome_label ??
                      (ob?.agreement_status ? ob.agreement_status.replace(/_/g, " ") : null),
                  approved: Boolean(ob?.approved_at),
                  stalled: Boolean(ob?.stalled),
              }
            : null,
        hasApprovedQuote: hasApprovedQuote(bundle.commercials_history),
        hasPendingQuote: pickPendingQuote(bundle.commercials_history) !== null,
        lostReasonWords: lead.lost_reason ? lostReasonWords(lead.lost_reason) : null,
    });

    // Each action under the rule it has on the action bar.
    const isWon = status === "Won";
    // Header rule (17 Nov): the form opens only while the application is a draft.
    const canContinueOnboarding =
        (status === "Won" || status === "Converted") && Boolean(applicationId) && onboardingStatus === "draft";
    const canCorrectGstin =
        isWon && (isOwner || (GSTIN_CORRECTION_MANAGER_ROLES as readonly string[]).includes(viewerRole));

    const buttons: React.ReactNode[] = [];
    step.actions.forEach((a: NextStepAction, i) => {
        const primary = buttons.length === 0;
        switch (a) {
            case "continue_onboarding":
                if (canContinueOnboarding)
                    buttons.push(
                        <Link
                            key={a}
                            href={`/dealer-onboarding?applicationId=${applicationId}`}
                            className={btnClass(primary)}
                        >
                            Continue onboarding
                            <ArrowRight className="h-3.5 w-3.5" />
                        </Link>,
                    );
                break;
            case "log_visit":
                if (isOwner && view === "asm")
                    buttons.push(
                        <button key={a} type="button" onClick={() => onAction("visit")} className={btnClass(primary)}>
                            <MapPinned className="h-3.5 w-3.5" />
                            Log visit
                        </button>,
                    );
                break;
            case "replan_visit":
                // The same Log visit form: Postponed / Scheduled are chosen there.
                if (isOwner && view === "asm")
                    buttons.push(
                        <button key={a} type="button" onClick={() => onAction("visit")} className={btnClass(primary)}>
                            <CalendarClock className="h-3.5 w-3.5" />
                            Re-plan visit
                        </button>,
                    );
                break;
            case "log_activity":
                if (isOwner)
                    buttons.push(
                        <button key={a} type="button" onClick={() => onAction("touchpoint")} className={btnClass(primary)}>
                            <MessageSquarePlus className="h-3.5 w-3.5" />
                            Log activity
                        </button>,
                    );
                break;
            case "mark_won":
                if (isOwner && open && !isWon)
                    buttons.push(
                        <button key={a} type="button" onClick={() => onAction("mark_converted")} className={btnClass(primary)}>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Mark Won
                        </button>,
                    );
                break;
            case "visit_not_needed":
                if (isOwner && view === "asm" && status === "Transferred_to_ASM" && onVisitNotNeeded)
                    buttons.push(
                        <button
                            key={a}
                            type="button"
                            onClick={onVisitNotNeeded}
                            disabled={savingNotNeeded}
                            className={btnClass(primary)}
                        >
                            <Ban className="h-3.5 w-3.5" />
                            Visit not needed
                        </button>,
                    );
                break;
            case "correct_gstin":
                if (canCorrectGstin)
                    buttons.push(
                        <CorrectLeadGstinButton key={a} leadId={lead.id} currentGstin={lead.gstin ?? null} onDone={onChanged} />,
                    );
                break;
            case "call_now":
                // ID 83: asks the NeoDove calling team to ring — never a tel: link.
                if (isOwner)
                    buttons.push(
                        <CallNowButton
                            key={`${a}-${i}`}
                            leadId={lead.id}
                            leadName={lead.shop_name || lead.dealer_name || "this lead"}
                            disabled={!open}
                            onQueued={onChanged}
                        />,
                    );
                break;
        }
    });

    const tone = TONES[step.tone];
    return (
        <div className="px-4 sm:px-6 pt-3">
            <div className={`rounded-xl border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-4 ${tone.box}`}>
                <div className="min-w-0 flex-1">
                    <div className={`text-[11px] font-bold uppercase tracking-wider ${tone.label}`}>Next step</div>
                    <div className="mt-0.5 text-base font-semibold text-gray-900">{step.title}</div>
                    {step.detail && <p className="mt-1 text-sm text-gray-700">{step.detail}</p>}
                    {step.also && <p className="mt-1 text-sm font-medium text-rose-700">{step.also}</p>}
                </div>
                {buttons.length > 0 && <div className="flex flex-wrap items-center gap-2">{buttons}</div>}
            </div>
        </div>
    );
}

function btnClass(primary: boolean): string {
    return `inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${
        primary ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-50"
    }`;
}
